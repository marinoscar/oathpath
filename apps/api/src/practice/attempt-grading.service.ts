import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AiDispatchService } from '../ai/ai-dispatch.service';
import type { AiModelRole } from '../ai/ai-model-roles';
import {
  resolveCoachPersona,
  type CoachPersonaDef,
} from '../ai/coach/personas';
import {
  currentAnswerWhere,
  resolveAnswerScope,
  selectAnswers,
  type AnswerResolutionStatus,
  type DynamicScope,
} from '../civics/answer-resolution';
import { nextStageOnMasteryEvent } from '../journey/stage-transitions';
import { PrismaService } from '../prisma/prisma.service';
import { UserSettingsService } from '../settings/user-settings/user-settings.service';
import { matchAnswer, type AnswerMatch } from './answer-matching';
import {
  buildGradingPrompt,
  gradingVerdictSchema,
  groundVerdict,
  persistedFailureCause,
  GRADING_SCHEMA_NAME,
  type GradingVerdict,
  type PersistableFailureCause,
} from './grading';
import {
  fromStoredMasteryOutcome,
  toStoredMasteryOutcome,
} from './mastery/outcome-mapping';
import {
  masterySkipReason,
  type MasteryEvidence,
  type MasterySkipReason,
} from './mastery/mastery-skip';
import {
  initialMasteryRecord,
  nextSchedule,
  type AttemptOutcome,
  type MasteryRecord,
} from './mastery/scheduler';
import type { PracticeSnapshotAnswer } from './dto/practice-attempt.dto';

// =============================================================================
// AttemptGradingService (issue #133, epic #57 / E8)
// =============================================================================
//
// THE ONE LADDER. Extracted verbatim from `PracticeService`, where these four
// operations lived as private methods reachable only from `recordAttempt`, so
// that a civics answer given in a MOCK INTERVIEW is graded by exactly the same
// code a practice answer is — `docs/specs/mock-interview.md` §6: "reached
// through one shared injectable so there is only one ladder in the codebase".
//
// It is shared by `PracticeService` (epic #52 / E3) and, from #133, the
// interviews module. `PracticeModule` provides it and EXPORTS it; nothing here
// is duplicated, re-derived, or approximated on the interview side.
//
// Nothing about the ladder's behaviour changed in the move. The comments below
// are the ones that were on the private methods, carried across as they stood,
// because they document WHY each rung behaves as it does rather than what it
// does.
//
// -----------------------------------------------------------------------------
// THE GRADING LADDER, AND WHY ITS TOP RUNG CAN NEVER BREAK A SESSION
// -----------------------------------------------------------------------------
//
// Grading is three rungs, cheapest first (docs/specs/ai-evaluation.md §6):
//
//   1. `matchAnswer` — free, deterministic, tried first, and a HIT
//      SHORT-CIRCUITS: no AI call is made at all. `gradingMethod: 'exact'`.
//   2. On a miss, one `AiDispatchService.runStructured(userId, 'grader', ...)`
//      call with the grounded prompt from `grading.ts`. On a schema-valid
//      reply: `gradingMethod: 'ai'`, the outcome from the model's verdict, and
//      `failureCause` / `aiFeedback` / `aiUsageEventId` persisted with it.
//   3. Anything else — `unavailable`, `failed`, a reply that did not satisfy
//      the schema — keeps rung 1's verdict, writes `gradingMethod: 'exact'`,
//      writes none of the three AI columns, and returns a NORMAL 200 with the
//      accepted answers.
//
// Rung 3 is the rung with the product decision in it. An administrator who has
// not finished configuring AI, a learner who has not stored a personal key, and
// an OpenAI account that has run out of quota must all produce the SAME thing a
// learner saw before this epic existed: "not matched, here is the answer." A
// grading path that 500s the moment a key expires turns a billing event into an
// outage, mid-session, for someone practising for an interview.
//
// -----------------------------------------------------------------------------
// THIS SERVICE TOUCHES NO KEY AND NO CREDENTIAL
// -----------------------------------------------------------------------------
//
// It holds an `AiDispatchService` and nothing else: no provider, no model id, no
// `CredentialsService`, no API key in any form. Which model serves the `grader`
// role is the administrator's setting, whose key is spent is the caller's own
// credential, and both are resolved inside the dispatcher — `ai-evaluation.md`
// §3's rule that a caller cannot name its own model, so that a per-answer
// grading call can never be bound to the expensive model an admin configured for
// something else.
//
// -----------------------------------------------------------------------------
// NO CLOCK
// -----------------------------------------------------------------------------
//
// Every instant this service needs is a PARAMETER — `now` on
// {@link AttemptGradingService.resolveAcceptedAnswers}, `at` on
// {@link AttemptGradingService.scheduleMastery} — supplied by the caller from
// the injected `Clock`. That is the same rule `civics/answer-resolution.ts` and
// `mastery/scheduler.ts` already hold to, and it is what keeps ONE clock read
// per attempt: the instant frozen into the answer snapshot is the same instant
// the mastery row is scheduled against, because the caller read it once and
// passed it to both.
// =============================================================================

