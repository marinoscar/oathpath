import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ASR_CONFIDENCE_THRESHOLD } from '../ai/ai.types';
import { type DynamicScope } from '../civics/answer-resolution';
import { Clock } from '../common/clock/clock';
import { PrismaService } from '../prisma/prisma.service';
import { EngagementService } from '../engagement/engagement.service';
import { ReadinessService } from '../readiness/readiness.service';
import { AttemptGradingService } from './attempt-grading.service';
import { excludeUnanswerable } from './question-selection';
import { type GradingVerdict } from './grading';
import { toAttemptOutcome } from './mastery/outcome-mapping';
import {
  classifyMasteryBucket,
  selectQuestionsV2,
  type QuestionMasterySnapshot,
} from './mastery/selector';
import type { CreatePracticeSessionInput } from './dto/create-practice-session.dto';
import type { RecordAttemptInput } from './dto/record-attempt.dto';
import type { PracticeSessionQuery } from './dto/practice-session-query.dto';
import type { PracticeQuestion } from './dto/practice-question.dto';
import type { PracticeQueueResponse } from './dto/practice-queue.dto';
import type {
  PracticeAnswerSnapshot,
  PracticeAttemptResponse,
} from './dto/practice-attempt.dto';
import type {
  PracticeAttemptResult,
  PracticeSessionDetail,
  PracticeSessionListItem,
  PracticeSessionResponse,
  PracticeSessionState,
  PracticeSessionSummary,
} from './dto/practice-session.dto';

// =============================================================================
// PracticeService (issue #73, epic #52 / E3)
// =============================================================================
//
// The practice loop: open a session, be asked a question, answer it, be graded
// deterministically, and see a summary. Every attempt writes one row into
// `practice_attempts` — the table epic #52 calls "the single evidence table for
// the whole product", which E5 (mastery), E6 (readiness) and E7 (streaks) all
// read and E8 writes into with `source: 'mock_interview'`.
//
// -----------------------------------------------------------------------------
// EVERY METHOD TAKES A `userId` THAT CAME FROM `@CurrentUser('id')`
// -----------------------------------------------------------------------------
//
// And every query in this file is filtered by it — not "checked against it
// afterwards", filtered by it, in the `where`. There is no method here that
// reads another learner's session, and none that could be handed one, because
// the controller has no parameter that carries a user id.
//
// **A session belonging to somebody else is a 404, not a 403.** That is a
// deliberate choice, not an accident of using `findFirst`: a 403 confirms the
// id names a real session, which is itself the leak — an attacker enumerating
// uuids learns which ones exist, and a learner who was shown a 403 learns that
// another learner's practice history is there to be asked about. From the
// caller's position the resource genuinely does not exist, and that is what the
// status code should say. `requireSession` is the ONE place a session is loaded
// for any route, so this holds by construction rather than by six correct
// copies of the same check.
//
// -----------------------------------------------------------------------------
// THIS FILE CONSTRUCTS NO `Date` OF ITS OWN
// -----------------------------------------------------------------------------
//
// Every instant — `startedAt`, `completedAt`, `answeredAt`, and the
// `resolvedAt` frozen into every answer snapshot — comes from
// `this.clock.now()`. Grep this module's non-test sources for a bare `Date`
// construction and the result is empty, comments included, exactly as
// `src/journey/` and `src/civics/` already hold.
//
// That is not house style for its own sake here. E5's "correct on 3 or more
// distinct days" rule and E7's streak computation both read `answeredAt` to
// decide which of the learner's local calendar days an attempt falls on, and
// both need a spec that can advance the clock a day through `X-Test-Clock`
// rather than sleeping through one (practice-sessions.md §11).
//
// -----------------------------------------------------------------------------
// THE GRADING LADDER LIVES IN `attempt-grading.service.ts`, NOT HERE
// -----------------------------------------------------------------------------
//
// The three-rung ladder (docs/specs/ai-evaluation.md §6) — deterministic match,
// grader escalation on a miss, and "keep rung 1's verdict" for every way that
// call can fail — used to be four private methods on this class. Issue #133
// (epic #57 / E8) moved them, unchanged, into `AttemptGradingService`, because
// `mock-interview.md` §6 requires that a civics answer given in a mock
// interview is graded by the EXACT same ladder a practice answer is, "reached
// through one shared injectable so there is only one ladder in the codebase".
// That file's header carries the full argument for each rung; `recordAttempt`
// below calls into it and does not re-implement any of it.
//
// -----------------------------------------------------------------------------
// THIS MODULE TOUCHES NO KEY, NO CREDENTIAL, AND NO DISPATCHER
// -----------------------------------------------------------------------------
//
// It holds no `AiDispatchService` at all any more — no provider, no model id, no
// `CredentialsService`, no API key in any form. The one door to a model is
// `AttemptGradingService`'s, one layer down, and everything `ai-evaluation.md`
// §3 says about it (a caller cannot name its own model; a per-answer grading
// call can never be bound to the expensive model an admin configured for
// something else) is enforced there.
//
// -----------------------------------------------------------------------------
// NO AUDIT ROWS
// -----------------------------------------------------------------------------
//
// Unlike an admin settings write or a role change, answering a civics question
// is routine product usage — not a privileged or security-relevant act. Same
// reasoning that keeps `ai_usage_events` out of `audit_events` entirely
// (docs/specs/ai-settings.md §9, practice-sessions.md §10): the evidence is
// recorded because a later reader needs the data, not because anyone needs to
// explain who was allowed to produce it. `practice_attempts` IS the record.
// =============================================================================

/** The question columns practice ever reads. Answers are conspicuously absent. */
const QUESTION_SELECT = {
  id: true,
  number: true,
  prompt: true,
  categoryId: true,
  testVersionCode: true,
  dynamicScope: true,
} as const;

/** One question as read for selection and display. */
type QuestionRow = {
  id: string;
  number: number;
  prompt: string;
  categoryId: string;
  testVersionCode: string;
  // The narrowed union, not `string`: `question-selection.ts` reads this field
  // to decide whether a question is answerable at all, and a widened type here
  // would let a typo reach that decision as a silently-always-answerable value.
  dynamicScope: DynamicScope;
};

/** The three learner-profile facts selection and grading depend on. */
interface PracticeProfile {
  stateCode: string | null;
  testVersionCode: string | null;
  seniorExemption: boolean;
}

@Injectable()
export class PracticeService {
  private readonly logger = new Logger(PracticeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    // THE ONE LADDER (issue #133, epic #57 / E8). The four grading operations
    // this service used to own privately — answer resolution, the deterministic
    // rung, the grader escalation, and the mastery write — now live in
    // `attempt-grading.service.ts`, so a mock-interview answer is graded by the
    // same code a practice answer is (`mock-interview.md` §6). This service
    // holds NO `AiDispatchService` of its own any more; that door is one layer
    // down, behind this one.
    private readonly grading: AttemptGradingService,
    // Readiness recompute trigger (a) — `docs/specs/readiness-model.md`
    // §7(a). Called synchronously from `completeSession`, after its own
    // write commits; see that method's own comment.
    private readonly readiness: ReadinessService,
    // Accrual trigger — `docs/specs/habit-streaks.md` §2.1. Called from
    // `recordAttempt` and `completeSession`, after each one's own write
    // commits, and never allowed to fail either; see {@link accrueActivity}.
    private readonly engagement: EngagementService,
  ) {}

  // ---------------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------------

