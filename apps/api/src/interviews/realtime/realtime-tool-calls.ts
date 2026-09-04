import {
  civicsStopReason,
  INTERVIEW_PHASES,
  nextPrompt,
  type InterviewPhase,
  type InterviewPrompt,
  type InterviewState,
} from '../engine';

// =============================================================================
// The realtime tool contract's RULES (issue #158, epic #60 / E11)
// =============================================================================
//
// `realtime-tools.ts` (#157) declares the three tools' argument SCHEMAS — what
// the model may send. This file decides what happens when one arrives, and it
// decides it as pure functions over an `InterviewState`: no NestJS, no Prisma,
// no `Clock`, no I/O, values in and values out, exactly like
// `interview-engine.ts` one directory down.
//
// That purity is the seam issue #161's scripted-sequence suite is built on, and
// it is deliberate rather than incidental. `docs/specs/realtime-interview.md`
// §10 asks for it by name: "§4's three tools are specified entirely in terms of
// `InterviewState` transitions the existing, pure `interview-engine.ts` already
// exposes... construct a state, feed it a scripted sequence of tool-call-shaped
// inputs, and assert the exact resulting question sequence, the exact stop
// reason, and the exact debrief — with no database, no network call, and no AI
// provider anywhere in the loop."
//
// -----------------------------------------------------------------------------
// THIS IS NOT A SECOND ENGINE, AND THE DIVISION IS EXACT
// -----------------------------------------------------------------------------
//
// Every decision below is either a READ of `interview-engine.ts` — `nextPrompt`,
// `civicsStopReason`, `state.stopReason`, `INTERVIEW_PHASES`' own order — or a
// refusal to act on one. Nothing here computes a phase, a question, a grade or a
// stop of its own; there is no branch that could produce an interview the text
// transport would disagree with, because both transports call the same three
// engine functions over the same persisted state (§7).
//
// -----------------------------------------------------------------------------
// NO THRESHOLD LITERAL IN THIS FILE, AND A TEST READS ITS SOURCE TO PROVE IT
// -----------------------------------------------------------------------------
//
// `interview-engine.ts`'s header states the rule as an absolute ("NO threshold
// literal anywhere in this file... not as a default, not as a fallback... not in
// a comment-shaped constant") and `interview-engine.spec.ts` enforces it by
// reading that file off disk, because the obvious behavioural test passes just
// as happily against a hardcoded default sitting on a path no test row
// exercises.
//
// `realtime-interview.md` §4.3 extends the rule to this path in the same words:
// "Pass rules come from `civics_test_versions` via `selectPassRule` — no
// threshold constant anywhere in the realtime path either." So `end_phase` asks
// `civicsStopReason` whether the civics section is over and never asks how many
// answers were right, and `realtime-tool-calls.spec.ts` reads THIS file's source
// off disk and asserts the absence, exactly as the engine's own spec does.
//
// The reason it matters more here than almost anywhere: a pass mark that adjusts
// itself by transport is a mock interview that tells a learner they are ready
// for a test it did not administer (§13's rejected "lowering the pass threshold
// for a spoken interview" row).
// =============================================================================

/**
 * The three tool names, as their own type.
 *
 * DERIVED FROM {@link RealtimeToolCall} rather than written out a second time,
 * so a fourth tool cannot exist as a call shape without also existing as a name
 * a result can be labelled with.
 */
export type RealtimeToolName = RealtimeToolCall['tool'];

/**
 * A tool call, as it reaches this application.
 *
 * The provider delivers tool calls to the browser over the realtime data
 * channel and the browser relays them here; the shapes below mirror
 * `INTERVIEW_REALTIME_TOOLS`' declared parameters and add nothing — in
 * particular, no `verdict` in any form. `interview-tool-call.dto.ts` is where
 * that is enforced at the edge, with the same compile-time proof
 * `realtime-tools.ts` puts on the schema.
 */
