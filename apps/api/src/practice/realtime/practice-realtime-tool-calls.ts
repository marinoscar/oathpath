import type { EndSessionReason } from './practice-realtime-tools';

// =============================================================================
// The realtime practice tool contract's RULES and RESULTS (issue #353, E15)
// =============================================================================
//
// `practice-realtime-tools.ts` declares the five tools' argument SCHEMAS — what
// the model may send. This file declares two things the schemas cannot:
//
//   1. WHAT COMES BACK ({@link PracticeRealtimeToolOk}, {@link PracticeRealtimeRejection}).
//   2. WHEN A CALL IS HONOURED ({@link decideNextQuestion} and its four
//      siblings) — as PURE FUNCTIONS over a small context: no NestJS, no
//      Prisma, no `Clock`, no I/O, values in and values out.
//
// That purity is the seam the scripted-sequence suite is built on
// (`practice-realtime-sequences.spec.ts`), and it is deliberate rather than
// incidental — the same split `interviews/realtime/realtime-tool-calls.ts`
// makes, for the same reason `realtime-interview.md` §10 gives: construct a
// context, feed it a scripted sequence of tool-call-shaped inputs, and assert
// the exact acceptances and refusals, with no database, no network call and no
// AI provider anywhere in the loop.
//
// -----------------------------------------------------------------------------
// WHAT THIS FILE IS NOT
// -----------------------------------------------------------------------------
//
// It is NOT the handler, and #354 is where the handler goes. Nothing here
// resolves a question, authors a spoken line, grades an answer, writes a
// `practice_attempts` row or touches `question_mastery`. In particular it does
// not re-implement any part of `PracticeService.recordAttempt`: the ladder,
// the mastery write and the supersession rule live there and stay there.
//
// That is the one scar this epic must not repeat. E8 had to reach the
// deterministic-then-AI ladder from a second surface and did it by extracting
// `AttemptGradingService` — one shared injectable, `mock-interview.md` §6's
// "so there is only one ladder in the codebase". `InterviewsService` still
// carries its own `gradeCivicsAnswer`, which assembles the snapshot, calls
// that shared ladder and returns a row shape of its own; it is correct, but it
// is a SECOND assembly of the same facts, and every rule that must hold on both
// surfaces (the `misheard` mapping, the answer snapshot, the retry link) is now
// something two files have to agree about. A realtime practice handler that
// wrote its own attempt row would be the third. #354's handler calls
// `PracticeService` and adds no grading of its own.
// =============================================================================

/**
 * A tool call, as it reaches this application.
 *
 * The provider delivers tool calls to the browser over the realtime data
 * channel and the browser relays them here; the shapes below mirror
 * `PRACTICE_REALTIME_TOOLS`' declared parameters and add nothing — in
 * particular, no verdict in any form, and no confidence.
 */
export type PracticeRealtimeToolCall =
  | { readonly tool: 'next_question' }
  | {
      readonly tool: 'grade_answer';
      readonly questionId: string;
      readonly transcript: string;
    }
  | { readonly tool: 'repeat_question' }
  | { readonly tool: 'skip_question'; readonly questionId: string }
  | { readonly tool: 'end_session'; readonly reason: EndSessionReason };

/**
 * The five tool names, as their own type.
 *
 * DERIVED FROM {@link PracticeRealtimeToolCall} rather than written out a
 * second time, so a sixth tool cannot exist as a call shape without also
 * existing as a name a result can be labelled with.
 */
export type PracticeRealtimeToolName = PracticeRealtimeToolCall['tool'];

/**
 * What the application has asked and is waiting on an answer for.
 *
 * ONE KIND, unlike the interview's `OutstandingItem`, which also carries a
 * reading or writing sentence: a practice session asks civics questions and
 * nothing else, and its evidence is one `practice_attempts` row per answer.
 */
export interface PracticeRealtimeTurnContext {
  /** `practice_sessions.status`. Only `in_progress` accepts a tool call. */
  readonly sessionStatus: string;

  /** The question that has been asked and not yet answered, or `null`. */
  readonly outstandingQuestionId: string | null;

  /**
   * How many questions this session still has to ask, INCLUDING the
   * outstanding one.
   *
   * A COUNT THE CALLER COMPUTES, never one this contract keeps: the session's
   * own planned count and its recorded attempts (with superseded rows dropped)
   * are the truth, and re-deriving it here would be a second tally that could
   * disagree with the summary screen.
   */
  readonly questionsRemaining: number;
}