  /**
   * Open a session and hand back its first question.
   *
   * Three things happen here, in this order and for stated reasons:
   *
   *  1. **Any open session is closed.** practice-sessions.md §5 makes at most
   *     one `in_progress` session per learner an invariant, and a NEW session
   *     start is the one moment "the old one was not going to be finished"
   *     becomes knowable — which is why there is no cron sweeping stale rows
   *     (ROADMAP §7's "No job queue"). The old row becomes `abandoned` with a
   *     `completedAt`, keeping every attempt it already produced: an abandoned
   *     session's answers are real evidence regardless of why the learner left.
   *
   *     **This is an application-level invariant, not a database one.** §2.1
   *     records the gap plainly: the shipped migration has no partial unique
   *     index on `status = 'in_progress'`, so two concurrent starts by the same
   *     learner (two tabs, a double-tap) could each pass through here and both
   *     create a row. The consequence is small and self-healing — the loser
   *     stays `in_progress` and the next session start closes it — and §13
   *     accepts it rather than adding an index for it. The transaction below
   *     makes the close-and-open atomic, which is a different guarantee: it
   *     stops a session being abandoned by a start that then failed.
   *
   *  2. **The question pool is resolved from the learner's own profile**, never
   *     from the request: their test version, their state, their senior
   *     exemption. See {@link candidateQuestions}.
   *
   *  3. **`plannedCount` is clamped to what actually exists.** A category with
   *     three unseen questions cannot plan five. `plannedCount` is what the
   *     summary renders "4 of 5" from, so a count the bank could never supply
   *     would render an unfinishable session as one the learner failed to
   *     finish.
   */
  async createSession(
    userId: string,
    input: CreatePracticeSessionInput,
  ): Promise<PracticeSessionState> {
    const profile = await this.requireOrientedProfile(userId);
    const testVersionCode = profile.testVersionCode as string;

    // A category id is validated against the learner's OWN bank. A real
    // category belonging to the other test version is a 404 and not a 403 for
    // the same reason another learner's session is: from where this caller
    // stands, it is not a thing that exists to be practised.
    if (input.kind === 'category' && input.categoryId) {
      const category = await this.prisma.civicsCategory.findFirst({
        where: { id: input.categoryId, testVersionCode },
        select: { id: true },
      });

      if (!category) {
        throw new NotFoundException(
          `Civics category "${input.categoryId}" not found in test version "${testVersionCode}"`,
        );
      }
    }

    const categoryId = input.kind === 'category' ? (input.categoryId ?? null) : null;

    const ordered = await this.candidateQuestions(
      { testVersionCode, categoryId },
      profile,
      userId,
    );

    if (ordered.length === 0) {
      // Well-formed request, forbidden by the state of the content: 409.
      // Distinguishable from the 400 an invalid body gets, so a client can tell
      // "you asked wrongly" from "there is nothing here to ask you".
      throw new ConflictException(
        'There are no questions available to practise for this selection',
      );
    }

    const plannedCount = Math.min(input.plannedCount, ordered.length);
    const startedAt = this.clock.now();

    const session = await this.prisma.$transaction(async (tx) => {
      await tx.practiceSession.updateMany({
        where: { userId, status: 'in_progress' },
        data: { status: 'abandoned', completedAt: startedAt },
      });

      return tx.practiceSession.create({
        data: {
          userId,
          kind: input.kind,
          status: 'in_progress',
          testVersionCode,
          categoryId,
          plannedCount,
          // Set explicitly from the injected clock rather than left to the
          // column's `DEFAULT now()`. §2.1: the default is a safety net for a
          // row inserted by something other than this service, not the path
          // this service takes — and a row whose `startedAt` ignored
          // `X-Test-Clock` would make a multi-day spec untestable.
          startedAt,
        },
      });
    });

    this.logger.log(
      { userId, sessionId: session.id, kind: session.kind, plannedCount },
      'Practice session started',
    );

    return {
      session: toSessionResponse(session),
      nextQuestion: toQuestion(ordered[0]),
      progress: { answered: 0, planned: session.plannedCount },
    };
  }

