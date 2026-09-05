import type { Prisma } from '@prisma/client';

import type { AnswerResolutionStatus } from '../../civics/answer-resolution';
import { masterySkipReason, type MasteryEvidence } from './mastery-skip';
import { toAttemptOutcome, toStoredMasteryOutcome } from './outcome-mapping';
import {
  initialMasteryRecord,
  nextSchedule,
  type MasteryRecord,
} from './scheduler';

// =============================================================================
// recomputeMasteryForQuestion (issue #285, epic #280)
// =============================================================================
//
// Rebuild ONE question's `question_mastery` row from scratch, by replaying
// every `practice_attempts` row this learner has ever recorded against that
// question — skipping the ones a retry superseded, and the ones
// `mastery/mastery-skip.ts` refuses.
//
// -----------------------------------------------------------------------------
// WHY THIS EXISTS: SUPERSESSION WAS ONLY EVER HALF-ENFORCED
// -----------------------------------------------------------------------------
//
// `docs/specs/voice.md` §3.2 says a superseded attempt "must not be COUNTED",
// and until this issue that rule was enforced in exactly one place —
// `dropSuperseded` in `practice.service.ts`, which filters a SESSION SUMMARY's
// counts. Spaced repetition had no equivalent. A superseded attempt that had
// already been scheduled stayed scheduled: its `correctStreak` reset, its
// `lapses` increment, its `state` regression and its pulled-in `dueAt` were
// all still sitting in `question_mastery`, and the retry that corrected it
// scheduled FORWARD from that damage rather than replacing it. The learner's
// number was right on the summary screen and permanently wrong in the
// scheduler.
//
// That gap was invisible for as long as a superseded attempt was, in practice,
// always a MISHEARD one — `masterySkipReason` refuses those, so nothing was
// ever scheduled to undo. Epic #280 removes the confirm-the-transcript step
// and auto-submits a spoken answer the moment recording stops, and that is the
// change that makes the gap reachable: accented speech routinely transcribes
// CONFIDENTLY and wrongly. A confidence of 0.9 on a wrong transcript is not
// `misheard` by `isMisheardAttempt`'s (correct, deliberate) three conditions —
// unknown is not low and neither is high — so the attempt IS scheduled, and
// the learner is charged a lapse for their accent.
//
// `VISION.md` line 228 — a learner may "practice without being unfairly
// penalized for accent or speech-recognition errors" — is the promise that
// breaks, and it breaks in the one place a learner can never see or appeal:
// the interval that decides when they are asked again.
//
// -----------------------------------------------------------------------------
// WHY A REPLAY RATHER THAN AN "UNDO"
// -----------------------------------------------------------------------------
//
// The alternative was to invert `nextSchedule` for the superseded attempt —
// give the streak back, decrement `lapses`, push `dueAt` out again. That is not
// possible, and not merely awkward: `nextSchedule` is lossy. `MasteryRecord`
// keeps one `lastOutcome` and one `lastAttemptAt`, so the ease it would have
// had, the interval it grew from, and whether a given day was already counted
// toward `distinctCorrectDays` are all unrecoverable from the row alone. An
// approximate inverse would leave a learner in a state no sequence of real
// attempts could have produced.
//
// A replay has no such problem, because `practice_attempts` is the evidence
// table and it is complete: every attempt that ever happened is still there
// (this codebase deletes no evidence — voice.md §3.2), so the honest question
// "what would this row be if the superseded attempt had never been recorded?"
// has an exact answer. This function computes it.
//
// -----------------------------------------------------------------------------
// WHAT IT DELIBERATELY DOES NOT DO
// -----------------------------------------------------------------------------
//
// **It writes NOTHING but `question_mastery`.** Specifically, it does not
// re-run `nextStageOnMasteryEvent` — the journey-stage transition
// `AttemptGradingService.scheduleMastery` fires alongside its own write.
// Stage transitions are MONOTONIC and already happened; a replay walks the
// whole history, so re-firing them would raise the same event once per
// historical attempt, writing a fact that this correction is not correcting.
// `learner_profiles` is not read, not written, and not reachable from here.
//
// **It does not touch `practice_attempts`.** The superseded row keeps its
// `outcome`, its `failure_cause` and its place in the table. What changes is
// what the scheduler DERIVES from it, which is nothing — an evidence ledger
// whose rows can be removed to improve a number is not an evidence ledger.
//
// **It does not need a migration or a backfill.** Every attempt superseded
// before epic #280 was superseded because it was misheard, and a misheard
// attempt was never scheduled in the first place, so there is no historical
// damage to repair.
//
// -----------------------------------------------------------------------------
// TWO DETAILS THAT ARE EASY TO GET WRONG, AND ARE WRONG SILENTLY
// -----------------------------------------------------------------------------
//
// 1. **`now` is each attempt's OWN `answeredAt`, never a clock read.** See the
//    loop below. This is why the function takes no `Clock` and constructs no
//    `Date` at all.
// 2. **The outcome handed to `nextSchedule` comes from `toAttemptOutcome`**,
//    which reads `gradingMethod` as well as `outcome`. See the loop below.
//
// -----------------------------------------------------------------------------
// WHY THE SUPERSESSION SET IS BUILT HERE RATHER THAN BY `dropSuperseded`
// -----------------------------------------------------------------------------
//
// The rule is identical and is stated once in prose in `dropSuperseded`'s own
// doc comment (`practice.service.ts`): a row named by any loaded row's
// `retryOfAttemptId` is superseded. It is not IMPORTED because
// `practice.service.ts` imports this module — reaching back the other way
// would make the two files a require cycle, for a three-line `Set` build over
// a different row shape. If a third caller ever needs it, the fix is to move
// `dropSuperseded` into this module and have `practice.service.ts` import it,
// not to add a second copy of the prose.
// =============================================================================