/**
 * What the engine has decided happens next, as the model is told it.
 *
 * NAMES AN ACTION, NEVER AN OUTCOME. This is the field a model would reach for
 * if it wanted to know how the answer scored, and it deliberately cannot tell
 * it: `ask_next_question` is what follows a right answer, a wrong answer, a
 * skip and a mishearing alike. What the learner hears about their answer is in
 * `say`, composed by the application after grading — never inferred here.
 */
export type PracticeRealtimeThen =
  /** A question is outstanding: stop talking and listen. */
  | 'await_answer'
  /** The answer is recorded: call `next_question` when ready. */
  | 'ask_next_question'
  /** Nothing is left to ask: the session is over. */
  | 'session_complete';

/**
 * An honoured tool call, as it reaches the model.
 *
 * ---------------------------------------------------------------------------
 * TWO FIELDS CARRY EVERYTHING, AND THE THIRD IS A JOIN KEY
 * ---------------------------------------------------------------------------
 *
 *   * `say` — the lines to speak, in order, exactly as given. An ARRAY rather
 *     than one string because a single turn legitimately has more than one
 *     line (an acknowledgement, then the next question), and a client that had
 *     to split a paragraph would be deciding where a sentence ends.
 *   * `then` — the action the engine chose. See {@link PracticeRealtimeThen}.
 *   * `questionId` — which question is now outstanding, or `null`. It reveals
 *     nothing about any answer; it exists so the relay never has to guess
 *     which id a subsequent `grade_answer` must name, and never has to parse it
 *     out of the text.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS NOT ON IT IS THE LOAD-BEARING PART
 * ---------------------------------------------------------------------------
 *
 * NO `outcome`, NO `correct`, NO `score`, NO `failureCause` —
 * {@link OK_RESULT_DECLARES_NO_VERDICT} below is a compile-time proof of the
 * absence, and it closes the return direction of the same hole
 * `GRADE_ANSWER_DECLARES_NO_VERDICT_OR_CONFIDENCE` closes on the way in.
 *
 * Both directions are needed and neither is redundant. A model that cannot
 * SEND a verdict but is TOLD one has been handed the fact it needs to say
 * "that's right" in a warm voice a half-second before the application would
 * have said something more careful — and to say it on a rung-1 deterministic
 * miss that the grader was about to overturn. `docs/specs/practice-sessions.md`
 * and the reveal rules exist precisely because when a learner is told they were
 * right is a product decision; it must not become a model's.
 */
export interface PracticeRealtimeToolOk {
  readonly status: 'ok';

  /** Which call this answers. */
  readonly tool: PracticeRealtimeToolName;

  /** The lines to speak, in order, verbatim. */
  readonly say: string[];

  /** The action the engine chose. Never an outcome. */
  readonly then: PracticeRealtimeThen;

  /** The question now outstanding, or `null`. A join key, never a verdict. */
  readonly questionId: string | null;
}

/** Why a tool call was refused. One of these, never a free-text reason. */
export type PracticeRealtimeRejectionReason =
  /** The session is completed or abandoned. */
  | 'session_not_in_progress'
  /** A second question was asked before the first one's answer was recorded. */
  | 'answer_outstanding'
  /** An answer or a skip arrived while nothing was outstanding. */
  | 'no_answer_outstanding'
  /** An answer or a skip named a DIFFERENT question than the outstanding one. */
  | 'wrong_question'
  /** The session has asked everything it set out to ask. */
  | 'no_questions_left'
  /** `end_session` claimed there was nothing left, and there is. */
  | 'questions_remain';

/**
 * A refused call, as the model is told about it.
 *
 * ALWAYS AN HTTP 200 when it reaches the wire (#354's route), never a 4xx: the
 * browser relays this straight back into the realtime session as a tool
 * result, and a non-2xx would be flattened into generic failure handling by
 * the relay — losing `instruction`, which is the field that gets the session
 * moving again.
 *
 * `error` and `instruction` are BOTH present and they do different jobs:
 * `error` says what was wrong, `instruction` says what to do INSTEAD. Telling
 * a model only that its call failed invites it to retry the same call against
 * a state that has not moved, which can only produce the same refusal.
 *
 * Neither string is ever spoken verbatim to the learner — the standing
 * instructions tell the coach to continue without remarking on a refusal — but
 * both are written as prose a model can act on rather than as codes it must
 * decode.
 */
export interface PracticeRealtimeRejection {
  readonly status: 'rejected';

  /** Which call was refused. */
  readonly tool: PracticeRealtimeToolName;

  /** A stable, GROUP-able code. Never a message. */
  readonly reason: PracticeRealtimeRejectionReason;

  /** What was wrong, as prose the model can act on. */
  readonly error: string;

  /** What to do instead. */
  readonly instruction: string;
}