export type RealtimeToolCall =
  | { readonly tool: 'next_question' }
  | {
      readonly tool: 'grade_answer';
      readonly questionId: string;
      readonly transcript: string;
      readonly confidence?: number;
    }
  | { readonly tool: 'end_phase'; readonly phase: InterviewPhase };

/**
 * What the engine has asked and is waiting on an answer for.
 *
 * `null` means nothing is outstanding — either the officer has not spoken since
 * the last answer, or the phase the officer spoke in does not produce a scored
 * answer at all (see {@link RealtimeTurnContext.ungradedTurnPending}).
 *
 * TWO KINDS, because E11 conducts the E10 segments for real (§5) and their
 * evidence lives in a different table. A civics answer becomes one
 * `practice_attempts` row; a reading or writing answer becomes one
 * `english_attempts` row. `realtime-interview.md` §5: "never a
 * `practice_attempts` row, because reading and writing evidence has always
 * lived in its own table".
 */
export type OutstandingItem =
  | { readonly kind: 'civics'; readonly questionId: string }
  | {
      readonly kind: 'english';
      readonly segment: 'reading' | 'writing';
      readonly sentenceId: string;
    };

/**
 * Everything the three decisions below read. Assembled by the caller from the
 * interview row, the rebuilt engine state and the transcript's last turn.
 */
export interface RealtimeTurnContext {
  /** `mock_interviews.status`. Only `in_progress` accepts a tool call (§4.1). */
  readonly interviewStatus: string;

  /** The engine's state, rebuilt by replay. Never a stored phase. */
  readonly state: InterviewState;

  /** What the officer asked and has not been answered, or `null`. */
  readonly outstanding: OutstandingItem | null;

  /**
   * The officer has spoken in a phase that consumes an answer but SCORES
   * nothing — small talk, or the application review.
   *
   * These two phases have no tool through which the applicant's reply could
   * reach this application: `grade_answer` exists to report an answer to a
   * scored item, and #157's schemas are the contract rather than a starting
   * point (widening them here would be redeclaring them). So the applicant's
   * reply to an ungraded prompt is consumed by the NEXT `next_question` call —
   * the model has heard it, the turn genuinely happened, and the engine
   * advances — and the turn is written with empty text.
   *
   * The honest cost, stated rather than hidden: on this transport a small-talk
   * or application-review reply is not in the transcript even when the learner
   * asked for retention. Nothing is graded on it, no readiness component reads
   * it, and the alternative was a fourth tool whose only job is to carry words
   * nobody scores.
   */
  readonly ungradedTurnPending: boolean;
}

/** Why a tool call was refused. One of these, never a free-text reason. */
export type RealtimeRejectionReason =
  /** The interview is completed or abandoned (§4.1). */
  | 'interview_not_in_progress'
  /** The engine has no turn left to take; only `complete` remains (§2.5). */
  | 'interview_complete'
  /** A second question was asked before the first one's answer was graded. */
  | 'answer_outstanding'
  /** An answer arrived for a question the engine is not waiting on. */
  | 'no_answer_outstanding'
  /** An answer arrived naming a DIFFERENT item than the outstanding one. */
  | 'wrong_item'
  /** `end_phase` named a phase the interview is not past. */
  | 'phase_not_over'
  /**
   * The engine refused to serve a prompt — `nextPrompt` threw. A programming
   * error rather than an interview outcome; see {@link decideNextQuestion}.
   */
  | 'engine_refused';

/**
 * A refused call, as the model is told about it.
 *
 * `error` and `instruction` are BOTH present and they do different jobs:
 * `error` says what was wrong, `instruction` says what to do instead. §4.2 is
 * explicit that the model must be told to call `next_question` rather than
 * retry the same rejected call, "because the engine's state has not moved and
 * asking it to would only repeat the same rejection".
 *
 * Neither string is ever spoken verbatim to the learner — the standing
 * instructions tell the officer to continue without remarking on it — but both
 * are written as prose a model can act on rather than as codes it must decode.
 */