/**
 * The role this module dispatches under, and the ONLY one it may.
 *
 * Typed as `AiModelRole` rather than left as a bare string so that removing or
 * renaming the role in `ai-model-roles.ts` fails this file's build. The
 * alternative — a string that no longer names a declared role — resolves to
 * `capability_unsupported` at runtime, which reads as "the provider cannot do
 * this" and would send every grading call down rung 3 with a plausible-looking
 * reason nobody would question.
 */
const GRADER_ROLE: AiModelRole = 'grader';

/**
 * What a completed grading call contributes to the attempt row.
 *
 * FOUR FIELDS, WRITTEN TOGETHER OR NOT AT ALL. They describe one event — a
 * grader ran and answered — and a row carrying some of them would be a row
 * whose `failureCause` cannot be traced to the call that produced it.
 */
export interface AiGradingResult {
  /** The model's verdict, as the attempt's `outcome`. */
  outcome: GradingVerdict['verdict'];
  /** Null on a `correct` verdict — nothing failed, so nothing to explain. */
  failureCause: PersistableFailureCause | null;
  /** The structured reply, coerced, and nothing else. */
  aiFeedback: GradingVerdict;
  /** The `ai_usage_events` row this call wrote, when the write succeeded. */
  aiUsageEventId: string | null;
}

/**
 * What {@link AttemptGradingService.resolveAcceptedAnswers} hands back.
 *
 * Named rather than inlined only because it now crosses a module boundary: it
 * is the exact shape the private method already returned, and it is what a
 * caller freezes into an attempt's `answerSnapshot`.
 */
export interface ResolvedAcceptedAnswers {
  status: AnswerResolutionStatus;
  stateCode: string | null;
  answers: PracticeSnapshotAnswer[];
}

/**
 * What {@link AttemptGradingService.gradeDeterministic} reads off an attempt.
 *
 * NARROWED FROM `RecordAttemptInput`, which is what the private method took.
 * These are the only two fields it ever read, and stating that as a type is
 * what lets the interviews module (#133) call the same rung without
 * constructing a practice DTO to do it.
 */
export interface DeterministicGradingInput {
  readonly skipped: boolean;
  readonly responseText?: string | null;
}

@Injectable()
export class AttemptGradingService {
  private readonly logger = new Logger(AttemptGradingService.name);

  constructor(
    private readonly prisma: PrismaService,
    // THE ONE DOOR TO A MODEL. Injected as the dispatcher, never as a provider:
    // see the header, and `ai-evaluation.md` §3.
    private readonly dispatch: AiDispatchService,
    // ONE READ, ONE FIELD (issue #319, epic #305 / E14): the learner's own
    // `coach.persona`, which colours the WORDING of the grader's `feedback`
    // sentence and nothing else — see {@link resolvePersona} and
    // `grading.ts`'s `GRADING_PERSONA_SCOPE_NOTICE`.
    //
    // The namespace's own service rather than a hand-rolled read of the JSONB
    // column here: `user_settings.value`'s sparse shape (absent means "use the
    // built-in default", never "off") is `UserSettingsService`'s contract, and
    // a consumer casting the column would be the second place that contract is
    // interpreted and the first to get it wrong when the shape moves. This is
    // the same posture `SpeechAudioService` takes toward `readVoicePreferences`.
    private readonly userSettings: UserSettingsService,
  ) {}