/**
 * The columns a replay reads, and no others.
 *
 * Narrow on purpose: an attempt row carries a transcript, a grader's feedback
 * and a learner's typed response, none of which the scheduler has any business
 * seeing. These seven are what {@link masterySkipReason},
 * {@link toAttemptOutcome} and {@link nextSchedule} need between them.
 */
const REPLAY_SELECT = {
  id: true,
  outcome: true,
  gradingMethod: true,
  answeredAt: true,
  asrConfidence: true,
  answerSnapshot: true,
  retryOfAttemptId: true,
} as const;

/**
 * The frozen snapshot's `answerResolution`, read defensively.
 *
 * `practice_attempts.answerSnapshot` is `NOT NULL` and is only ever written
 * from `AttemptGradingService.resolveAcceptedAnswers`' own `status`, so the key
 * is always there — but this is a `Json` column, which means the compiler
 * cannot say so and a single malformed row would otherwise throw mid-replay
 * and fail the attempt write that triggered it.
 *
 * ONLY THE LITERAL `'state_required'` REFUSES. Anything unreadable falls back
 * to `'resolved'`, which is the direction that preserves evidence: a snapshot
 * this function cannot parse is not a reason to silently drop a real attempt
 * out of a learner's history. It also reproduces exactly what
 * `scheduleMastery` decided when the row was first written, since it read the
 * same `status` that was frozen into the snapshot in the same breath.
 */
function snapshotAnswerResolution(snapshot: unknown): AnswerResolutionStatus {
  if (snapshot !== null && typeof snapshot === 'object' && !Array.isArray(snapshot)) {
    if ((snapshot as { answerResolution?: unknown }).answerResolution === 'state_required') {
      return 'state_required';
    }
  }

  return 'resolved';
}

/**
 * Rebuild `question_mastery` for one `(user, question)` pair from the full
 * attempt history, inside the CALLER's transaction.
 *
 * `tx` is the first parameter for the same reason it is on
 * `AttemptGradingService.scheduleMastery`: the caller runs this inside the very
 * `$transaction` that wrote the attempt being replayed, so the corrected
 * schedule and the evidence it was derived from commit together. A recompute
 * that committed separately could be read — by `nextQuestionFor`, a few lines
 * later in `recordAttempt` — in between.
 *
 * Idempotent and total: same rows in, same row out, however many times it runs.
 * That is what makes it safe to call after `scheduleMastery` has already
 * written its own (incremental, superseded-attempt-including) answer — this
 * function is the authority and its result overwrites.
 */