export interface RealtimeRejection {
  readonly status: 'rejected';
  readonly reason: RealtimeRejectionReason;
  readonly error: string;
  readonly instruction: string;
}

/** {@link decideNextQuestion}'s answer. */
export type NextQuestionDecision =
  | {
      readonly status: 'ok';
      /**
       * The engine's own next prompt, from `nextPrompt(state)`.
       *
       * The caller resolves its CONTENT — a question's `prompt` column, a
       * sentence's `text` — and never authors it. §4.1's "the model never
       * composes the question text itself" is that resolution being a database
       * read on this side of the tool boundary.
       */
      readonly prompt: InterviewPrompt;
      /**
       * The applicant's reply to an ungraded prompt must be recorded, and the
       * engine advanced, BEFORE `prompt` above applies.
       *
       * See {@link RealtimeTurnContext.ungradedTurnPending}. When this is true
       * the caller writes that turn first and re-derives the prompt from the
       * advanced state; `prompt` here is what the un-advanced state would say
       * and is not what gets spoken.
       */
      readonly consumeUngradedTurn: boolean;
    }
  | RealtimeRejection;

/** {@link decideGradeAnswer}'s answer. */
export type GradeAnswerDecision =
  | { readonly status: 'ok'; readonly item: OutstandingItem }
  | RealtimeRejection;

/** {@link decideEndPhase}'s answer. */
export type EndPhaseDecision =
  | {
      readonly status: 'ok';
      /** Where the interview actually is now — the engine's word, not the model's. */
      readonly nextPhase: InterviewPhase;
      /** True once the only remaining action is `complete`. */
      readonly completed: boolean;
    }
  | RealtimeRejection;

function reject(
  reason: RealtimeRejectionReason,
  error: string,
  instruction: string,
): RealtimeRejection {
  return { status: 'rejected', reason, error, instruction };
}

/**
 * The standing instruction on almost every rejection.
 *
 * One constant rather than a repeated literal, because it is the same recovery
 * in every case and a model that receives two slightly different phrasings for
 * the same situation is a model choosing between them.
 */
const CONTINUE_INSTRUCTION =
  'Call next_question and continue the interview. Do not tell the applicant anything happened.';

/**
 * `next_question` — may the officer be told what to say next? (§4.1)
 *
 * Three refusals, in the order §4.1 lists them, and the third is the one that
 * matters: **a second question may not be asked while the first one's answer is
 * still outstanding.** Without it the engine's `civicsAsked`/`civicsCorrect`
 * tally — the input to the stop rule and to `passedCivics` — would count
 * questions the learner never answered, and an interview could be "passed"
 * because the model asked faster than the applicant spoke.
 *
 * `nextPrompt` is called inside a `try`, and the catch is not defensive
 * padding. `interview-engine.ts` documents exactly one case where it throws —
 * the civics phase with no question left and the stop rule bypassed — and calls
 * it "a programming error rather than an interview outcome". On a live spoken
 * connection the honest handling of a programming error is to refuse this one
 * call and let the officer carry on, not to 500 into the middle of somebody's
 * rehearsal; the caller logs it as the fault it is.
 */
export function decideNextQuestion(
  ctx: RealtimeTurnContext,
): NextQuestionDecision {
  if (ctx.interviewStatus !== 'in_progress') {
    return reject(
      'interview_not_in_progress',
      `This interview is ${ctx.interviewStatus} and accepts no further turns.`,
      'Say a brief closing line and end the session.',
    );
  }

  if (ctx.outstanding !== null) {
    return reject(
      'answer_outstanding',
      'The applicant has not yet answered the question you last asked.',
      'Wait for the applicant to answer, then call grade_answer with what you heard.',
    );
  }

  if (ctx.state.completed) {
    return reject(
      'interview_complete',
      'There is nothing further to ask; the interview is over.',
      'Say a brief closing line and end the session.',
    );
  }

  try {
    return {
      status: 'ok',
      prompt: nextPrompt(ctx.state),
      consumeUngradedTurn: ctx.ungradedTurnPending,
    };
  } catch {
    return reject(
      'engine_refused',
      'There is no question available to ask right now.',
      CONTINUE_INSTRUCTION,
    );
  }
}

