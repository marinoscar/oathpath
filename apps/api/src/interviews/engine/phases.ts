// =============================================================================
// Interview phases (issue #123, epic #57 / E8 "Mock interview — text mode")
// =============================================================================
//
// The shape of one rehearsal, expressed as data rather than as control flow
// scattered through a service. Pure TypeScript — no NestJS, no Prisma, no
// `Clock`, no I/O of any kind — the same posture
// `practice/mastery/scheduler.ts` and `readiness/readiness-engine.ts` take,
// and for the same reason: the sequence of an interview is a rule that must
// produce the same answer for the same inputs forever, and must be readable
// and testable without a database in the loop.
//
// -----------------------------------------------------------------------------
// THE ORDER IS THE CONTRACT
// -----------------------------------------------------------------------------
//
// `INTERVIEW_PHASES` is not a convenience list — it is the sequence the engine
// walks, one entry at a time, with no way to reach a phase out of turn.
// `interview-engine.ts` advances by index into this array, so reordering it
// reorders every interview, and inserting a phase inserts it into every
// interview. That is deliberate: one array is the only place the shape of a
// rehearsal is stated, exactly as `READINESS_COMPONENT_KEYS` is the only place
// the readiness components' order is stated.
// =============================================================================

/**
 * The six phases of a mock interview, in the order they are conducted.
 *
 * `reading` and `writing` are DECLARED AND SKIPPED in text mode — see
 * {@link SKIPPED_PHASES}.
 */
export const INTERVIEW_PHASES = [
  'smalltalk',
  'n400',
  'civics',
  'reading',
  'writing',
  'closing',
] as const;

export type InterviewPhase = (typeof INTERVIEW_PHASES)[number];

/**
 * The two phases text mode cannot conduct, because it has no content for them
 * yet — E10 supplies the reading and writing sentence banks.
 *
 * -----------------------------------------------------------------------------
 * STILL SKIPPED IN TEXT MODE. NO LONGER SKIPPED BY VOICE (issue #158, E11)
 * -----------------------------------------------------------------------------
 *
 * The paragraph below ends "when E10 supplies the content, the phases are
 * already in the sequence... the change is what happens inside the phase, not
 * whether the phase exists." That moment has arrived for one transport:
 * `docs/specs/realtime-interview.md` §5 has a realtime interview conduct both
 * segments for real, against the same `english_sentences` bank
 * `/practice/reading` and `/practice/writing` use.
 *
 * NOTHING IN THIS FILE CHANGED FOR IT, which is the design working as
 * intended. The engine still emits `skipped_segment` for both phases and this
 * array still names them; whether the walk STOPS there — awaiting a real
 * answer — is a decision `InterviewsService`'s own officer driver makes from
 * the transport and the transcript, one layer up. The text transport still
 * announces both as skipped, with the same honest line, unchanged.
 *
 * -----------------------------------------------------------------------------
 * WHY SKIPPED-AND-NAMED, NEVER SILENTLY OMITTED
 * -----------------------------------------------------------------------------
 *
 * The cheap implementation is to leave these two out of `INTERVIEW_PHASES`
 * until E10 lands, and the cheap implementation is wrong, for one reason that
 * outranks the tidiness: **a debrief must be able to say what was NOT
 * covered.** A learner who completes a rehearsal that ran small talk, N-400
 * questions, civics and a closing, and is then told they did well, has no way
 * to know that the real interview also contains a reading test and a writing
 * test they have never seen. They may reasonably believe they rehearsed a
 * segment they never saw — and the closer their interview date, the more
 * expensive that belief is.
 *
 * So the engine walks these phases like any other, emits one honest officer
 * turn per phase saying this rehearsal does not include that test, and marks
 * the phase skipped. The absence is a fact the transcript records, not a gap
 * the transcript is silent about. When E10 supplies the content, the phases
 * are already in the sequence, already in the transcript, and already in every
 * debrief that has been written against them: the change is what happens
 * inside the phase, not whether the phase exists.
 */
export const SKIPPED_PHASES = ['reading', 'writing'] as const;

/** A phase text mode names but cannot conduct — see {@link SKIPPED_PHASES}. */
export type SkippedPhase = (typeof SKIPPED_PHASES)[number];

/** Whether this phase is one text mode names but cannot conduct. */
export function isSkippedPhase(phase: InterviewPhase): phase is SkippedPhase {
  return (SKIPPED_PHASES as readonly InterviewPhase[]).includes(phase);
}

// -----------------------------------------------------------------------------
// PER-PHASE TURN COUNTS — COUNTS OF TURNS, NOT THRESHOLDS
// -----------------------------------------------------------------------------
//
// Read the next four constants as "how many exchanges this phase lasts", and
// nothing else. NONE of them is a pass mark, a score, a question count, or a
// number of correct answers required for anything. The number of civics
// questions asked (N) and the number that must be correct to pass (T) are read
// from a `civics_test_versions` row by `selectPassRule` in
// `interview-engine.ts`, which is the only place either one is ever decided —
// that file contains no threshold literal at all, and a test reads its source
// off disk to keep it that way.
//
// The distinction is worth stating rather than leaving to the reader, because
// a constant named `SMALLTALK_TURNS = 1` sitting a few lines from a pass rule
// is exactly the sort of number a later reader reaches for when they want "the
// number of something" and do not check which something. These are turns.

/**
 * How many small-talk exchanges open the interview. A count of turns, not a
 * threshold.
 */
export const SMALLTALK_TURNS = 1;

/**
 * How many generic N-400 rehearsal prompts are asked. A count of turns, not a
 * threshold — and specifically NOT a number of application questions a learner
 * must answer correctly, because these prompts are not graded at all
 * (`officer-lines.ts` explains why they ask for no real data).
 */
export const N400_TURNS = 3;

/**
 * How many officer turns a skipped segment produces: one, saying plainly that
 * this rehearsal does not include that test. A count of turns, not a
 * threshold, and it consumes no learner answer.
 */
export const SKIPPED_SEGMENT_TURNS = 1;

/** How many turns close the interview. A count of turns, not a threshold. */
export const CLOSING_TURNS = 1;

/**
 * The fixed turn count of every phase whose length is known in advance.
 *
 * `civics` is deliberately absent: its length is not a constant at all. It is
 * whatever the version row's N, the version row's T and the learner's answers
 * produce, and the stop rule in `interview-engine.ts` decides it one answer at
 * a time. Giving `civics` an entry here — even a placeholder — would create a
 * second opinion about how long the civics phase runs, which is precisely the
 * drift this file exists to prevent.
 */
export const PHASE_TURNS: Record<Exclude<InterviewPhase, 'civics'>, number> = {
  smalltalk: SMALLTALK_TURNS,
  n400: N400_TURNS,
  reading: SKIPPED_SEGMENT_TURNS,
  writing: SKIPPED_SEGMENT_TURNS,
  closing: CLOSING_TURNS,
};
