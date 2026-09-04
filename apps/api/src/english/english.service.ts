import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ASR_CONFIDENCE_THRESHOLD } from '../ai/ai.types';
import { Clock } from '../common/clock/clock';
import { PrismaService } from '../prisma/prisma.service';
import {
  scoreEnglishAttempt,
  tokenizeForScoring,
  type EnglishScore,
  type EnglishScoreOutcome,
} from './english-scoring';
import {
  resolveCurrentVersion,
  selectNextSentence,
  type SentenceAttemptRecord,
} from './sentence-selection';
import type {
  EnglishNextResponse,
  EnglishSegmentKind,
  EnglishSentenceResponse,
} from './dto/english-sentence.dto';
import type { RecordEnglishAttemptInput } from './dto/record-english-attempt.dto';
import type { EnglishAttemptResult } from './dto/english-attempt-result.dto';
import type {
  EnglishKindProgress,
  EnglishProgressResponse,
  EnglishSentenceProgress,
  EnglishVocabTagProgress,
} from './dto/english-progress.dto';

// =============================================================================
// EnglishService (issue #136, epic #59 / E10 "Reading and writing tests")
// =============================================================================
//
// The reading and writing loop: be given a sentence, produce it, be scored
// word by word, and see where the words went. `docs/specs/english-test.md` is
// the contract; this file is only the part of it that touches the database.
//
// Three collaborators and no more: `PrismaService`, `Clock`, and two pure
// modules of this epic's own — `english-scoring.ts` (the WER scorer, already
// shipped and unmodified here) and `sentence-selection.ts` (which sentence
// comes next). Every decision worth testing lives in one of those two; what is
// left here is loading rows, one gate, and one write.
//
// -----------------------------------------------------------------------------
// EVERY METHOD TAKES A `userId` THAT CAME FROM `@CurrentUser('id')`
// -----------------------------------------------------------------------------
//
// And every query touching `english_attempts` is filtered by it — in the
// `where`, not checked afterwards. There is no method here that reads another
// learner's attempts and none that could be handed one, because the controller
// has no parameter that carries a user id.
//
// A sentence, by contrast, is SHARED CONTENT: `english_sentences` has no
// `userId` and every learner is served from the same bank, exactly as
// `civics_questions` is. So `recordAttempt` loads a sentence by id without an
// owner filter — there is no owner — and a sentence id is not a secret. What is
// private is the ATTEMPT, and no route accepts an attempt id at all: there is
// no read-one-attempt endpoint, no self-mark, and no update. The only way an
// attempt row is ever produced or read is through the caller's own id.
//
// -----------------------------------------------------------------------------
// NO SESSION, AND THAT IS THE DESIGN
// -----------------------------------------------------------------------------
//
// §5's own closing note: reading/writing practice is stateless per attempt, not
// a `practice_sessions` row. There is nothing to open, nothing to abandon, and
// nothing to complete — which is also why this service triggers no readiness
// recompute (§6.5: "no new schedule"; the nightly pass and the stale-on-read
// check already pick English evidence up) and no engagement accrual.
// =============================================================================

/** The `english_sentences` columns every read in this file needs. */
const SENTENCE_SELECT = {
  id: true,
  kind: true,
  version: true,
  ordinal: true,
  text: true,
  vocabTags: true,
} as const;

interface SentenceRow {
  id: string;
  kind: EnglishSegmentKind;
  version: string;
  ordinal: number;
  text: string;
  vocabTags: string[];
}