export async function recomputeMasteryForQuestion(
  tx: Prisma.TransactionClient,
  userId: string,
  questionId: string,
): Promise<void> {
  const attempts = await tx.practiceAttempt.findMany({
    where: { userId, questionId },
    // ASCENDING, and totally ordered. `answeredAt` alone can tie — two attempts
    // in one interactive transaction share a single `Clock` read — and a fold
    // whose order depends on the database's tie-breaking is a fold that can
    // return two different `question_mastery` rows for the same evidence.
    orderBy: [{ answeredAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    select: REPLAY_SELECT,
  });

  // SUPERSEDED = named by some other loaded row's `retryOfAttemptId`. Every
  // attempt at this question is in `attempts` (the query is filtered by
  // `questionId`, not by session), so a superseder is never missed.
  const supersededIds = new Set<string>(
    attempts
      .map((attempt) => attempt.retryOfAttemptId)
      .filter((id): id is string => typeof id === 'string'),
  );

  let record: MasteryRecord = initialMasteryRecord();
  let scheduled = 0;

  for (const attempt of attempts) {
    // §3.2's rule, applied to spaced repetition for the first time. The row
    // stays in the table; it simply never reaches the scheduler.
    if (supersededIds.has(attempt.id)) continue;

    const evidence: MasteryEvidence = {
      answerResolution: snapshotAnswerResolution(attempt.answerSnapshot),
      // The FOUR-value column value, which is what `MasteryEvidence` asks for
      // — never the scheduler's three-value `AttemptOutcome`. See that type.
      outcome: attempt.outcome,
      asrConfidence: attempt.asrConfidence,
    };

    // THE SAME RULE `scheduleMastery` READS, not a replica of it. A replay that
    // scheduled an attempt the live path refuses (or refused one it schedules)
    // would make the corrected row disagree with every uncorrected row in the
    // table.
    if (masterySkipReason(evidence) !== null) continue;

    record = nextSchedule(
      record,
      // DETAIL 2 FROM THE HEADER. `gradingMethod` is what distinguishes a
      // self-mark from a verified match, and `toAttemptOutcome` is the one
      // place that mapping lives. Passing `attempt.outcome` straight through
      // would replay every self-marked attempt in the history as a full
      // `correct` — silently restoring the ease bump and interval growth that
      // `scheduler.ts`'s own header halves on purpose.
      toAttemptOutcome(attempt.outcome, attempt.gradingMethod),
      // DETAIL 1 FROM THE HEADER, AND THE SINGLE EASIEST THING TO GET WRONG
      // HERE. `now` is THIS attempt's `answeredAt`, not the current clock and
      // not one instant shared by the whole replay. `nextSchedule` uses it
      // twice: for `dueAt = addDays(now, interval)`, and for the
      // same-UTC-calendar-day lookback that decides whether
      // `distinctCorrectDays` increments. Replaying with a single `now` would
      // collapse a history spread over weeks into one calendar day — a
      // learner who had earned three distinct correct days would drop to one,
      // losing a `mastered` promotion — and would compute `dueAt` from the
      // wrong instant on top of it.
      attempt.answeredAt,
    );
    scheduled += 1;
  }

  if (scheduled === 0) {
    // NO ROW MEANS `new`, and `new` is NEVER represented by a row that says so
    // (`docs/specs/memory-model.md` §2). If every attempt at this question was
    // superseded or refused, then nothing schedulable has ever happened here
    // and the honest record is the absence of one.
    //
    // `deleteMany` rather than `delete`: there is usually no row to remove
    // (the refused attempts never wrote one), and `delete` on a missing row is
    // a `P2025` that would roll back the caller's whole attempt write.
    await tx.questionMastery.deleteMany({ where: { userId, questionId } });
    return;
  }

  const data = {
    state: record.state,
    dueAt: record.dueAt,
    intervalDays: record.intervalDays,
    ease: record.ease,
    correctStreak: record.correctStreak,
    lapses: record.lapses,
    totalAttempts: record.totalAttempts,
    distinctCorrectDays: record.distinctCorrectDays,
    // `record.lastOutcome` is non-null whenever `scheduled > 0`; the ternary is
    // for the compiler, which cannot know that. `toStoredMasteryOutcome` is
    // what collapses `correct_self_marked` back to a value the four-value
    // `PracticeOutcome` column can actually hold — see `outcome-mapping.ts`.
    lastOutcome:
      record.lastOutcome === null ? null : toStoredMasteryOutcome(record.lastOutcome),
    lastAttemptAt: record.lastAttemptAt,
  };

  // One upsert, keyed by the same compound unique index `scheduleMastery` uses,
  // for the same reason: the row may or may not exist, and a read-then-branch
  // write could lose the race to a concurrent first attempt.
  await tx.questionMastery.upsert({
    where: { userId_questionId: { userId, questionId } },
    create: { userId, questionId, ...data },
    update: data,
  });
}