  /**
   * The question's currently accepted answers, for this learner, at this
   * instant.
   *
   * Delegates every rule to `civics/answer-resolution.ts` —
   * `currentAnswerWhere` for "which rows are current as of now",
   * `resolveAnswerScope` for "which state, or none, or `state_required`", and
   * `selectAnswers` for "all simultaneously correct alternatives, or the single
   * current one". This service does not re-derive any of that: a second place
   * the same fact is computed is a second place it can drift from the first,
   * which
   * is the same argument civics-content.md §3 makes against a redundant
   * `is_current` flag. Neither practice nor the mock interview re-derives any
   * of it — they reach this one method.
   *
   * `state_required` runs NO query at all, exactly as `CivicsService` does:
   * there is no state to query for, and querying anyway would mean writing a
   * fallback — which is the guess civics-content.md §5 rejects outright.
   */
  async resolveAcceptedAnswers(
    question: { id: string; dynamicScope: string },
    learnerStateCode: string | null,
    now: Date,
  ): Promise<ResolvedAcceptedAnswers> {
    const scope = question.dynamicScope as DynamicScope;
    const { status, stateCode } = resolveAnswerScope(scope, learnerStateCode);

    const rows =
      status === 'state_required'
        ? []
        : await this.prisma.civicsAnswer.findMany({
            where: {
              questionId: question.id,
              stateCode,
              ...currentAnswerWhere(now),
            },
            orderBy: [{ sort: 'asc' }, { effectiveFrom: 'desc' }],
          });

    const answers = selectAnswers(scope, rows).map(
      (answer: any): PracticeSnapshotAnswer => ({
        id: answer.id,
        text: answer.text,
        sort: answer.sort,
        stateCode: answer.stateCode,
        verifiedAt: answer.verifiedAt.toISOString(),
      }),
    );

    return { status, stateCode, answers };
  }

  /**
   * The verdict, and the response text to store with it.
   *
   * Three branches, and the middle one is the interesting one:
   *
   *  - **Skipped** — `outcome: 'skipped'`, `responseText: null`. Recorded, not
   *    dropped: a skip is what "I have no idea" looks like, and discarding it
   *    would leave the readiness model unable to tell a question a learner
   *    keeps avoiding from one they have never been shown.
   *
   *  - **`state_required`** — also `skipped`, and deliberately NOT `incorrect`.
   *    There were no accepted answers to compare against, so the learner was
   *    not wrong; the product could not resolve what right was. Recording
   *    `incorrect` would enter a wrong answer into the evidence table against a
   *    learner who may well have typed the correct governor, and E5 would later
   *    discount their mastery for it. The snapshot's own
   *    `answerResolution: 'state_required'` is what lets a debrief say "you
   *    hadn't set your state yet" rather than "there was no correct answer to
   *    this question" (§6). Practice never SELECTS such a question
   *    (`question-selection.ts`), so this only fires for a question id a client
   *    posted rather than was handed — and it is recorded rather than rejected
   *    because the attempt did happen.
   *
   *  - **Otherwise** — `matchAnswer`, and nothing else. It is total over its
   *    input: an empty response, whitespace, and a megabyte of noise all get a
   *    verdict rather than an exception, so a malformed body can never turn
   *    into a 500 on a practice screen.
   *
   * Revealing does not change the outcome, and neither does a hint. Both are
   * recorded independently and weighed later (§9.1): a revealed attempt that is
   * then answered correctly grades correct, exactly as an unrevealed one does —
   * it is simply weaker evidence of recall, which is a judgement for E5 and not
   * a discount to apply here.
   */
  gradeDeterministic(
    // NARROWED FROM `RecordAttemptInput` in the move. See
    // {@link DeterministicGradingInput}: these two fields are all this rung ever
    // read, so an interview attempt can be graded without a practice DTO.
    input: DeterministicGradingInput,
    status: AnswerResolutionStatus,
    answers: readonly PracticeSnapshotAnswer[],
  ): {
    outcome: 'correct' | 'incorrect' | 'skipped';
    responseText: string | null;
  } {
    if (input.skipped) {
      return { outcome: 'skipped', responseText: null };
    }

    const responseText = input.responseText ?? null;

    if (status === 'state_required') {
      this.logger.debug(
        'Attempt against a state-scope question with no state on the profile; recorded as skipped',
      );
      return { outcome: 'skipped', responseText };
    }

    const match: AnswerMatch = matchAnswer(responseText ?? '', answers);

    return { outcome: match.outcome, responseText };
  }