@Injectable()
export class EnglishService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  /**
   * The next sentence for this learner and kind, or `null` when the bank is
   * empty.
   *
   * Two queries and one pure function. The ordering rule itself is
   * `selectNextSentence` (`sentence-selection.ts`) — deliberately not inlined
   * here, so it is unit-tested over plain objects and there is exactly one
   * place that decides what "next" means.
   */
  async getNext(
    userId: string,
    kind: EnglishSegmentKind,
  ): Promise<EnglishNextResponse> {
    const [sentences, attempts] = await Promise.all([
      this.prisma.englishSentence.findMany({
        where: { kind },
        select: SENTENCE_SELECT,
        // A stable order out of the database, so the pure selector's own
        // tie-breaks are the only thing that decides — not the plan the query
        // planner happened to pick today.
        orderBy: [{ version: 'asc' }, { ordinal: 'asc' }],
      }),
      this.prisma.englishAttempt.findMany({
        // Filtered by BOTH, in the `where`: this learner, this kind. Scoping by
        // kind here rather than in the selector is what lets
        // `SentenceAttemptRecord` have no `kind` field to get wrong.
        where: { userId, kind },
        select: { sentenceId: true, outcome: true, answeredAt: true },
        orderBy: { answeredAt: 'asc' },
      }),
    ]);

    const history: SentenceAttemptRecord[] = attempts.map(
      (attempt: { sentenceId: string; outcome: string; answeredAt: Date }) => ({
        sentenceId: attempt.sentenceId,
        outcome: attempt.outcome as EnglishScoreOutcome,
        answeredAt: attempt.answeredAt,
      }),
    );

    const sentence = selectNextSentence(sentences as SentenceRow[], history);

    return { sentence: sentence === null ? null : toSentenceResponse(sentence) };
  }

  /**
   * Score one submission and, unless it was misheard, record it.
   *
   * -----------------------------------------------------------------------------
   * THE MISHEARD GATE (§3), STATED AS THE FOUR CONDITIONS IT ACTUALLY IS
   * -----------------------------------------------------------------------------
   *
   * A submission produces NO ROW AT ALL when all four hold:
   *
   *   1. the sentence is `reading` — a writing attempt has no recognition step
   *      to distrust, and §4's own closing paragraph says so outright;
   *   2. `asrConfidence` was reported — `null`/absent is UNKNOWN, and unknown
   *      is NOT low (`ASR_CONFIDENCE_THRESHOLD`'s own doc). A transcript from a
   *      model that reports no confidence is scored and recorded normally;
   *   3. it is STRICTLY BELOW `ASR_CONFIDENCE_THRESHOLD` — `0.6` exactly is
   *      trusted, because the boundary has to fall on one side and trusting the
   *      transcript is the side that cannot invent a mishearing that did not
   *      happen;
   *   4. the score is NOT `correct` — a low-confidence transcript that scored
   *      correct anyway is not in doubt: whatever the recogniser's misgivings,
   *      the words it produced were the sentence. Discarding that row would
   *      throw away a pass the learner earned.
   *
   * Compare `PracticeService.recordAttempt`, which under the same conditions
   * writes the row and annotates it `failure_cause: 'misheard'`. The divergence
   * is deliberate and §3 argues it in full: a civics attempt records what the
   * learner KNEW, so even a mistrusted transcript is evidence an attempt
   * happened; a reading attempt records whether they produced an exact sequence
   * of words, computed over the transcript itself, so a transcript we do not
   * believe is not weak evidence of a reading skill — it is none.
   */
  async recordAttempt(
    userId: string,
    input: RecordEnglishAttemptInput,
  ): Promise<EnglishAttemptResult> {
    const sentence = (await this.prisma.englishSentence.findUnique({
      where: { id: input.sentenceId },
      select: SENTENCE_SELECT,
    })) as SentenceRow | null;

    if (sentence === null) {
      throw new NotFoundException('Sentence not found');
    }

    // The two contradictions the DTO cannot catch, because only the sentence
    // row knows the kind. Both are rejected rather than silently dropped, the
    // same posture `record-attempt.dto.ts`'s own `superRefine` takes for the
    // voice fields: accepting a body whose fields make two incompatible claims
    // means writing a row that describes something that did not happen.
    if (sentence.kind !== 'reading' && input.asrConfidence !== undefined) {
      // A typed answer has no recogniser. A stray confidence here would not be
      // inert — it is the input to the misheard gate above, so a low value
      // would suppress a writing attempt's row entirely, attributing it to a
      // recognition step that never ran.
      throw new BadRequestException(
        'asrConfidence belongs to a reading attempt — a writing attempt is typed, so nothing was transcribed',
      );
    }

    if (sentence.kind !== 'writing' && input.replayCount > 0) {
      // A reading sentence is on the screen in front of the learner; there is
      // no dictated prompt to replay. `english_attempts.replay_count`'s own
      // column comment says "always 0 for a reading row", and this is what
      // makes that true structurally rather than by hope.
      throw new BadRequestException(
        'replayCount belongs to a writing attempt — a reading sentence is shown, not dictated',
      );
    }

    const score = scoreEnglishAttempt(sentence.text, input.responseText);

    if (isMisheardReading(sentence.kind, input.asrConfidence, score.outcome)) {
      // NO WRITE. Not an `incorrect` row, not a hedged row, not a row with a
      // flag — nothing. The learner gets the diff and the WER so the retry
      // screen can show what was heard, and only the retry produces evidence.
      return {
        status: 'misheard',
        ...scoreFields(sentence, input.responseText, score),
        asrConfidence: input.asrConfidence as number,
        confidenceThreshold: ASR_CONFIDENCE_THRESHOLD,
      };
    }

    const answeredAt = this.clock.now();

    const attempt = await this.prisma.englishAttempt.create({
      data: {
        userId,
        sentenceId: sentence.id,
        // From the SENTENCE, never from the request — see
        // `record-english-attempt.dto.ts`'s header on why `kind` is a
        // forbidden request field.
        kind: sentence.kind,
        responseText: input.responseText,
        // `null` for writing, and `null` for a reading attempt whose recogniser
        // reported nothing. NEVER `0` — that would be a confident-sounding lie
        // that also happens to sit below the threshold this column feeds.
        asrConfidence:
          sentence.kind === 'reading' ? (input.asrConfidence ?? null) : null,
        wer: score.wer,
        diffOps: score.diff as unknown as Prisma.InputJsonValue,
        outcome: score.outcome,
        replayCount: input.replayCount,
        // CLAUDE.md's "Using the Clock": injected, never `new Date()`, so a
        // test can pin the instant with `X-Test-Clock` instead of sleeping —
        // and so §6.1's rolling 30-day readiness window is computed against a
        // clock the test controls.
        answeredAt,
      },
      select: { id: true, answeredAt: true, asrConfidence: true, replayCount: true },
    });

    return {
      status: 'scored',
      ...scoreFields(sentence, input.responseText, score),
      attemptId: attempt.id,
      outcome: score.outcome,
      answeredAt: attempt.answeredAt.toISOString(),
      asrConfidence: attempt.asrConfidence ?? null,
      replayCount: attempt.replayCount,
    };
  }

  /**
   * The caller's own progress, at three grains.
   *
   * Two queries, then one pure aggregation ({@link summarizeEnglishProgress}) —
   * the same division of labour `computeSummary` takes in `practice.service.ts`:
   * the rows are the evidence, the rollup is arithmetic over them, and the
   * arithmetic is testable without a database.
   */
  async getProgress(userId: string): Promise<EnglishProgressResponse> {
    const [sentences, attempts] = await Promise.all([
      this.prisma.englishSentence.findMany({
        select: SENTENCE_SELECT,
        orderBy: [{ kind: 'asc' }, { version: 'asc' }, { ordinal: 'asc' }],
      }),
      this.prisma.englishAttempt.findMany({
        where: { userId },
        select: {
          sentenceId: true,
          kind: true,
          outcome: true,
          wer: true,
          answeredAt: true,
        },
        orderBy: { answeredAt: 'asc' },
      }),
    ]);

    return summarizeEnglishProgress(
      sentences as SentenceRow[],
      attempts as ProgressAttemptRow[],
    );
  }
}