/** Either half of what a tool call produces. */
export type PracticeRealtimeToolResponse =
  | PracticeRealtimeToolOk
  | PracticeRealtimeRejection;

/** {@link decideNextQuestion}'s and {@link decideRepeatQuestion}'s answers. */
export type NextQuestionDecision =
  | { readonly status: 'ok' }
  | PracticeRealtimeRejection;

/** {@link decideGradeAnswer}'s and {@link decideSkipQuestion}'s answers. */
export type RecordAnswerDecision =
  | {
      readonly status: 'ok';
      /** The question the caller may record against. The OUTSTANDING one. */
      readonly questionId: string;
      /** What follows once the row is written. Never an outcome. */
      readonly then: PracticeRealtimeThen;
    }
  | PracticeRealtimeRejection;

/** {@link decideEndSession}'s answer. */
export type EndSessionDecision =
  | { readonly status: 'ok'; readonly reason: EndSessionReason }
  | PracticeRealtimeRejection;

/** Build one refusal. Private, so every refusal has the same three fields. */
function reject(
  tool: PracticeRealtimeToolName,
  reason: PracticeRealtimeRejectionReason,
  error: string,
  instruction: string,
): PracticeRealtimeRejection {
  return { status: 'rejected', tool, reason, error, instruction };
}

/** The refusal every tool shares: the session is over. */
function sessionClosed(
  tool: PracticeRealtimeToolName,
  status: string,
): PracticeRealtimeRejection {
  return reject(
    tool,
    'session_not_in_progress',
    `This practice session is ${status} and is not accepting anything further.`,
    'Tell the learner the session has ended, and stop. Do not call any more tools.',
  );
}

/**
 * `next_question`: may the coach ask for the next line?
 *
 * REFUSED WHILE AN ANSWER IS OUTSTANDING, which is the rule that keeps one
 * question in the air at a time. Without it a model that mis-heard a pause as
 * an answer could walk the whole session in one breath, and the learner's
 * `practice_attempts` rows would be a sequence of questions they never got to
 * answer.
 */
export function decideNextQuestion(
  context: PracticeRealtimeTurnContext,
): NextQuestionDecision {
  if (context.sessionStatus !== 'in_progress') {
    return sessionClosed('next_question', context.sessionStatus);
  }

  if (context.outstandingQuestionId !== null) {
    return reject(
      'next_question',
      'answer_outstanding',
      'The learner has not answered the current question yet.',
      'Wait for their answer, then call grade_answer with what you heard. If they asked ' +
        'to hear the question again, call repeat_question.',
    );
  }

  if (context.questionsRemaining <= 0) {
    return reject(
      'next_question',
      'no_questions_left',
      'This session has asked everything it set out to ask.',
      'Call end_session with the reason no_questions_left.',
    );
  }

  return { status: 'ok' };
}

/**
 * `grade_answer`: may this answer be recorded against this question?
 *
 * THE `questionId` IS COMPARED, NEVER ASSUMED. An answer naming a question the
 * session is not waiting on is refused rather than attributed to whatever is
 * current — on this path a mis-attribution is not a confusing sentence, it is a
 * `practice_attempts` row and a `question_mastery` update about a question the
 * learner was never asked.
 *
 * NOTHING HERE LOOKS AT THE TRANSCRIPT. Whether the answer was right is
 * `AttemptGradingService`'s decision, made after this function has already
 * finished deciding that the call is admissible at all.
 */
export function decideGradeAnswer(
  context: PracticeRealtimeTurnContext,
  call: { readonly questionId: string },
): RecordAnswerDecision {
  return decideRecorded('grade_answer', context, call.questionId);
}

/**
 * `skip_question`: may this skip be recorded?
 *
 * THE SAME RULES AS AN ANSWER, because a skip IS an answer as far as the
 * evidence table is concerned: `practice_attempts.outcome: 'skipped'` is a row,
 * and it schedules. The difference between the two lives entirely in what
 * #354's handler passes to `PracticeService.recordAttempt`.
 *
 * The instruction that keeps a skip honest is not here — it is in the session's
 * standing instructions and in the tool's own description, both of which state
 * the NEGATIVE case ("never because you did not hear an answer"). No rule in
 * this file can tell a genuine skip from a mis-heard silence; that is exactly
 * why the prompt says it twice.
 */
export function decideSkipQuestion(
  context: PracticeRealtimeTurnContext,
  call: { readonly questionId: string },
): RecordAnswerDecision {
  return decideRecorded('skip_question', context, call.questionId);
}