/**
 * `grade_answer` — is this an answer to the item the engine is waiting on?
 * (§4.2)
 *
 * -----------------------------------------------------------------------------
 * WHAT THIS FUNCTION DOES NOT DO IS THE POINT OF IT
 * -----------------------------------------------------------------------------
 *
 * It does not grade. It decides only WHETHER this call names the outstanding
 * item, and hands that item back so the caller can put the transcript through
 * the same ladder a typed practice answer goes through
 * (`AttemptGradingService`) or the same word-error-rate scorer a typed reading
 * attempt goes through (`english-scoring.ts`).
 *
 * There is nothing in {@link RealtimeToolCall}'s `grade_answer` variant that
 * could express an opinion about the answer, and that is not an accident to be
 * preserved by discipline: `realtime-tools.ts`'s
 * `GRADE_ANSWER_DECLARES_NO_VERDICT` is a compile-time proof over the declared
 * schema, `interview-tool-call.dto.ts` carries the same proof over the parsed
 * body, and the request DTO is a `strictObject` so an undeclared `verdict`
 * property is a 400 rather than an ignored extra. A verdict the model implies
 * in its `transcript` argument — "the constitution, which is correct" — reaches
 * the grading ladder as part of the learner's words and is graded as such,
 * which is the only place it could possibly do less harm.
 *
 * -----------------------------------------------------------------------------
 * `questionId` IS COMPARED, NOT ASSUMED
 * -----------------------------------------------------------------------------
 *
 * §4.2's rejection rule. The model names which item it is answering so an
 * out-of-order or duplicate call is DETECTABLE rather than silently attributed
 * to whatever happens to be current — the finer-grained sibling of the
 * `outcome.phase !== state.phase` check `applyAnswer` already enforces one
 * layer up. A duplicate `grade_answer` for a question already answered would
 * otherwise record a second attempt at it and move the tally the stop rule
 * reads.
 */
export function decideGradeAnswer(
  ctx: RealtimeTurnContext,
  call: Extract<RealtimeToolCall, { tool: 'grade_answer' }>,
): GradeAnswerDecision {
  if (ctx.interviewStatus !== 'in_progress') {
    return reject(
      'interview_not_in_progress',
      `This interview is ${ctx.interviewStatus} and accepts no further answers.`,
      'Say a brief closing line and end the session.',
    );
  }

  if (ctx.outstanding === null) {
    return reject(
      'no_answer_outstanding',
      'No question is waiting for an answer right now.',
      CONTINUE_INSTRUCTION,
    );
  }

  const expected =
    ctx.outstanding.kind === 'civics'
      ? ctx.outstanding.questionId
      : ctx.outstanding.sentenceId;

  if (call.questionId !== expected) {
    return reject(
      'wrong_item',
      'That is not the question the applicant was asked.',
      CONTINUE_INSTRUCTION,
    );
  }

  return { status: 'ok', item: ctx.outstanding };
}