  /**
   * The caller's own sessions, newest first.
   *
   * Ordered by `startedAt` desc, which is exactly what the shipped
   * `@@index([userId, startedAt])` serves (§2.1) — the reason that index is the
   * whole index list for this table.
   *
   * The per-session counts come from the attempt rows loaded alongside the
   * page, not from a second query per row and not from the stored `summary`.
   * A `summary` exists only on a `completed` session, and an `in_progress` or
   * `abandoned` one still has real attempts behind it: a learner who answered
   * three of five and walked away should see three, not a blank row. One
   * `include` over a bounded page (at most 100 sessions) is cheaper than the
   * N+1 the alternative implies, and cannot drift from the rows the way a
   * denormalised counter could.
   */
  async listSessions(
    userId: string,
    query: PracticeSessionQuery,
  ): Promise<{
    items: PracticeSessionListItem[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }> {
    const { page, pageSize } = query;

    const [rows, total] = await Promise.all([
      this.prisma.practiceSession.findMany({
        where: { userId },
        orderBy: { startedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { attempts: { select: { outcome: true } } },
      }),
      this.prisma.practiceSession.count({ where: { userId } }),
    ]);

    return {
      items: rows.map((row: any) => ({
        ...toSessionResponse(row),
        answeredCount: row.attempts.length,
        correctCount: row.attempts.filter(
          (attempt: { outcome: string }) => attempt.outcome === 'correct',
        ).length,
      })),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  /**
   * One session: resume it, or review it.
   *
   * The same payload serves both, because they are the same facts — what was
   * planned, what has been answered, and what is left — and a second endpoint
   * for "review" would be the identical query with the last field forced to
   * null.
   *
   * `nextQuestion` is populated only while the session is `in_progress` and
   * only while fewer attempts exist than were planned. A completed or abandoned
   * session returns null: it is history, and handing back a question would
   * invite a client to POST an attempt the session no longer accepts.
   *
   * The recorded attempts carry their frozen `answerSnapshot`, which is where
   * the accepted answers legitimately appear — they were earned when the
   * attempt was graded. The next question does not, and cannot: it is the
   * prompt-only shape (`dto/practice-question.dto.ts`).
   */
  async getSession(
    userId: string,
    sessionId: string,
  ): Promise<PracticeSessionDetail> {
    const session = await this.requireSession(userId, sessionId);

    const attempts = await this.prisma.practiceAttempt.findMany({
      where: { sessionId: session.id, userId },
      // Oldest first: the order the learner answered them in, which is the
      // order a review screen replays. `id` breaks the tie for two attempts
      // sharing an instant, which a pinned `X-Test-Clock` makes routine in
      // tests and possible in production.
      orderBy: [{ answeredAt: 'asc' }, { id: 'asc' }],
      include: { question: { select: QUESTION_SELECT } },
    });

    const answeredQuestionIds = new Set<string>(
      attempts.map((attempt: { questionId: string }) => attempt.questionId),
    );

    // Superseded attempts are RETURNED in `attempts` below — the retry link is
    // what a review screen renders the "this was misheard, here is what you
    // answered next" pair from, and the row is real evidence either way — but
    // they are not COUNTED. Same helper, same rule, as the stored summary and
    // as `recordAttempt`'s own progress.
    //
    // `nextQuestionFor` is handed this SAME number rather than `attempts.length`,
    // and that is not tidiness: it compares against `plannedCount` to decide
    // whether the session is finished, so counting a superseded row would end a
    // Quick 5 after four answered questions the first time one of them was
    // misheard and corrected.
    const answered = dropSuperseded(attempts).length;

    const nextQuestion = await this.nextQuestionFor(
      session,
      userId,
      answered,
      answeredQuestionIds,
    );

    return {
      session: toSessionResponse(session),
      attempts: attempts.map((attempt: any) => toAttemptResponse(attempt)),
      nextQuestion,
      progress: { answered, planned: session.plannedCount },
    };
  }

  /**
   * Compute and persist the session's summary, and close it.
   *
   * **The counts come from the persisted attempts and from nothing else.** Not
   * from a tally the client kept, not from a running counter on the session
   * row. The client that just answered five questions knows what it thinks
   * happened; the rows know what was recorded. Those can differ — a failed
   * request, a second tab, an attempt graded differently than a client
   * predicted — and when they do, the evidence table is right by definition,
   * because it is the same table E5 and E6 will read. A summary computed from
   * anything else would be a second, quietly divergent account of the session.
   *
   * **Idempotent.** Completing an already-`completed` session returns the
   * stored summary unchanged and does NOT re-stamp `completedAt` — the moment a
   * learner finished has to stay the moment they finished, and a double-tap on
   * "finish" must not move it. This is the same guard shape
   * `JourneyService.updateProfile` uses for `orientationCompletedAt`.
   *
   * An `abandoned` session is a 409: the request is well-formed, but that
   * session was closed by a later session start and there is no completion to
   * record. practice-sessions.md §10 specifies exactly that status for a
   * session that is not `in_progress`; `completed` is carved out of it above
   * because idempotency is worth more than a strict reading of the state
   * machine to every client that retries.
   */
  async completeSession(
    userId: string,
    sessionId: string,
  ): Promise<PracticeSessionResponse> {
    const session = await this.requireSession(userId, sessionId);

    if (session.status === 'completed') {
      return toSessionResponse(session);
    }

    if (session.status !== 'in_progress') {
      throw new ConflictException(
        `Session "${sessionId}" is ${session.status} and cannot be completed`,
      );
    }

    const attempts = await this.prisma.practiceAttempt.findMany({
      where: { sessionId: session.id, userId },
      select: {
        // `id` and `retryOfAttemptId` are selected for `computeSummary`'s own
        // supersession filter, not for the summary's fields — see
        // `dropSuperseded`. Selecting them here rather than filtering in SQL
        // keeps the rule in ONE pure function that `getSession` and
        // `recordAttempt` also call, instead of in three `where` clauses that
        // can drift apart.
        id: true,
        retryOfAttemptId: true,
        outcome: true,
        gradingMethod: true,
        revealed: true,
        hintUsed: true,
        durationMs: true,
      },
    });

    const summary = computeSummary(attempts, session.plannedCount);

    // Hoisted so accrual can measure the SAME instant this row records as the
    // completion, rather than a second, slightly later clock read
    // (habit-streaks.md §2.3: `now` is "the completion timestamp").
    const completedAt = this.clock.now();

    const completed = await this.prisma.practiceSession.update({
      where: { id: session.id },
      data: {
        status: 'completed',
        completedAt,
        summary: summary as unknown as Prisma.InputJsonValue,
      },
    });

    this.logger.log(
      {
        userId,
        sessionId: session.id,
        answered: summary.answered,
        correct: summary.correct,
      },
      'Practice session completed',
    );

    // READINESS RECOMPUTE TRIGGER (A) (issue #122, epic #55 / E6),
    // synchronous, in-request, AFTER the completion write above has
    // committed — never inside its transaction and never fire-and-forget.
    // `docs/specs/readiness-model.md` §7(a) quotes `ROADMAP.md` §7 verbatim:
    // "No job queue. Scheduling (E5) and readiness recompute (E6) run
    // synchronously, inside the request... that produces the evidence."
    // Awaited before the response returns, so a client reloading
    // `GET /api/readiness` right after this response sees the session it
    // just completed already reflected — not merely eventually.
    await this.readiness.recomputeSnapshot(userId);

    // ACCRUAL EVENT (B) (issue #119, epic #56 / E7), after the completion
    // write above has committed and outside any transaction — the same
    // placement as the readiness call, for the same reason (habit-streaks.md
    // §2.1). It closes the one gap no attempt event ever closes: the seconds
    // between the last attempt (or, for a session completed with zero
    // attempts, the session's own `startedAt`) and the moment the learner
    // actually finished. `attempts`/`correct` are untouched by it — nothing
    // was answered at completion itself.
    await this.accrueActivity(userId, session.id, () =>
      this.engagement.recordSessionCompletionActivity(userId, {
        sessionId: session.id,
        completedAt,
      }),
    );

    return toSessionResponse(completed);
  }

  // ---------------------------------------------------------------------------
  // Attempts
  // ---------------------------------------------------------------------------

  /**
   * Grade one response and record it.
   *
   * The grading path is practice-sessions.md §7 and, since #116,
   * ai-evaluation.md §6's second rung on top of it: resolve the question's
   * currently accepted answers through `civics/answer-resolution.ts` — the same
   * pure functions the civics read API uses, never a second derivation of
   * "which answers are current" — hand them to `matchAnswer`, and escalate a
   * MISS (and only a miss) to the semantic grader. No edit distance and no
   * similarity score is added to the deterministic rung to do it: a near miss
   * is still `incorrect` there, and it is the grader, holding the question and
   * the accepted answers, that is entitled to overturn that with reasoning.
   *
   * `source: 'practice'` is still written with one value each time — E8 writes
   * `mock_interview` into this same table — and is still a fact that cannot be
   * reconstructed later if it is not captured now (§2.2).
   *
   * `inputMode` and `promptMode` USED to be that way too, hardcoded to
   * `'typed'`/`'read'` with a note that E9 would wire spoken and heard. E9
   * (issue #104, epic #58) is that wiring: both now come from the request, and
   * the DTO's defaults are what keep every pre-E9 client writing exactly the
   * row it always wrote. Three more columns join them — `transcript`,
   * `asrConfidence` and `retryOfAttemptId` — for the same
   * cannot-be-reconstructed-later reason, sharpened: the recording itself is
   * transcribed and discarded at the point of capture (`voice.md` §4), so
   * there is no artefact anywhere from which a later reader could recover how
   * an answer was given or how well it was heard.
   *
   * `gradingMethod` is the column that stopped having one value: `'ai'` when
   * the grader ran and answered, `'exact'` for every other attempt — including
   * one whose grading call was unavailable or failed. Rung 3 writes `'exact'`
   * rather than an "attempted-and-failed" value (§6) because it is the truth
   * about the row: the deterministic matcher is what decided this outcome.
   *
   * **`gradingMethod: 'exact'` on a skip deserves its own sentence**, because
   * §9.1's prose says a skip has `gradingMethod: null` and the shipped column
   * is `NOT NULL` — the schema resolves it, and this is where. `exact` records
   * that the deterministic path is what resolved this attempt; `outcome:
   * 'skipped'` is the field that says no response was graded. The two read
   * together give the same fact §9.1 wanted from a null, and unlike a null they
   * cannot be mistaken for "we do not know how this was graded" by a reader
   * that only looks at one column.
   */
  async recordAttempt(
    userId: string,
    sessionId: string,
    input: RecordAttemptInput,
  ): Promise<PracticeAttemptResult> {
    const session = await this.requireSession(userId, sessionId);

    if (session.status !== 'in_progress') {
      throw new ConflictException(
        `Session "${sessionId}" is ${session.status} and accepts no further attempts`,
      );
    }

    const question = await this.prisma.civicsQuestion.findUnique({
      where: { id: input.questionId },
      select: QUESTION_SELECT,
    });

    if (!question) {
      throw new NotFoundException(
        `Civics question "${input.questionId}" not found`,
      );
    }

    // The session's own scope, enforced. An attempt at a question this session
    // was never drawing from would be evidence filed under a session that
    // cannot explain it — a category session whose summary counts a question
    // from another section, or a session whose `testVersionCode` disagrees with
    // the bank its attempts came from.
    if (question.testVersionCode !== session.testVersionCode) {
      throw new BadRequestException(
        `Question "${question.id}" does not belong to this session's test version`,
      );
    }

    if (session.categoryId && question.categoryId !== session.categoryId) {
      throw new BadRequestException(
        `Question "${question.id}" does not belong to this session's category`,
      );
    }

    // -------------------------------------------------------------------------
    // ONE ATTEMPT PER QUESTION PER SESSION — PLUS ONE TRACEABLE CORRECTION
    // -------------------------------------------------------------------------
    //
    // The original rule and its reason are unchanged: a second attempt would
    // double-count the question in `progress` and in the summary, and would
    // let a learner grind the same question five times and call it a Quick 5.
    // Answering it again is a new session, which is how the product intends
    // repetition to work.
    //
    // E9 (issue #104, epic #58) adds exactly one exception — the retry a
    // learner is offered when the recogniser may have misheard them
    // (`docs/specs/voice.md` §3.3). This is the risky edit in that change, so
    // the reason it is safe is written out rather than assumed: the guard
    // does not become "a retry is allowed", it becomes "a retry of THIS
    // attempt is allowed", and `requireRetryTarget` below is four conditions
    // that must ALL hold. Every one of them removes a way the exception could
    // have become a loophole:
    //
    //   1. the named attempt exists and belongs to THIS caller — so a retry
    //      cannot reach across learners;
    //   2. it belongs to THIS session and THIS question — so a retry cannot
    //      launder an attempt from elsewhere into this session's counts;
    //   3. it is not itself a retry — so the chain cannot grow past two;
    //   4. nothing already supersedes it — so a row can be corrected once.
    //
    // (3) and (4) together are what keep the degradation at "one attempt,
    // plus one traceable correction of it" instead of "unlimited attempts
    // with a linked list to show for it". Without them a caller could walk
    // A → B → C → D indefinitely, each hop individually well-formed, and the
    // grinding loophole the original guard closed would be open again with
    // better bookkeeping.
    //
    // A body with NO `retryOfAttemptId` takes the untouched original path.
    // That is deliberate: the pre-E9 behaviour is not re-expressed in terms
    // of the new one, so nothing about it can drift.
    if (input.retryOfAttemptId) {
      await this.requireRetryTarget(
        userId,
        session.id,
        question.id,
        input.retryOfAttemptId,
      );
    } else {
      const existing = await this.prisma.practiceAttempt.findFirst({
        where: { sessionId: session.id, userId, questionId: question.id },
        select: { id: true },
      });

      if (existing) {
        throw new ConflictException(
          `Question "${question.id}" has already been answered in this session`,
        );
      }
    }

    const profile = await this.loadProfile(userId);
    const answeredAt = this.clock.now();

    const { status, stateCode, answers } = await this.grading.resolveAcceptedAnswers(
      question,
      profile.stateCode,
      answeredAt,
    );

    const snapshot: PracticeAnswerSnapshot = {
      resolvedAt: answeredAt.toISOString(),
      answerResolution: status,
      resolvedForStateCode: stateCode,
      answers,
    };

    const { outcome, responseText } = this.grading.gradeDeterministic(
      input,
      status,
      answers,
    );

    // RUNG 2, AND ONLY WHEN RUNG 1 MISSED. `escalateToGrader` returns null for
    // every attempt that must not reach a model — including a match, which is
    // the short-circuit `ai-evaluation.md` §6 rung 1 requires — and null for
    // every way the call can fail, which is rung 3's fallback. Either way the
    // deterministic result below still stands.
    const aiGrading = await this.grading.escalateToGrader(
      userId,
      question.prompt,
      answers,
      { status, outcome, responseText },
    );

    // The model's verdict when one was reached, rung 1's otherwise. The two
    // are read together with `gradingMethod` and never merged: "was it
    // right" and "how do we know" stay independent facts (§9). Pulled out
    // here (rather than inlined in the `create` below) because the mastery
    // scheduling call a few lines down needs the exact same two facts to map
    // to an `AttemptOutcome` — see `mastery/outcome-mapping.ts`.
    const finalOutcome = aiGrading?.outcome ?? outcome;
    const gradingMethod = aiGrading ? 'ai' : 'exact';

    // MISHEARD IS DECIDED HERE, ON THE SERVER, AFTER GRADING (issue #104,
    // epic #58 / E9). See {@link isMisheardAttempt} for the three conditions
    // and why each one is a condition; the override itself is applied in the
    // `create` below, after the grader's own columns, so that it WINS.
    const misheard = isMisheardAttempt(input.asrConfidence, finalOutcome);

    // SYNCHRONOUS MASTERY SCHEDULING (issue #78, epic #54 / E5), inside the
    // SAME transaction as the attempt write — not a second transaction and
    // not fire-and-forget. `question_mastery` is derived, live state; a
    // learner whose next question depends on it (the very next
    // `nextQuestionFor` call, a few lines below) must see this attempt's
    // effect already applied, which only holds if both writes commit
    // together.
    //
    // SKIPPED for a `state_required` attempt specifically: `grade()`'s own
    // comment above already treats that case as "no honest grade available",
    // recorded as `skipped` rather than `incorrect` so the evidence table is
    // not entered with a wrong answer nobody actually gave. Feeding the
    // identical `skipped` outcome into the scheduler would silently lapse a
    // question's mastery for a system limitation (no state on the learner's
    // profile) rather than anything the learner did — the same harm `grade()`
    // already avoids for `practice_attempts.outcome`, applied here to
    // `question_mastery` too. Question selection never SELECTS such a
    // question in the first place (`mastery/selector.ts`'s own
    // `excludeUnanswerable`), so this only matters for a question id a client
    // posted rather than was handed.
    const attempt = await this.prisma.$transaction(async (tx) => {
      const created = await tx.practiceAttempt.create({
        data: {
          userId,
          questionId: question.id,
          sessionId: session.id,
          source: 'practice',
          // CLIENT-REPORTED, no longer hardcoded (issue #104, epic #58 / E9).
          // Nothing on the server can reconstruct either after the fact: the
          // recording is transcribed and discarded at the point of capture
          // (`voice.md` §4), so a row that did not record how the answer was
          // given and how the prompt was delivered has lost both facts
          // permanently. The DTO defaults them to the pre-E9 values, so a
          // client that has never heard of voice still writes exactly the row
          // it always wrote.
          inputMode: input.inputMode,
          promptMode: input.promptMode,
          responseText,
          outcome: finalOutcome,
          gradingMethod,
          // THE THREE AI COLUMNS ARE OMITTED ENTIRELY WHEN NO GRADER RAN, rather
          // than written as null. Both leave the same NULL in Postgres, but a
          // nullable `Json` column takes `Prisma.DbNull` rather than `null`, and a
          // conditional spread keeps this write free of a Prisma-specific null
          // sentinel that a reader would have to decode. The absence IS the
          // meaning here: null in all three says no grader ever looked at this
          // response, which is a different fact from `failureCause: 'unknown'`
          // (schema.prisma, `PracticeFailureCause`).
          ...(aiGrading
            ? {
                failureCause: aiGrading.failureCause,
                // THE PARSED VERDICT ONLY — never the prompt, never a raw
                // completion. The prompt is reconstructable from `responseText`
                // plus `answerSnapshot` at any time, and a raw completion is
                // exactly the unbounded provider text this column's own comment
                // excludes.
                aiFeedback: aiGrading.aiFeedback as unknown as Prisma.InputJsonValue,
                aiUsageEventId: aiGrading.aiUsageEventId,
              }
            : {}),
          // ---------------------------------------------------------------
          // THE `misheard` OVERRIDE, DELIBERATELY SPREAD LAST (issue #104)
          // ---------------------------------------------------------------
          //
          // It overwrites whatever cause the grader supplied, and the order
          // of these two spreads is the whole mechanism — reversing them
          // would silently restore the grader's guess. The reasoning is in
          // {@link isMisheardAttempt}; the short version is that the
          // recogniser's own uncertainty about the TEXT is better evidence
          // about why an answer missed than a model's inference from the
          // text it produced.
          //
          // THIS IS THE ONE CASE WHERE `failureCause` IS NON-NULL WITH
          // `aiFeedback` AND `aiUsageEventId` BOTH NULL. Everywhere else in
          // this table the three are written together or not at all (the
          // block comment above, and `practice-attempt.dto.ts`). A reader
          // hitting such a row is not looking at a half-written grading
          // call: they are looking at a cause this service concluded from a
          // measurement no model was involved in, which `gradingMethod`
          // ('exact' unless a grader also ran) says plainly.
          ...(misheard ? { failureCause: 'misheard' as const } : {}),
          // The three voice columns, straight from the request. `?? null`
          // rather than a conditional spread because all three are plain
          // scalar columns — there is no `Prisma.DbNull` sentinel to avoid,
          // and an explicit null reads as what it is.
          transcript: input.transcript ?? null,
          asrConfidence: input.asrConfidence ?? null,
          // The link that makes this row supersede an earlier one. Validated
          // by `requireRetryTarget` above — by the time it reaches here it
          // names an attempt of this caller's, in this session, at this
          // question, not itself a retry and not already superseded.
          retryOfAttemptId: input.retryOfAttemptId ?? null,
          revealed: input.revealed,
          hintUsed: input.hintUsed,
          // Absent stays absent. `0` would be a claim that the learner answered
          // instantly — see the DTO, and `ai_usage_events`' nullable token counts
          // for the same argument applied to a different unknown.
          durationMs: input.durationMs ?? null,
          answeredAt,
          answerSnapshot: snapshot as unknown as Prisma.InputJsonValue,
        },
        include: { question: { select: QUESTION_SELECT } },
      });

      if (status !== 'state_required') {
        await this.grading.scheduleMastery(
          tx,
          userId,
          question.id,
          toAttemptOutcome(finalOutcome, gradingMethod),
          answeredAt,
        );
      }

      return created;
    });

    // ACCRUAL EVENT (A) (issue #119, epic #56 / E7), after the transaction
    // above has COMMITTED — never inside it. Accrual is not part of what makes
    // this attempt valid, so it must not be able to roll it back
    // (habit-streaks.md §2.1). It runs for every recorded attempt, INCLUDING a
    // `skipped` one: a skip is not evidence of recall in either direction for
    // mastery scheduling, but it is still a real interaction with the product,
    // and excluding it would undercount genuine engagement. Placed after the
    // commit specifically so `sliceSeconds`' "previous attempt in this
    // session" lookup can see this row and correctly measure the NEXT slice
    // from it.
    await this.accrueActivity(userId, session.id, () =>
      this.engagement.recordAttemptActivity(userId, {
        sessionId: session.id,
        answeredAt,
        outcome: finalOutcome,
      }),
    );

    const sessionAttempts = await this.prisma.practiceAttempt.findMany({
      where: { sessionId: session.id, userId },
      // `id` and `retryOfAttemptId` are read for `dropSuperseded` below, not
      // for display — see that function, and `getSession`/`completeSession`,
      // which count the same rows the same way.
      select: { id: true, questionId: true, retryOfAttemptId: true },
    });

    // EVERY attempted question, superseded ones INCLUDED. This set is what
    // stops `nextQuestionFor` from handing back a question the learner has
    // already been asked, and a question whose first attempt was superseded
    // by a retry has still been asked — dropping it here would put it back in
    // the rotation for the same session.
    const answeredQuestionIds = new Set<string>(
      sessionAttempts.map((row: { questionId: string }) => row.questionId),
    );

    // The COUNT, however, excludes them: a mishearing and its correction are
    // one answered question, not two. This is the same rule `completeSession`
    // applies to the summary, through the same helper, so "3 of 5" on the
    // progress bar and "answered: 3" in the stored summary can never
    // disagree.
    const answered = dropSuperseded(sessionAttempts).length;

    return {
      attempt: toAttemptResponse(attempt),
      // Earned: the attempt is recorded, so showing what was accepted is
      // feedback rather than a hint. The same list that was just frozen into
      // the snapshot, so the screen and the permanent record cannot disagree.
      acceptedAnswers: answers,
      nextQuestion: await this.nextQuestionFor(
        session,
        userId,
        answered,
        answeredQuestionIds,
      ),
      progress: { answered, planned: session.plannedCount },
    };
  }

  /**
   * "I was right, the matcher just didn't recognise it."
   *
   * A DISTINCT ROUTE AND A DISTINCT `gradingMethod`, which is the entire point
   * (practice-sessions.md §9, locked decision #3). `matchAnswer` will never
   * accept a real paraphrase or a synonym the seven normalisation steps do not
   * anticipate — that is what "no edit distance, no similarity score" costs a
   * learner who genuinely knew the answer. Without an escape hatch the product
   * tells a correct learner they are wrong, on an application whose whole
   * premise is building accurate confidence.
   *
   * But a self-mark must never be *indistinguishable* from a verified match.
   * `outcome: 'correct'` with `gradingMethod: 'self'` records both facts
   * separately: it counts as right, and E5 knows exactly how it came to be
   * right so it can weigh it less. A `self_correct` outcome value was rejected
   * for the mirror-image reason — it would force every reader that only asks
   * "was this right" to enumerate two values for one concept (§9, §13).
   *
   * **Revealing first is required**, and it is not a formality. Self-mark is
   * the learner asserting their answer matched the accepted one, and that
   * assertion is only checkable against the actual accepted answer — not
   * against their own memory of what they think it probably was. Without the
   * gate, self-mark degrades into "mark me correct because I want to be", which
   * §13 rejects by name. `revealed` is recorded on the attempt itself, so the
   * client that showed the answer is the client that reported it.
   *
   * **Idempotent**: a second call on an already-self-marked attempt returns the
   * same state rather than erroring, because a retried request must not become
   * a failure the learner has to interpret.
   *
   * An attempt already `correct` by `exact` (or, once E4 ships, by `ai`) is a
   * 400: there is nothing to grant, and silently overwriting `exact` with
   * `self` would DOWNGRADE the evidence — turning a verified match into a
   * learner's own claim, which is the one direction this endpoint must never
   * move the record.
   */
  async selfMarkAttempt(
    userId: string,
    sessionId: string,
    attemptId: string,
  ): Promise<PracticeAttemptResponse> {
    // The session is resolved first, and by owner, so an attempt id cannot be
    // probed through a session the caller does not own.
    const session = await this.requireSession(userId, sessionId);

    const attempt = await this.prisma.practiceAttempt.findFirst({
      where: { id: attemptId, sessionId: session.id, userId },
      include: { question: { select: QUESTION_SELECT } },
    });

    if (!attempt) {
      throw new NotFoundException(`Practice attempt "${attemptId}" not found`);
    }

    if (attempt.outcome === 'correct') {
      if (attempt.gradingMethod === 'self') {
        // Already exactly what this call asks for. Return it unchanged.
        return toAttemptResponse(attempt);
      }

      throw new BadRequestException(
        'This attempt was already graded correct — there is nothing to self-mark',
      );
    }

    if (!attempt.revealed) {
      // Well-formed request, forbidden by the attempt's state: 409, matching
      // §10's own choice of status for this refusal.
      throw new ConflictException(
        'Reveal the accepted answer before self-marking — the claim is only checkable against it',
      );
    }

    const scheduledAt = this.clock.now();

    // SYNCHRONOUS MASTERY SCHEDULING, in the SAME transaction as the update —
    // see `recordAttempt`'s identical comment. `toAttemptOutcome('correct',
    // 'self')` resolves to `'correct_self_marked'`
    // (`mastery/outcome-mapping.ts`), which is exactly the discounted-credit
    // case `nextSchedule`'s own header names: half the ease bump and half the
    // interval growth of a verified match, because a self-mark is a weaker
    // signal than one (§9 of this file's header; scheduler.ts's own header).
    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.practiceAttempt.update({
        where: { id: attempt.id },
        data: { outcome: 'correct', gradingMethod: 'self' },
        include: { question: { select: QUESTION_SELECT } },
      });

      await this.grading.scheduleMastery(
        tx,
        userId,
        attempt.questionId,
        toAttemptOutcome('correct', 'self'),
        scheduledAt,
      );

      return result;
    });

    this.logger.log(
      { userId, sessionId: session.id, attemptId: attempt.id },
      'Practice attempt self-marked correct',
    );

    return toAttemptResponse(updated);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * The attempt a retry claims to supersede, or a refusal.
   *
   * ---------------------------------------------------------------------------
   * THE ONLY DOOR THROUGH THE ONE-ATTEMPT-PER-QUESTION GUARD (issue #104, E9)
   * ---------------------------------------------------------------------------
   *
   * `docs/specs/voice.md` §3.3 relaxes that guard for exactly one case: a
   * learner whose spoken answer may have been misheard is offered another go,
   * and the corrected answer is written as a NEW row linked back to the
   * original rather than as an edit of it (§3.2 — the original is evidence
   * that a mishearing happened, and this product does not delete evidence to
   * make a number look better). Everything about how narrow that door is
   * lives in this method.
   *
   * **Somebody else's attempt id is a 404, not a 403** — the identical rule
   * `requireSession` follows for a session, applied to an attempt, and for the
   * identical reason: a 403 would confirm that the id names a real attempt,
   * which is itself the leak. Note what that means for the `where` below —
   * `userId`, `sessionId` and `questionId` are all FILTERS, not checks applied
   * after loading a row, so this method cannot read another learner's attempt
   * even for long enough to decide to reject it.
   *
   * The same 404 covers a real attempt of the caller's own that belongs to a
   * different session or a different question. That is not a weaker answer
   * than a 400 would be: from this session's position, "the attempt you are
   * retrying" genuinely does not exist, and a distinct status for each near
   * miss would hand a caller a probe for which of their own attempts sit
   * where.
   *
   * Two 409s follow, and they are the pair that keeps the relaxation from
   * becoming an unlimited-attempts loophole:
   *
   *   - **the target is itself a retry.** A chain may be two rows long, never
   *     three. Without this, A → B → C → D is a sequence of individually
   *     well-formed requests that lets a learner answer one question as many
   *     times as they like inside a Quick 5 — the exact behaviour the guard
   *     exists to prevent, with a linked list to show for it.
   *   - **something already supersedes the target.** One correction per row.
   *     The practice flow only ever offers a retry immediately after a
   *     low-confidence transcription (§3.1); there is no path that asks a
   *     learner to re-retry an attempt the session has already moved past, so
   *     a second retry of the same row is a request no legitimate client
   *     makes.
   */
  private async requireRetryTarget(
    userId: string,
    sessionId: string,
    questionId: string,
    retryOfAttemptId: string,
  ): Promise<void> {
    const target = await this.prisma.practiceAttempt.findFirst({
      where: { id: retryOfAttemptId, userId, sessionId, questionId },
      select: { id: true, retryOfAttemptId: true },
    });

    if (!target) {
      throw new NotFoundException(
        `Practice attempt "${retryOfAttemptId}" not found`,
      );
    }

    if (target.retryOfAttemptId) {
      throw new ConflictException(
        `Practice attempt "${retryOfAttemptId}" is itself a retry and cannot be retried again`,
      );
    }

    const alreadySuperseded = await this.prisma.practiceAttempt.findFirst({
      where: { retryOfAttemptId: target.id },
      select: { id: true },
    });

    if (alreadySuperseded) {
      throw new ConflictException(
        `Practice attempt "${retryOfAttemptId}" has already been retried`,
      );
    }
  }

  /**
   * The caller's session, or a 404.
   *
   * The ONE place any route loads a session, filtered by `userId` in the
   * `where` rather than checked afterwards — see this file's header on why
   * somebody else's session is a 404 and not a 403.
   */
  private async requireSession(userId: string, sessionId: string) {
    const session = await this.prisma.practiceSession.findFirst({
      where: { id: sessionId, userId },
    });

    if (!session) {
      throw new NotFoundException(`Practice session "${sessionId}" not found`);
    }

    return session;
  }

  /**
   * The three profile facts practice reads. A missing row reads as all-unknown.
   *
   * A plain read, never an upsert: `JourneyService.getProfile` is the one place
   * a `learner_profiles` row is created, because orientation is what fills it
   * in. Practice creating one would be a side effect on a path that has no
   * business having one — and the row it created would say nothing more than
   * the nulls below already do.
   */
  /**
   * Run one accrual call, and never let it fail the action that triggered it.
   *
   * THE SAME RULE `CLAUDE.md`'s "Adding a Notification" section states for
   * `notify()` — a send failure "becomes a `notification_deliveries` row,
   * never an exception" — enforced directly here, because accrual has no
   * delivery row to fall back to (habit-streaks.md §2.4). A thrown error is
   * logged with the userId and sessionId, and swallowed.
   *
   * An attempt that was graded correctly, or a session that genuinely
   * completed, must never become a 500 because a rollup table had a transient
   * write failure: the attempt and the session are the EVIDENCE; the day's
   * tally is a derived convenience on top of it. A missed increment is also
   * recoverable in a way a lost attempt never would be — the next accrual call
   * for the same local day still lands, since the upsert simply adds to
   * whatever `practiceSeconds` the row already holds.
   */
  private async accrueActivity(
    userId: string,
    sessionId: string,
    accrue: () => Promise<void>,
  ): Promise<void> {
    try {
      await accrue();
    } catch (error) {
      this.logger.error(
        { userId, sessionId, err: error },
        'Daily activity accrual failed; the attempt or completion it followed still stands',
      );
    }
  }

  private async loadProfile(userId: string): Promise<PracticeProfile> {
    const profile = await this.prisma.learnerProfile.findUnique({
      where: { userId },
      select: { stateCode: true, testVersionCode: true, seniorExemption: true },
    });

    return {
      stateCode: profile?.stateCode ?? null,
      testVersionCode: profile?.testVersionCode ?? null,
      seniorExemption: profile?.seniorExemption ?? false,
    };
  }

  /**
   * {@link loadProfile}, refusing a learner with no resolved test version.
   *
   * `practice_sessions.testVersionCode` is `NOT NULL` and there is no honest
   * value to invent: which civics bank a learner sits is resolved from their
   * filing date at orientation (`journey/test-version-resolution.ts`), and
   * defaulting to one here would quietly drill them on the wrong test. A 400
   * naming orientation is actionable; a session against a guessed bank is not
   * discoverable at all.
   *
   * Unreachable through the app's own screens — `RequireOrientation` blocks an
   * unoriented learner from every route but setup — which is why this is a
   * plain 400 rather than a redirect or a special error code.
   */
  private async requireOrientedProfile(userId: string): Promise<PracticeProfile> {
    const profile = await this.loadProfile(userId);

    if (!profile.testVersionCode) {
      throw new BadRequestException(
        'Finish orientation before practising — your civics test version has not been resolved yet',
      );
    }

    return profile;
  }

  /**
   * The learner's selectable questions, mastery-ordered (v2, issue #78).
   *
   * Three filters on the question bank itself, and the third is the one worth
   * naming:
   *
   *  - the session's test version, so a learner is only ever asked questions
   *    from the bank they will actually sit;
   *  - the session's category, when it has one;
   *  - `seniorEligible: true` when the learner claims the 65/20 accommodation.
   *    That filters the question SET and never an answer — civics-content.md §5
   *    is emphatic about the distinction, and it is the reason the flag lives
   *    on `civics_questions` rather than being applied to answer resolution.
   *
   * Unanswerable questions are dropped and the rest ordered by
   * `mastery/selector.ts`'s `selectQuestionsV2` — due, then weak/lapsed, then
   * new (by category coverage), then steady, then mastered (sampled by
   * recency). That file's own header has the full rule; this method's job is
   * only to hand it the right rows.
   *
   * **Mastery is read with one bounded `findMany`**, scoped to exactly the
   * question ids just selected from the bank — never `where: { userId }`
   * alone, which would drag in mastery rows for every OTHER test version and
   * category the learner has ever touched. `question_mastery`'s own
   * `[userId, dueAt]` index does not cover this shape, but the `id IN (...)`
   * list this query filters by is bounded to the bank's own size (at most a
   * few hundred rows), so a table scan over that bound is the same cost class
   * v1's `practiceAttempt.groupBy` query was.
   *
   * A question with NO mastery row reads as `state: 'new'` structurally — see
   * `mastery/selector.ts`'s `classifyMasteryBucket` — which is the same "never
   * attempted" fact v1's `seenQuestionIds` used to carry, now derived from the
   * live scheduling table instead of a second aggregation over
   * `practice_attempts`. Issue #220's backfill is what makes that substitution
   * correct for questions attempted before this epic shipped.
   *
   * The pool is re-read on every call rather than persisted with the session.
   * There is no column for a question list (§2.1's table has none), and adding
   * one would be a second place the session's contents are recorded — able to
   * disagree with the attempts that actually happened. Re-selecting, minus what
   * this session has already answered, is stateless, cannot drift, and costs
   * two bounded queries over a bank of at most a few hundred rows.
   */
  private async candidateQuestions(
    scope: { testVersionCode: string; categoryId: string | null },
    profile: PracticeProfile,
    userId: string,
    excludeQuestionIds?: ReadonlySet<string>,
  ): Promise<QuestionRow[]> {
    const questions = await this.prisma.civicsQuestion.findMany({
      where: {
        testVersionCode: scope.testVersionCode,
        ...(scope.categoryId ? { categoryId: scope.categoryId } : {}),
        ...(profile.seniorExemption ? { seniorEligible: true } : {}),
      },
      select: QUESTION_SELECT,
      orderBy: [{ number: 'asc' }],
    });

    const masteryByQuestionId = await this.loadMasteryByQuestionId(
      userId,
      questions.map((question: { id: string }) => question.id),
    );

    return selectQuestionsV2(questions as unknown as QuestionRow[], {
      learnerStateCode: profile.stateCode,
      masteryByQuestionId,
      now: this.clock.now(),
      excludeQuestionIds,
    });
  }

  /**
   * This user's `question_mastery` rows for exactly the given question ids,
   * as the plain snapshot `mastery/selector.ts` (and `getQueue` below) read —
   * never the whole Prisma row, so a caller cannot accidentally start reading
   * a column the selection rule does not use.
   */
  private async loadMasteryByQuestionId(
    userId: string,
    questionIds: readonly string[],
  ): Promise<ReadonlyMap<string, QuestionMasterySnapshot>> {
    if (questionIds.length === 0) {
      return new Map();
    }

    const rows = (await this.prisma.questionMastery.findMany({
      where: { userId, questionId: { in: questionIds as string[] } },
      select: {
        questionId: true,
        state: true,
        dueAt: true,
        lapses: true,
        correctStreak: true,
        lastAttemptAt: true,
      },
    })) as ({ questionId: string } & QuestionMasterySnapshot)[];

    return new Map(rows.map((row) => [row.questionId, row] as const));
  }

  // ---------------------------------------------------------------------------
  // Queue (issue #78, epic #54 / E5)
  // ---------------------------------------------------------------------------

  /**
   * Queue counts for the Practice page's picker (`GET /api/practice/queue`).
   *
   * Every count is produced by `mastery/selector.ts`'s `classifyMasteryBucket`
   * — the SAME function `candidateQuestions` above uses to order a session's
   * questions — so this endpoint can never disagree with what starting a
   * session right now would actually select. `total` and the bank read are
   * scoped identically to `candidateQuestions` too: the caller's own
   * `testVersionCode`, and `seniorEligible` only, under the 65/20 exemption.
   *
   * Uses `requireOrientedProfile`, the same guard `createSession` uses: there
   * is no honest queue to report for a learner whose test version has not
   * been resolved yet.
   */
  async getQueue(userId: string): Promise<PracticeQueueResponse> {
    const profile = await this.requireOrientedProfile(userId);
    const testVersionCode = profile.testVersionCode as string;

    const rawQuestions = await this.prisma.civicsQuestion.findMany({
      where: {
        testVersionCode,
        ...(profile.seniorExemption ? { seniorEligible: true } : {}),
      },
      select: { id: true, categoryId: true, dynamicScope: true },
    });

    // BUG FIX (issue #78 follow-up, caught writing integration coverage): a
    // `state`-scope question for a learner with no state on their profile was
    // being counted here (as `new`, most likely) even though
    // `candidateQuestions`'s `selectQuestionsV2` — via `excludeUnanswerable`
    // — would never let a session select it. That contradicted both this
    // file's own header ("can never disagree with what starting a session
    // right now would actually select") and the DTO's own doc comment on
    // `total` ("scoped ... exactly as session selection is"). Applying the
    // SAME `excludeUnanswerable` filter session selection uses, over the
    // SAME `profile.stateCode`, keeps the two in agreement.
    const questions = excludeUnanswerable(
      rawQuestions as { id: string; categoryId: string; dynamicScope: DynamicScope }[],
      profile.stateCode,
    );

    const masteryByQuestionId = await this.loadMasteryByQuestionId(
      userId,
      questions.map((question: { id: string }) => question.id),
    );

    const now = this.clock.now();

    let due = 0;
    let weak = 0;
    let learning = 0;
    let mastered = 0;
    const newCountByCategory = new Map<string, number>();

    for (const question of questions as { id: string; categoryId: string }[]) {
      const bucket = classifyMasteryBucket(masteryByQuestionId.get(question.id), now);

      switch (bucket) {
        case 'due':
          due += 1;
          break;
        case 'weak':
          weak += 1;
          break;
        case 'steady':
          learning += 1;
          break;
        case 'mastered':
          mastered += 1;
          break;
        case 'new':
          newCountByCategory.set(
            question.categoryId,
            (newCountByCategory.get(question.categoryId) ?? 0) + 1,
          );
          break;
      }
    }

    const categories =
      newCountByCategory.size === 0
        ? []
        : await this.prisma.civicsCategory.findMany({
            where: { id: { in: [...newCountByCategory.keys()] } },
            select: { id: true, name: true },
          });

    const categoryNameById = new Map(
      (categories as { id: string; name: string }[]).map((category) => [category.id, category.name]),
    );

    const newTotal = [...newCountByCategory.values()].reduce((sum, count) => sum + count, 0);

    return {
      testVersionCode,
      total: questions.length,
      due,
      weak,
      learning,
      mastered,
      new: {
        total: newTotal,
        byCategory: [...newCountByCategory.entries()]
          .map(([categoryId, newCount]) => ({
            categoryId,
            categoryName: categoryNameById.get(categoryId) ?? categoryId,
            newCount,
          }))
          // Most-uncovered category first — the same signal the selector's
          // own category-coverage rule reacts to, surfaced here for a human
          // to read instead of an algorithm to consume.
          .sort((a, b) => b.newCount - a.newCount),
      },
    };
  }

  /**
   * The next question to ask in this session, or null.
   *
   * Null in three cases, each meaning something different to a client that only
   * has to check for null: the session is no longer `in_progress`, the planned
   * count has been reached (the session has asked what it set out to ask), or
   * the bank has nothing left that this learner can be asked.
   *
   * Prompt only. See `dto/practice-question.dto.ts`.
   */
  private async nextQuestionFor(
    session: {
      id: string;
      status: string;
      testVersionCode: string;
      categoryId: string | null;
      plannedCount: number;
    },
    userId: string,
    answered: number,
    answeredQuestionIds: ReadonlySet<string>,
  ): Promise<PracticeQuestion | null> {
    if (session.status !== 'in_progress' || answered >= session.plannedCount) {
      return null;
    }

    const profile = await this.loadProfile(userId);

    const ordered = await this.candidateQuestions(
      {
        testVersionCode: session.testVersionCode,
        categoryId: session.categoryId,
      },
      profile,
      userId,
      answeredQuestionIds,
    );

    return ordered.length > 0 ? toQuestion(ordered[0]) : null;
  }
}

// -----------------------------------------------------------------------------
// Row → wire mappers
// -----------------------------------------------------------------------------
//
// Field by field rather than by spread, for the reason `CivicsService` and
// `JourneyController.listStages` both give: the response shape is decided here,
// in code that is about the response shape. A spread would make it a consequence
// of whichever columns the table happens to grow, so a column added later for an
// internal consumer would silently become public API.
//
// That is not a general tidiness argument in this module — it is the specific
// hazard `dto/practice-question.dto.ts` exists to prevent. `civics_questions`
// has no answer columns today, but `practice_attempts` does carry E4's
// `aiFeedback` and `failureCause`, and a spread over an attempt row would put
// whatever E4 stores there on the wire the day it lands, decided by nobody.

/** `civics_questions` row → the PROMPT-ONLY wire shape. No answers, ever. */
function toQuestion(question: QuestionRow): PracticeQuestion {
  return {
    id: question.id,
    number: question.number,
    prompt: question.prompt,
    categoryId: question.categoryId,
    dynamicScope: question.dynamicScope,
  };
}

/** `practice_sessions` row → wire shape. */
function toSessionResponse(session: any): PracticeSessionResponse {
  return {
    id: session.id,
    kind: session.kind,
    status: session.status,
    testVersionCode: session.testVersionCode,
    categoryId: session.categoryId,
    plannedCount: session.plannedCount,
    startedAt: session.startedAt.toISOString(),
    completedAt: session.completedAt ? session.completedAt.toISOString() : null,
    // Null while `in_progress` — there is nothing to summarise yet, and an
    // empty object standing in for "no summary" would be indistinguishable from
    // a genuinely empty completed session (§2.1).
    summary: (session.summary as PracticeSessionSummary | null) ?? null,
  };
}

/** `practice_attempts` row (with its question) → wire shape. */
function toAttemptResponse(attempt: any): PracticeAttemptResponse {
  return {
    id: attempt.id,
    sessionId: attempt.sessionId,
    questionId: attempt.questionId,
    question: toQuestion(attempt.question),
    source: attempt.source,
    inputMode: attempt.inputMode,
    promptMode: attempt.promptMode,
    responseText: attempt.responseText,
    outcome: attempt.outcome,
    gradingMethod: attempt.gradingMethod,
    revealed: attempt.revealed,
    hintUsed: attempt.hintUsed,
    durationMs: attempt.durationMs,
    // The three AI-grading columns, `null` together on every attempt no grader
    // ran for. `?? null` rather than a bare read because a row selected without
    // these columns — an older fixture, a narrowed `select` — would otherwise
    // put `undefined` on the wire, and "absent" and "no grader ran" would stop
    // being the same answer to a client.
    failureCause: attempt.failureCause ?? null,
    aiFeedback: (attempt.aiFeedback as GradingVerdict | null) ?? null,
    aiUsageEventId: attempt.aiUsageEventId ?? null,
    // The voice columns (issue #104, epic #58 / E9). `?? null` for the same
    // reason the three above carry it: a row selected without them must put
    // `null` on the wire, not `undefined`, so "this attempt was typed" and
    // "we did not read that column" never become the same answer to a client.
    //
    // All four are on the wire because the web renders decisions from them: a
    // `spoken` attempt whose `failureCause` is `misheard` is the state that
    // offers a retry, `transcript` is what it shows the learner so they can
    // see what went wrong, and `retryOfAttemptId` is the link a review screen
    // draws between the mishearing and its correction.
    transcript: attempt.transcript ?? null,
    asrConfidence: attempt.asrConfidence ?? null,
    retryOfAttemptId: attempt.retryOfAttemptId ?? null,
    answeredAt: attempt.answeredAt.toISOString(),
    // Read back whole, exactly as frozen. Never re-resolved, never merged with
    // whatever `civics_answers` says today — that is the entire point of the
    // column (§6).
    answerSnapshot: attempt.answerSnapshot as PracticeAnswerSnapshot,
  };
}

/**
 * Is this attempt's failure better explained by the recogniser than by the
 * learner? (issue #104, epic #58 / E9)
 *
 * -----------------------------------------------------------------------------
 * THREE CONDITIONS, AND EACH ONE IS LOAD-BEARING
 * -----------------------------------------------------------------------------
 *
 * 1. **A confidence was reported at all.** `null`/`undefined` NEVER produces
 *    `misheard`, and this is the condition most likely to be "simplified" away
 *    by someone reading `< 0.6` and reaching for `(confidence ?? 0)`. Unknown
 *    is not low. Several transcription models report no confidence whatsoever
 *    (`OpenAiProvider.runTranscription`: the `gpt-4o-transcribe` family
 *    cannot), so collapsing the two would stamp `misheard` on every attempt
 *    whose confidence merely could not be read — telling a learner the system
 *    struggled to hear them when, as far as anything here knows, it did not.
 *    `schema.prisma`'s `asrConfidence` comment makes the same point about the
 *    column; this is the code that has to honour it.
 *
 * 2. **The confidence is strictly below {@link ASR_CONFIDENCE_THRESHOLD}.**
 *    The number lives in one place for the reason its own doc gives; `0.6`
 *    exactly is trusted, because the boundary has to fall on one side and
 *    trusting the transcript is the side that cannot invent a mishearing.
 *
 * 3. **The outcome is not `correct`.** A right answer is right however it was
 *    heard. Writing a failure cause beside a correct outcome would manufacture
 *    a failure to explain where there is none — the same rule
 *    `persistedFailureCause` already applies to a grader's `correct` verdict.
 *
 * -----------------------------------------------------------------------------
 * WHY THIS OVERRIDES A GRADER-SUPPLIED CAUSE RATHER THAN DEFERRING TO IT
 * -----------------------------------------------------------------------------
 *
 * The grader sees TEXT. It is handed the question, the accepted answers and a
 * string, and asked what that string means; when it offers a cause it is
 * inferring, from words alone, why a person got something wrong. The
 * recogniser's confidence is a MEASUREMENT of how well those words captured
 * what was said — evidence about the pipeline rather than an inference about
 * the learner — and when it says the capture was poor, that is the better
 * explanation of a miss than any reading of its output can be.
 *
 * It is also the fairness-preserving direction, which is the reason the
 * override exists at all. `VISION.md` line 228 promises a learner may
 * "practice without being unfairly penalized for accent or speech-recognition
 * errors", and `misheard` is precisely the value `PracticeFailureCause` has
 * for that. The alternative — recording `not_known` or `not_recalled` on an
 * answer the recogniser garbled — tells a learner something about themselves
 * that nothing observed. `docs/specs/ai-evaluation.md` §8 calls that a
 * manufactured diagnosis and it is the failure the whole taxonomy exists to
 * avoid.
 *
 * Note the direction of the risk if this rule is ever wrong: `misheard` never
 * makes a wrong answer count as correct, never advances mastery, and never
 * raises a readiness score. The worst a false `misheard` does is decline to
 * blame a learner. The worst a false `not_known` does is tell them they do not
 * know something they do.
 *
 * Nothing here consults `inputMode`, and it does not need to: the DTO rejects
 * an `asrConfidence` on a typed attempt outright, so a confidence only ever
 * arrives on a spoken one. It rejects one on a SKIPPED attempt too — which is
 * why "not `correct`" can be stated as plainly as the spec states it, without
 * a carve-out for the learner who declined to answer at all.
 */
export function isMisheardAttempt(
  asrConfidence: number | null | undefined,
  outcome: string,
): boolean {
  if (asrConfidence === null || asrConfidence === undefined) return false;
  if (asrConfidence >= ASR_CONFIDENCE_THRESHOLD) return false;
  return outcome !== 'correct';
}

/**
 * The attempts that count, with the superseded ones removed (issue #104, E9).
 *
 * An attempt another attempt points at through `retryOfAttemptId` is
 * SUPERSEDED (`docs/specs/voice.md` §3.2). It is never deleted — it is real
 * evidence that a mishearing happened, and an evidence ledger whose rows can
 * be removed to improve a number is not an evidence ledger — but it must not
 * be COUNTED, or a mishearing and its correction would read as two failures
 * where the learner answered one question.
 *
 * A PURE FUNCTION OVER ROWS ALREADY LOADED, not a `where` clause, and that is
 * deliberate: three call sites need this rule (`recordAttempt`'s progress
 * counter, `getSession`'s, and `computeSummary`), and the one property they
 * must have is that they agree. Three `where` clauses can drift; one function
 * they all call cannot. Expressing it in SQL would also need a correlated
 * subquery or a self-join per call site to ask "does anything point at this
 * row", for a set of rows a session has already loaded in full.
 *
 * `retryOfAttemptId` is read from the ROWS THEMSELVES rather than queried,
 * which is sound because a retry is only ever admitted into the same session
 * as the attempt it supersedes (`requireRetryTarget`). A row's superseder, if
 * it exists, is always in the list.
 *
 * Both fields are optional in the type so a caller holding a narrower row
 * shape — a unit test's fixture, a `select` written before E9 — is not a
 * compile error. Such a row simply has no superseder, which is the correct
 * reading of "this projection cannot express supersession".
 *
 * -----------------------------------------------------------------------------
 * READINESS NEEDS NO EQUIVALENT, AND THAT IS WORTH STATING RATHER THAN ASSUMING
 * -----------------------------------------------------------------------------
 *
 * `ReadinessService`'s `spoken` component counts distinct `questionId` among
 * rows matching `inputMode: 'spoken'` AND `outcome: 'correct'`. A superseded
 * attempt is by construction not correct — a correct answer is never routed to
 * a retry (see {@link isMisheardAttempt}, condition 3) — so it has never been
 * inside that query's result set, and no filter needs to be added there for
 * §3.2's rule to hold. `readiness.service.ts` already only reads the kind of
 * row a superseded attempt cannot be.
 */
export function dropSuperseded<
  T extends { id?: string; retryOfAttemptId?: string | null },
>(attempts: readonly T[]): T[] {
  const supersededIds = new Set<string>(
    attempts
      .map((attempt) => attempt.retryOfAttemptId)
      .filter((id): id is string => typeof id === 'string'),
  );

  if (supersededIds.size === 0) return [...attempts];

  return attempts.filter(
    (attempt) => attempt.id === undefined || !supersededIds.has(attempt.id),
  );
}

/**
 * The session summary, computed from the persisted attempt rows.
 *
 * A pure function of the rows it is handed — no clock, no database, no client
 * input — so the one thing that could make a summary wrong is the rows being
 * wrong, and the rows are the evidence table itself.
 *
 * `totalDurationMs` is null when NOTHING reported a duration, and `timedAttempts`
 * says how many attempts the total covers, so a partial total can never be read
 * as a complete one. Reporting `0` for an untimed session would be a claim that
 * it took no time, which is the same false claim `durationMs` is nullable to
 * avoid (§2.2).
 */
export function computeSummary(
  rows: readonly {
    outcome: string;
    gradingMethod: string;
    revealed: boolean;
    hintUsed: boolean;
    durationMs: number | null;
    // E9's two, optional so a narrower fixture still type-checks. See
    // {@link dropSuperseded}.
    id?: string;
    retryOfAttemptId?: string | null;
  }[],
  plannedCount: number,
): PracticeSessionSummary {
  // THE SUPERSESSION FILTER IS APPLIED HERE, INSIDE, rather than expected of
  // every caller (issue #104, epic #58 / E9). `completeSession` is the only
  // caller that persists the result, and a summary is written once and read
  // forever — so the filter has to be impossible to forget, not merely
  // documented. A caller passing rows that were already filtered is
  // unaffected: dropping superseded rows twice drops the same rows.
  const attempts = dropSuperseded(rows);

  const count = (outcome: string) =>
    attempts.filter((attempt) => attempt.outcome === outcome).length;

  const timed = attempts.filter(
    (attempt) => attempt.durationMs !== null && attempt.durationMs !== undefined,
  );

  return {
    plannedCount,
    answered: attempts.length,
    correct: count('correct'),
    partial: count('partial'),
    incorrect: count('incorrect'),
    skipped: count('skipped'),
    // Of the correct ones, how many were the learner's own claim rather than a
    // verified match. "Was it right" and "how do we know" are independent facts
    // (§9); a summary reporting only `correct` would flatten the difference E5
    // exists to weigh.
    selfMarked: attempts.filter(
      (attempt) =>
        attempt.outcome === 'correct' && attempt.gradingMethod === 'self',
    ).length,
    revealed: attempts.filter((attempt) => attempt.revealed).length,
    hintUsed: attempts.filter((attempt) => attempt.hintUsed).length,
    totalDurationMs:
      timed.length === 0
        ? null
        : timed.reduce((total, attempt) => total + (attempt.durationMs ?? 0), 0),
    timedAttempts: timed.length,
  };
}