  /**
   * The coach persona to write this learner's `feedback` sentence in.
   *
   * ---------------------------------------------------------------------------
   * A FAILURE TO READ SETTINGS MUST NEVER FAIL A GRADING CALL
   * ---------------------------------------------------------------------------
   *
   * That is the whole reason this is a method with a `try` around it rather
   * than an inline `await` in the argument list above. The two things this
   * request does are not equally important: the GRADE is what the learner
   * asked for, what `practice_attempts` records, and what mastery, readiness
   * and the session summary are all computed from. The TONE is a preference.
   * A `user_settings` read that times out, or a row a hand-edit left
   * unparseable, must therefore cost a learner their chosen voice for one
   * sentence — never their answer.
   *
   * So the catch is deliberately broad and deliberately silent about its
   * subject: `resolveCoachPersona(undefined)` is `supportive`, which is the
   * SAME prompt this file emitted before E14 existed, byte for byte
   * (`grading.ts`'s `buildGradingSystemMessage`). Degrading here is not a
   * partial result — it is exactly the behaviour every learner had a week ago.
   *
   * This is the identical shape rung 3 already takes one method down: an
   * unconfigured key, an exhausted account and a malformed reply all keep the
   * deterministic verdict rather than becoming a 500 on a practice screen. A
   * settings read is a weaker reason to break a session than any of those, so
   * it gets the same answer.
   *
   * ---------------------------------------------------------------------------
   * WHY THE READ HAPPENS AT ALL ON A PATH THAT ALREADY MISSED
   * ---------------------------------------------------------------------------
   *
   * It is one indexed lookup on the caller's own row, and it happens ONLY on
   * rung 2 — after `matchAnswer` has already missed and immediately before a
   * network call to a model, which is several orders of magnitude more
   * expensive. Every attempt a learner gets right on the ordinary
   * deterministic path reaches neither this read nor the grader
   * (`practice.service.ts`'s "RUNG 2, AND ONLY WHEN RUNG 1 MISSED"), so the
   * hot path is untouched.
   *
   * `readCoachPreferences` and not `getSettings`, for the reason that method's
   * own comment gives at length: `getSettings` CREATES a row on a miss, and a
   * `user_settings` row written because somebody answered a civics question is
   * a write nobody asked for, on the product's hottest path.
   *
   * LOGGED AT DEBUG, not warn. A deployment where this fails is a deployment
   * with a database problem that will announce itself far more loudly
   * elsewhere; warning per missed answer would train whoever reads these logs
   * to ignore them, which is the same argument the rung-3 log line below makes
   * for itself.
   */
  private async resolvePersona(userId: string): Promise<CoachPersonaDef> {
    try {
      const coach = await this.userSettings.readCoachPreferences(userId);

      // `resolveCoachPersona` owns "absent means supportive" for the whole
      // codebase — an absent namespace, an absent field and a key written by a
      // newer build all resolve there rather than at four call sites that
      // could each answer it differently.
      return resolveCoachPersona(coach?.persona);
    } catch (err) {
      this.logger.debug(
        `Could not read coach preferences for user ${userId}; grading in the default voice (${
          err instanceof Error ? err.message : 'unknown error'
        })`,
      );

      return resolveCoachPersona(undefined);
    }
  }