/** The shared body of the two tools that write a row. */
function decideRecorded(
  tool: 'grade_answer' | 'skip_question',
  context: PracticeRealtimeTurnContext,
  questionId: string,
): RecordAnswerDecision {
  if (context.sessionStatus !== 'in_progress') {
    return sessionClosed(tool, context.sessionStatus);
  }

  if (context.outstandingQuestionId === null) {
    return reject(
      tool,
      'no_answer_outstanding',
      'No question is waiting to be answered.',
      'Call next_question and say what it returns.',
    );
  }

  if (questionId !== context.outstandingQuestionId) {
    return reject(
      tool,
      'wrong_question',
      'That is not the question the learner is answering.',
      'Use the question id the last tool result gave you, or call repeat_question to hear ' +
        'the outstanding question again.',
    );
  }

  return {
    status: 'ok',
    questionId: context.outstandingQuestionId,
    // ONE FEWER, because this call consumes the outstanding question. Computed
    // from the count the caller supplied rather than from anything about the
    // answer: a wrong answer and a right one leave exactly the same number of
    // questions to ask.
    then: context.questionsRemaining - 1 > 0 ? 'ask_next_question' : 'session_complete',
  };
}

/**
 * `repeat_question`: may the outstanding question be said again?
 *
 * WRITES NOTHING AND COSTS NOTHING. It earns its slot because a session
 * re-minted after a dropped connection has a model with no context at all —
 * this is the re-sync path, and without it the model's only options would be to
 * invent the question or to call `next_question`, which would abandon an
 * outstanding one.
 *
 * Refused when nothing is outstanding, because there is nothing to repeat.
 */
export function decideRepeatQuestion(
  context: PracticeRealtimeTurnContext,
): NextQuestionDecision {
  if (context.sessionStatus !== 'in_progress') {
    return sessionClosed('repeat_question', context.sessionStatus);
  }

  if (context.outstandingQuestionId === null) {
    return reject(
      'repeat_question',
      'no_answer_outstanding',
      'No question is waiting to be answered, so there is nothing to repeat.',
      'Call next_question and say what it returns.',
    );
  }

  return { status: 'ok' };
}

/**
 * `end_session`: is the session really over?
 *
 * `learner_asked` IS BELIEVED. It is a report of something that happened in the
 * room, the model is the only witness to it, and refusing a learner who asked
 * to stop would be the product overruling them about their own time.
 *
 * `no_questions_left` IS VERIFIED, because it is a claim about the
 * application's own state, which the application can check — and a model that
 * could end a session by asserting it would be able to cut a session short and
 * have the summary screen agree with it.
 */
export function decideEndSession(
  context: PracticeRealtimeTurnContext,
  call: { readonly reason: EndSessionReason },
): EndSessionDecision {
  if (context.sessionStatus !== 'in_progress') {
    return sessionClosed('end_session', context.sessionStatus);
  }

  if (call.reason === 'no_questions_left' && context.questionsRemaining > 0) {
    return reject(
      'end_session',
      'questions_remain',
      'This session still has questions to ask.',
      'Carry on: call next_question and say what it returns. Do not tell the learner ' +
        'anything about this.',
    );
  }

  return { status: 'ok', reason: call.reason };
}

// -----------------------------------------------------------------------------
// Compile-time proof that no verdict can travel back to the model
// -----------------------------------------------------------------------------
//
// The mirror of `practice-realtime-tools.ts`' proof, pointed the other way
// across the tool boundary. That one keeps a grade out of what the model SENDS;
// this one keeps a grade out of what it is TOLD.
//
// If you are here because this line went red: you are about to let a
// speech-to-speech model know how an answer scored, in the moment, before the
// application has decided what to say about it. `say` is the field for what the
// learner hears; it is composed after grading, by code, and a model reading a
// scalar beside it will speak to that scalar instead.
//
// `questionId` and `then` are deliberately not on the list. The first is a join
// key; the second names an action that is IDENTICAL for a right answer, a wrong
// one, a skip and a mishearing.

/** Every key of every member of a union, distributed. */
type KeysOfUnion<T> = T extends unknown ? keyof T : never;

type ForbiddenResultFieldNames =
  | 'outcome'
  | 'correct'
  | 'isCorrect'
  | 'score'
  | 'failureCause'
  | 'verdict'
  | 'grade'
  | 'passed'
  | 'result'
  | 'assessment'
  | 'evaluation'
  | 'confidence'
  | 'asrConfidence'
  | 'acceptedAnswers'
  | 'answers'
  | 'aiFeedback';

export type OkResultDeclaresNoVerdict = Extract<
  KeysOfUnion<PracticeRealtimeToolOk>,
  ForbiddenResultFieldNames
> extends never
  ? true
  : never;

export const OK_RESULT_DECLARES_NO_VERDICT: OkResultDeclaresNoVerdict = true;