/**
 * `end_phase` — has the engine independently agreed this phase is over? (§4.3)
 *
 * **This is the rejection rule that matters most on the whole contract**, and
 * §4.3 says why in the plainest terms the spec uses anywhere: a civics phase
 * the model could end on its own sense that "the learner seems to know this
 * material" makes "you passed the civics section" unreproducible and
 * unauditable — the single most consequential claim this product makes.
 *
 * Two branches, and NEITHER reads a number:
 *
 *   * **`civics`** — honoured only when `civicsStopReason` is non-null:
 *     `threshold_reached`, `threshold_unreachable`, or `all_asked`. That
 *     function reads `state.passRule`, which `selectPassRule` filled in from
 *     the `civics_test_versions` row at creation. `state.stopReason` is
 *     consulted first because the engine RECORDS the reason at the moment the
 *     rule fires and then advances the phase — so by the time the model gets
 *     around to calling `end_phase`, the state is ordinarily already past
 *     civics and re-running the rule against it would answer a question about
 *     the wrong phase. The `??` keeps §4.3's own wording literally true for a
 *     state still sitting in the civics phase.
 *
 *   * **Every other phase** — honoured only when the engine has actually left
 *     it, which `INTERVIEW_PHASES`' own index order is the authority on. The
 *     engine leaves a fixed-length phase when `PHASE_TURNS[phase]` turns have
 *     been taken (`applyAnswer`), so asking "is the engine past it" is the same
 *     question as "has the turn count been reached" — asked of the component
 *     that owns the answer instead of recomputed here, which is what keeps this
 *     file free of a second opinion about how long a phase runs. A model that
 *     calls `end_phase({ phase: 'n400' })` after one exchange because the
 *     conversation felt like it was winding down is told to continue.
 *
 * A completed interview honours any phase: everything is over, and the model's
 * next act is the closing line either way.
 */
export function decideEndPhase(
  ctx: RealtimeTurnContext,
  call: Extract<RealtimeToolCall, { tool: 'end_phase' }>,
): EndPhaseDecision {
  if (ctx.interviewStatus !== 'in_progress') {
    return reject(
      'interview_not_in_progress',
      `This interview is ${ctx.interviewStatus}.`,
      'Say a brief closing line and end the session.',
    );
  }

  const honoured = ctx.state.completed
    ? true
    : call.phase === 'civics'
      ? (ctx.state.stopReason ?? civicsStopReason(ctx.state)) !== null
      : INTERVIEW_PHASES.indexOf(ctx.state.phase) >
        INTERVIEW_PHASES.indexOf(call.phase);

  if (!honoured) {
    return reject(
      'phase_not_over',
      `The ${call.phase} part of the interview is not over.`,
      CONTINUE_INSTRUCTION,
    );
  }

  return {
    status: 'ok',
    nextPhase: ctx.state.phase,
    completed: ctx.state.completed,
  };
}

// -----------------------------------------------------------------------------
// Compile-time proof that an honoured result carries no verdict either
// -----------------------------------------------------------------------------
//
// `realtime-tools.ts` proves the model cannot SEND a grade. This proves the
// model is never TOLD one, which is the other half of §4.2's rule and the half
// a result type could quietly break: "internally to this application, nothing
// about the verdict is returned to the model at all".
//
// It matters because the model speaks. A `correct: true` on this result would
// reach the learner within a second, in a warm human voice, mid-rehearsal —
// and §10's "no verdict reaches the learner before `complete`" exists because
// the real event gives no per-question feedback, so a rehearsal that does is
// coaching the applicant to expect reassurance the actual interview will never
// provide.
//
// If you are here because this line went red: the field you are adding belongs
// in the debrief, which is the one place this product answers "how did I do".

type ForbiddenResultFieldNames =
  | 'verdict'
  | 'grade'
  | 'outcome'
  | 'correct'
  | 'isCorrect'
  | 'score'
  | 'passed'
  | 'passedCivics'
  | 'civicsCorrect'
  | 'assessment'
  | 'evaluation'
  | 'failureCause';

export type EndPhaseDeclaresNoVerdict = Extract<
  keyof Extract<EndPhaseDecision, { status: 'ok' }>,
  ForbiddenResultFieldNames
> extends never
  ? true
  : never;

export const END_PHASE_DECLARES_NO_VERDICT: EndPhaseDeclaresNoVerdict = true;