/**
 * The four conditions of §3's misheard gate, as one predicate.
 *
 * Exported for its own test: this is the rule the whole section turns on, and
 * "a `null` confidence is scored normally" is the half of it that would fail
 * silently — a learner on a model that reports no confidence would simply stop
 * accumulating evidence, with nothing to say why.
 */
export function isMisheardReading(
  kind: EnglishSegmentKind,
  asrConfidence: number | null | undefined,
  outcome: EnglishScoreOutcome,
): boolean {
  if (kind !== 'reading') return false;
  // Absent and `null` are the same statement — "the recogniser reported none" —
  // and neither is low. This is the one comparison in the file that must never
  // be written as `(asrConfidence ?? 0) < THRESHOLD`.
  if (asrConfidence === undefined || asrConfidence === null) return false;
  if (asrConfidence >= ASR_CONFIDENCE_THRESHOLD) return false;
  return outcome !== 'correct';
}

/** The response fields both attempt variants share. */
function scoreFields(
  sentence: SentenceRow,
  responseText: string,
  score: EnglishScore,
) {
  return {
    sentenceId: sentence.id,
    kind: sentence.kind,
    // On a writing attempt this is the REVEAL — the first time the learner sees
    // the sentence they were dictated (§4).
    text: sentence.text,
    responseText,
    wer: score.wer,
    errors: score.errors,
    substitutions: score.substitutions,
    deletions: score.deletions,
    insertions: score.insertions,
    referenceTokenCount: score.referenceTokenCount,
    diff: score.diff,
    normalizedReference: score.normalizedReference,
    normalizedHypothesis: score.normalizedHypothesis,
  };
}