  /**
   * Rung 2 of the ladder: ask the `grader` role whether the response MEANS one
   * of the accepted answers.
   *
   * Returns `null` for "keep the deterministic result", which is both the
   * short-circuit (rung 1 matched, so no call is made) and every failure (rung
   * 3). One return value for both because from the row's point of view they are
   * the same fact: no AI opinion is attached to this attempt.
   *
   * ---------------------------------------------------------------------------
   * FOUR REASONS NOT TO CALL A MODEL AT ALL, CHECKED BEFORE ANY OF THEM IS
   * ---------------------------------------------------------------------------
   *
   *  1. **The deterministic rung already said `correct`.** `ai-evaluation.md`
   *     §6's short-circuit, and the reason it is a rule rather than an
   *     optimisation: a verified string match is a stronger verdict than a
   *     model's opinion, so there is nothing to ask, and asking anyway would
   *     spend a learner's own API credit on every right answer they give.
   *
   *  2. **The attempt was `skipped`.** There is no sentence to read. A grader
   *     handed an empty response can only report `not_known`, which the skip
   *     already says more accurately and for free.
   *
   *  3. **`state_required`.** The answer list is EMPTY — the learner has no
   *     state on their profile, so nothing could be resolved — and a prompt
   *     with no accepted answers asks a model to judge correctness from its own
   *     knowledge of U.S. civics, which is the one thing §7 forbids. The
   *     grounding rule is not a wording; it is the presence of the answers.
   *
   *  4. **A blank response.** Whitespace is not a sentence either, and
   *     `matchAnswer` has already reported it `incorrect`.
   *
   * ---------------------------------------------------------------------------
   * NOTHING THROWN FROM HERE EVER REACHES THE LEARNER
   * ---------------------------------------------------------------------------
   *
   * `runStructured` never throws — it returns `unavailable` / `failed` values
   * (`ai-evaluation.md` §3) — so the `try` is not there for it. It is there for
   * THIS method's own code: `buildGradingPrompt` throws on an empty answer list,
   * and a future edit to the guards above could reopen that path. Rung 3 already
   * has an answer for every other way this can go wrong, and a 500 on a
   * practice or mock-interview screen because a prompt builder disagreed with a
   * guard would be the one
   * failure mode §6 exists to prevent, arriving through the back door.
   *
   * ---------------------------------------------------------------------------
   * WHAT IS LOGGED: A CODE. NEVER THE RESPONSE, NEVER THE FEEDBACK.
   * ---------------------------------------------------------------------------
   *
   * The material on this path is a person's practice answer and a model's
   * commentary on it. `AiDispatchService` holds the same line one layer down;
   * this file holds it because a log line is the easiest place to lose it.
   */
  async escalateToGrader(
    userId: string,
    questionPrompt: string,
    answers: readonly PracticeSnapshotAnswer[],
    deterministic: {
      status: AnswerResolutionStatus;
      outcome: 'correct' | 'incorrect' | 'skipped';
      responseText: string | null;
    },
  ): Promise<AiGradingResult | null> {
    if (deterministic.outcome !== 'incorrect') return null;
    if (deterministic.status !== 'resolved') return null;
    if (answers.length === 0) return null;

    const responseText = deterministic.responseText ?? '';

    if (responseText.trim().length === 0) return null;

    try {
      const result = await this.dispatch.runStructured(userId, GRADER_ROLE, {
        // THE ONLY THREE THINGS A CALLER SUPPLIES. No model id, no provider, no
        // key — see `ai-evaluation.md` §3 and this file's header.
        messages: buildGradingPrompt({
          questionPrompt,
          // THE TONE, NEVER THE GRADE. Resolved from the caller's own settings
          // row, and degraded to the default rather than allowed to fail the
          // call — see {@link resolvePersona}. It reaches the SYSTEM message
          // only; the user message this builder emits is byte-identical across
          // all four personas, and `grading.spec.ts` asserts that.
          persona: await this.resolvePersona(userId),
          // The frozen snapshot's answers, which are the answers this attempt
          // was graded against a few lines ago. Not a second query: a
          // `national`/`state` question's answer can change, and a prompt built
          // from a fresh read could ask about answers the learner was never
          // shown (practice-sessions.md §6).
          acceptedAnswers: answers,
          responseText,
        }),
        schemaName: GRADING_SCHEMA_NAME,
        schema: gradingVerdictSchema,
        // NO `maxTokens`. The schema already bounds the answer — three fields,
        // one of them capped at 240 characters — and a cap tuned for that size
        // would truncate a model that thinks before it answers. A truncated
        // reply is not a short verdict; it is invalid JSON, which becomes a
        // `failed` result and silently sends every grading call down rung 3.
      });

      if (result.status !== 'ok') {
        // `unavailable` and `failed` are both rung 3, and both are ordinary. The
        // cause/code is logged at debug because a deployment with no AI
        // configured would otherwise warn on every missed answer, training
        // whoever reads the logs to ignore them.
        this.logger.debug(
          `Grader unavailable for user ${userId}; keeping the deterministic result (${
            result.status === 'unavailable' ? result.cause : result.errorCode
          })`,
        );
        return null;
      }

      // COERCED BEFORE ANYTHING IS PERSISTED. `misheard` and `nervous` cannot be
      // grounded in a typed attempt; see `grading.ts`.
      const verdict = groundVerdict(result.data);

      return {
        outcome: verdict.verdict,
        failureCause: persistedFailureCause(verdict),
        aiFeedback: verdict,
        // Null when the usage WRITE failed, never "no call was made" — the row
        // is owed on every call. The attempt is still recorded either way: the
        // evidence outlives its accounting (schema.prisma's `SetNull` on this
        // column makes the same point for the other direction).
        aiUsageEventId: result.usageEventId,
      };
    } catch (err) {
      this.logger.error(
        `Grading escalation failed for user ${userId}: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
      return null;
    }
  }

  /**
   * Advance one question's `question_mastery` row by one graded attempt,
   * inside the CALLER's own transaction (issue #78, epic #54 / E5).
   *
   * Three steps, and every one of them delegates rather than re-derives:
   *
   *  1. Read the existing row (`tx.questionMastery.findUnique`, by the
   *     `[userId, questionId]` compound unique key) and map it to a
   *     `MasteryRecord` — or `initialMasteryRecord()` when this question has
   *     never been attempted before, exactly as `scheduler.ts`'s own doc
   *     comment on that function describes.
   *  2. Call `nextSchedule` — the pure SM-2 variant (issue #75). NOTHING here
   *     re-implements or approximates its state machine; this method's only
   *     job is getting a `MasteryRecord` in and a `MasteryRecord` out.
   *  3. `upsert` the result back, keyed by the same compound unique index —
   *     `create` for a question with no prior row, `update` for one that
   *     already had one. One upsert, not a read-then-branch write, so a
   *     concurrent first attempt at the same question cannot race this method
   *     into inserting the row twice (the `@@unique([userId, questionId])`
   *     constraint would reject the loser anyway; `upsert` is what lets that
   *     loser succeed as an update instead of erroring).
   *
   * `outcome` is already the caller's `AttemptOutcome` — `recordAttempt` and
   * `selfMarkAttempt` both produce it via `mastery/outcome-mapping.ts` before
   * calling this method, so this method itself needs no knowledge of
   * `practice_attempts.outcome` or `.gradingMethod` at all.
   *
   * ---------------------------------------------------------------------------
   * STEP ZERO: THE SKIP RULE, WHICH LIVES HERE NOW (issue #245, epic #60 / E11)
   * ---------------------------------------------------------------------------
   *
   * It used to live at the call sites, and the two call sites disagreed —
   * `PracticeService.recordAttempt` refused a `state_required` attempt AND a
   * misheard one; `InterviewsService.recordApplicantTurn` refused only the
   * first. That was correct for as long as a text interview could not produce a
   * misheard attempt, and wrong the moment E11's realtime transport gave an
   * interview turn a real `asrConfidence`. `mastery/mastery-skip.ts` carries
   * the whole argument, including why the fix is one shared function rather
   * than a second `&& !misheard` copied into the interview path.
   *
   * `evidence` is REQUIRED, and that is the mechanism rather than an
   * inconvenience: the failure the old shape had was that a new call site kept
   * compiling while silently skipping a rule nothing forced it to state. A
   * required parameter makes the omission a compile error instead.
   *
   * The return value names which rule refused, or `null` when the row was
   * written. A caller that wants to log or assert on the refusal reads it;
   * one that does not can ignore it, exactly as both callers ignored the old
   * `if` statement's condition once it had served its purpose.
   *
   * A FOURTH STEP, added by issue #82 (epic #54 / E5, memory-model.md §7):
   * once the `question_mastery` row is upserted, check whether this exact
   * mastery event — this learner's CURRENT journey stage, plus the state
   * this row was in before and after this attempt — also advances
   * `learner_profiles.stage` (`oriented -> learning`, `learning ->
   * remembering`). `nextStageOnMasteryEvent` is `journey/stage-transitions.ts`'s
   * own pure decision; this method's only job is handing it the right three
   * values and, when it says to, writing the result — inside this SAME
   * transaction, never a separate one (§4's synchronous-scheduling rationale
   * applies identically to the stage write: an attempt recorded without its
   * stage consequence would be a fact that silently never reached the
   * learner's own journey state, and nothing sweeps up that gap later).
   */
  async scheduleMastery(
    // THE CALLER'S TRANSACTION CLIENT, STILL THE FIRST PARAMETER. Load-bearing,
    // and the reason this method takes a `tx` rather than reaching for
    // `this.prisma`: the caller runs it inside the SAME `$transaction` as the
    // attempt write, which is what makes the schedule and the evidence commit
    // together. See the doc comment above, and the call sites in
    // `PracticeService`.
    tx: Prisma.TransactionClient,
    userId: string,
    questionId: string,
    outcome: AttemptOutcome,
    now: Date,
    // THE FACTS THE SKIP RULE READS. Required — see the doc comment.
    evidence: MasteryEvidence,
  ): Promise<MasterySkipReason | null> {
    const skip = masterySkipReason(evidence);

    // NOTHING IS WRITTEN, AND NOTHING ELSE ABOUT THE ATTEMPT CHANGES. The row
    // is already persisted by the caller, the day's activity still accrues, and
    // the stage transition below is not reached either — a mastery event that
    // did not happen must not advance a learner's journey stage on the strength
    // of it.
    if (skip !== null) {
      this.logger.debug(
        `Mastery scheduling skipped for user ${userId} on question ${questionId} (${skip})`,
      );
      return skip;
    }

    const existing = await tx.questionMastery.findUnique({
      where: { userId_questionId: { userId, questionId } },
    });

    const current: MasteryRecord = existing
      ? {
          state: existing.state,
          dueAt: existing.dueAt,
          intervalDays: existing.intervalDays,
          ease: existing.ease,
          correctStreak: existing.correctStreak,
          lapses: existing.lapses,
          totalAttempts: existing.totalAttempts,
          distinctCorrectDays: existing.distinctCorrectDays,
          lastOutcome: fromStoredMasteryOutcome(existing.lastOutcome),
          lastAttemptAt: existing.lastAttemptAt,
        }
      : initialMasteryRecord();

    const next = nextSchedule(current, outcome, now);

    await tx.questionMastery.upsert({
      where: { userId_questionId: { userId, questionId } },
      create: {
        userId,
        questionId,
        state: next.state,
        dueAt: next.dueAt,
        intervalDays: next.intervalDays,
        ease: next.ease,
        correctStreak: next.correctStreak,
        lapses: next.lapses,
        totalAttempts: next.totalAttempts,
        distinctCorrectDays: next.distinctCorrectDays,
        lastOutcome: toStoredMasteryOutcome(outcome),
        lastAttemptAt: next.lastAttemptAt,
      },
      update: {
        state: next.state,
        dueAt: next.dueAt,
        intervalDays: next.intervalDays,
        ease: next.ease,
        correctStreak: next.correctStreak,
        lapses: next.lapses,
        totalAttempts: next.totalAttempts,
        distinctCorrectDays: next.distinctCorrectDays,
        lastOutcome: toStoredMasteryOutcome(outcome),
        lastAttemptAt: next.lastAttemptAt,
      },
    });

    // Guarded on the row existing at all rather than upserted: a practice
    // attempt is unreachable without an oriented, existing `learner_profiles`
    // row (`requireOrientedProfile`), so `findUnique` returning nothing here
    // would itself be the surprise. The guard costs one null check and
    // refuses to crash the whole attempt write over a stage nicety if that
    // invariant is ever violated.
    const learnerProfile = await tx.learnerProfile.findUnique({
      where: { userId },
      select: { stage: true },
    });

    if (learnerProfile) {
      const nextStage = nextStageOnMasteryEvent(
        learnerProfile.stage,
        current.state,
        next.state,
      );

      if (nextStage !== null) {
        await tx.learnerProfile.update({
          where: { userId },
          data: { stage: nextStage },
        });
      }
    }

    return null;
  }
}