function toSentenceResponse(sentence: SentenceRow): EnglishSentenceResponse {
  return {
    id: sentence.id,
    kind: sentence.kind,
    version: sentence.version,
    ordinal: sentence.ordinal,
    text: sentence.text,
    vocabTags: sentence.vocabTags,
    // The SCORER's own token count, not `split(' ')` — see the DTO's field doc.
    wordCount: tokenizeForScoring(sentence.text).length,
  };
}

/** One `english_attempts` row, as the progress rollup reads it. */
export interface ProgressAttemptRow {
  sentenceId: string;
  kind: EnglishSegmentKind;
  outcome: EnglishScoreOutcome;
  wer: number;
  answeredAt: Date;
}

const KINDS: readonly EnglishSegmentKind[] = ['reading', 'writing'];

/** `correct` beats `partial` beats `incorrect`. Higher is better. */
const OUTCOME_RANK: Record<EnglishScoreOutcome, number> = {
  incorrect: 0,
  partial: 1,
  correct: 2,
};

/**
 * The whole progress response, as a pure function of the rows.
 *
 * No clock, no database, no client input — so the one thing that could make a
 * progress screen wrong is the rows being wrong, and the rows are the evidence
 * table itself. The same property `computeSummary` has one module over.
 *
 * The current bank is resolved PER KIND through `resolveCurrentVersion`, the
 * same function `GET /api/english/next` uses, so the two can never disagree
 * about which sentences exist — see `english-progress.dto.ts`'s header.
 */
export function summarizeEnglishProgress(
  sentences: readonly SentenceRow[],
  attempts: readonly ProgressAttemptRow[],
): EnglishProgressResponse {
  const currentVersionByKind = new Map<EnglishSegmentKind, string | null>();
  for (const kind of KINDS) {
    currentVersionByKind.set(
      kind,
      resolveCurrentVersion(sentences.filter((s) => s.kind === kind)),
    );
  }

  const bank = sentences
    .filter((s) => s.version === currentVersionByKind.get(s.kind))
    .slice()
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.ordinal - b.ordinal);

  const inBank = new Set(bank.map((s) => s.id));

  // Attempts against a SUPERSEDED sentence are dropped here, and only here.
  // They are not deleted and they still count as evidence in their own rows —
  // they simply describe a sentence nobody is offered any more, so counting
  // them against a bank that no longer contains it would make
  // `sentencesAttempted` exceed `sentencesTotal`.
  const relevant = attempts.filter((a) => inBank.has(a.sentenceId));

  const bySentence = new Map<
    string,
    { attempts: number; best: EnglishScoreOutcome | null; last: ProgressAttemptRow | null }
  >();

  for (const sentence of bank) {
    bySentence.set(sentence.id, { attempts: 0, best: null, last: null });
  }

  for (const attempt of relevant) {
    const entry = bySentence.get(attempt.sentenceId);
    /* istanbul ignore next — `relevant` is filtered to `inBank` above. */
    if (entry === undefined) continue;

    entry.attempts += 1;
    if (
      entry.best === null ||
      OUTCOME_RANK[attempt.outcome] > OUTCOME_RANK[entry.best]
    ) {
      entry.best = attempt.outcome;
    }
    // The rows arrive `answeredAt` ascending, so the last one seen is the most
    // recent; the comparison is written out anyway so a caller that passed them
    // in another order still gets the right answer rather than a silently wrong
    // one.
    if (
      entry.last === null ||
      attempt.answeredAt.getTime() >= entry.last.answeredAt.getTime()
    ) {
      entry.last = attempt;
    }
  }

  const sentenceProgress: EnglishSentenceProgress[] = bank.map((sentence) => {
    const entry = bySentence.get(sentence.id)!;
    return {
      sentenceId: sentence.id,
      kind: sentence.kind,
      text: sentence.text,
      ordinal: sentence.ordinal,
      vocabTags: sentence.vocabTags,
      attempts: entry.attempts,
      bestOutcome: entry.best,
      lastOutcome: entry.last?.outcome ?? null,
      lastWer: entry.last?.wer ?? null,
      lastAnsweredAt: entry.last?.answeredAt.toISOString() ?? null,
    };
  });

  // ---------------------------------------------------------------------------
  // Per tag
  // ---------------------------------------------------------------------------
  //
  // A sentence contributes to EVERY tag it carries, so the per-tag totals sum
  // to more than the bank size. That is correct and not double counting: the
  // question each row answers is "of the sentences that exercise this
  // vocabulary category, how many has this learner got right", and a sentence
  // drawing on both PEOPLE and CIVICS genuinely exercises both.

  const tags = new Map<
    string,
    { sentencesTotal: number; sentencesAttempted: number; sentencesPassed: number; attempts: number }
  >();

  for (const sentence of sentenceProgress) {
    for (const tag of sentence.vocabTags) {
      const entry = tags.get(tag) ?? {
        sentencesTotal: 0,
        sentencesAttempted: 0,
        sentencesPassed: 0,
        attempts: 0,
      };
      entry.sentencesTotal += 1;
      if (sentence.attempts > 0) entry.sentencesAttempted += 1;
      if (sentence.bestOutcome === 'correct') entry.sentencesPassed += 1;
      entry.attempts += sentence.attempts;
      tags.set(tag, entry);
    }
  }

  const vocabTags: EnglishVocabTagProgress[] = [...tags.entries()]
    .map(([tag, entry]) => ({ tag, ...entry }))
    .sort((a, b) => a.tag.localeCompare(b.tag));

  // ---------------------------------------------------------------------------
  // Per kind
  // ---------------------------------------------------------------------------

  const byKind: EnglishKindProgress[] = KINDS.map((kind) => {
    const own = sentenceProgress.filter((s) => s.kind === kind);
    const ownAttempts = relevant.filter((a) => a.kind === kind);

    return {
      kind,
      sentencesTotal: own.length,
      sentencesAttempted: own.filter((s) => s.attempts > 0).length,
      sentencesPassed: own.filter((s) => s.bestOutcome === 'correct').length,
      attempts: ownAttempts.length,
      // `null`, never `0` — see the DTO's field doc: a mean of zero is a
      // perfect record, the exact opposite of no record.
      averageWer:
        ownAttempts.length === 0
          ? null
          : ownAttempts.reduce((sum, a) => sum + a.wer, 0) / ownAttempts.length,
      version: currentVersionByKind.get(kind) ?? null,
    };
  });

  return { sentences: sentenceProgress, vocabTags, byKind };
}
