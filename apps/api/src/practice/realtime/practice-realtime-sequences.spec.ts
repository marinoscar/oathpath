import {
  decideEndSession,
  decideGradeAnswer,
  decideNextQuestion,
  decideRepeatQuestion,
  decideSkipQuestion,
  type PracticeRealtimeToolCall,
  type PracticeRealtimeTurnContext,
} from './practice-realtime-tool-calls';
import { PRACTICE_REALTIME_TOOL_NAMES } from './practice-realtime-tools';

// =============================================================================
// Scripted realtime practice sequences (issue #353, epic #345 / E15)
// =============================================================================
//
// The suite the pure/impure split exists for. `realtime-interview.md` §10 asks
// for exactly this shape on the interview side — "construct a state, feed it a
// scripted sequence of tool-call-shaped inputs, and assert the exact resulting
// question sequence... with no database, no network call, and no AI provider
// anywhere in the loop" — and it is worth more here than there, because on this
// transport a mis-ordered tool call does not merely produce a strange sentence:
// it produces a `practice_attempts` row and a `question_mastery` update.
//
// -----------------------------------------------------------------------------
// WHAT THE DRIVER BELOW IS, AND WHAT IT DELIBERATELY IS NOT
// -----------------------------------------------------------------------------
//
// `run` is a fifteen-line state machine over the same three fields the rules
// read: which question is outstanding, how many are left, and whether the
// session is open. It advances that state exactly as #354's handler will —
// serve a question, consume it on an answer or a skip, change nothing on a
// repeat or a refusal.
//
// IT GRADES NOTHING. There is no outcome anywhere in this file, no transcript
// that is "right" and none that is "wrong", and that is the property being
// demonstrated rather than a simplification: the sequence a session takes is
// identical for a learner who answers everything correctly and one who answers
// nothing correctly, because the model is never told which happened. A driver
// that needed a verdict to know what came next would be evidence the contract
// leaks one.
// =============================================================================

const Q = (index: number) =>
  `q-${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`;

/** One line of the transcript a scripted run produces. */
type Step = string;

interface RunResult {
  /** What each call produced, in order: `tool:ok` or `tool:rejected:reason`. */
  readonly steps: Step[];
  /** The questions that were actually served, in order. */
  readonly asked: string[];
  /** The context the run finished in. */
  readonly context: PracticeRealtimeTurnContext;
}

/**
 * Drive a scripted sequence of tool calls through the pure rules.
 *
 * `plannedCount` is the only number the session starts with; the questions are
 * served in order by the driver, standing in for `mastery/selector.ts`, which
 * the model has no way to influence — there is no argument on `next_question`
 * through which it could ask for a different one, which is why a driver that
 * ignores the model entirely is a faithful stand-in.
 */
function run(
  plannedCount: number,
  calls: PracticeRealtimeToolCall[],
): RunResult {
  let context: PracticeRealtimeTurnContext = {
    sessionStatus: 'in_progress',
    outstandingQuestionId: null,
    questionsRemaining: plannedCount,
  };

  const steps: Step[] = [];
  const asked: string[] = [];
  let served = 0;

  for (const call of calls) {
    switch (call.tool) {
      case 'next_question': {
        const decision = decideNextQuestion(context);
        if (decision.status !== 'ok') {
          steps.push(`next_question:rejected:${decision.reason}`);
          break;
        }

        served += 1;
        const questionId = Q(served);
        asked.push(questionId);
        context = { ...context, outstandingQuestionId: questionId };
        steps.push('next_question:ok');
        break;
      }

      case 'grade_answer':
      case 'skip_question': {
        const decision =
          call.tool === 'grade_answer'
            ? decideGradeAnswer(context, call)
            : decideSkipQuestion(context, call);

        if (decision.status !== 'ok') {
          steps.push(`${call.tool}:rejected:${decision.reason}`);
          break;
        }

        // ONE ROW IS WRITTEN HERE, in the real handler. The driver records
        // only that the question was consumed — what the row SAYS is the
        // grading ladder's business and reaches neither the rules nor the
        // model.
        context = {
          ...context,
          outstandingQuestionId: null,
          questionsRemaining: context.questionsRemaining - 1,
        };
        steps.push(`${call.tool}:ok:${decision.then}`);
        break;
      }

      case 'repeat_question': {
        const decision = decideRepeatQuestion(context);
        steps.push(
          decision.status === 'ok'
            ? 'repeat_question:ok'
            : `repeat_question:rejected:${decision.reason}`,
        );
        break;
      }

      case 'end_session': {
        const decision = decideEndSession(context, call);
        if (decision.status !== 'ok') {
          steps.push(`end_session:rejected:${decision.reason}`);
          break;
        }

        context = { ...context, sessionStatus: 'completed' };
        steps.push(`end_session:ok:${decision.reason}`);
        break;
      }
    }
  }

  return { steps, asked, context };
}

/** Ask, answer, ask, answer… for `count` questions. */
function walk(count: number, transcript = 'an answer'): PracticeRealtimeToolCall[] {
  return Array.from({ length: count }, (_, index) => [
    { tool: 'next_question' } as const,
    {
      tool: 'grade_answer' as const,
      questionId: Q(index + 1),
      transcript,
    },
  ]).flat();
}

describe('a scripted realtime practice session', () => {
  it('walks a five-question session and ends when there is nothing left', () => {
    const result = run(5, [
      ...walk(5),
      { tool: 'end_session', reason: 'no_questions_left' },
    ]);

    expect(result.asked).toEqual([Q(1), Q(2), Q(3), Q(4), Q(5)]);
    expect(result.steps).toEqual([
      'next_question:ok',
      'grade_answer:ok:ask_next_question',
      'next_question:ok',
      'grade_answer:ok:ask_next_question',
      'next_question:ok',
      'grade_answer:ok:ask_next_question',
      'next_question:ok',
      'grade_answer:ok:ask_next_question',
      'next_question:ok',
      // THE LAST ANSWER SAYS `session_complete`, and it says it because the
      // COUNT ran out — not because of anything about the answer.
      'grade_answer:ok:session_complete',
      'end_session:ok:no_questions_left',
    ]);
  });

  it('takes the identical path whatever the learner actually said', () => {
    // The demonstration that no verdict leaks: two runs whose transcripts
    // could not be more different produce the same sequence, question for
    // question and step for step.
    const confident = run(3, walk(3, 'the constitution'));
    const hopeless = run(3, walk(3, 'i do not know'));
    const silent = run(3, walk(3, ''));

    expect(confident.steps).toEqual(hopeless.steps);
    expect(confident.steps).toEqual(silent.steps);
    expect(confident.asked).toEqual(hopeless.asked);
  });

  it('refuses a second question while the first is unanswered, and recovers', () => {
    // The model gets ahead of itself — a mis-heard pause, a duplicate tool
    // call — and is told what to do instead rather than left to retry.
    const result = run(3, [
      { tool: 'next_question' },
      { tool: 'next_question' },
      { tool: 'grade_answer', questionId: Q(1), transcript: 'an answer' },
      { tool: 'next_question' },
    ]);

    expect(result.steps).toEqual([
      'next_question:ok',
      'next_question:rejected:answer_outstanding',
      'grade_answer:ok:ask_next_question',
      'next_question:ok',
    ]);
    // AND THE REFUSAL COST NOTHING: the second question was not served, so the
    // session is on its second question rather than its third.
    expect(result.asked).toEqual([Q(1), Q(2)]);
  });

  it('refuses an answer to a question the session is not waiting on', () => {
    // The out-of-order case: a `grade_answer` naming the question BEFORE the
    // outstanding one. Attributed rather than refused, it would put an answer
    // on a question that was already recorded and reschedule it.
    const result = run(3, [
      { tool: 'next_question' },
      { tool: 'grade_answer', questionId: Q(1), transcript: 'an answer' },
      { tool: 'next_question' },
      { tool: 'grade_answer', questionId: Q(1), transcript: 'said again' },
      { tool: 'grade_answer', questionId: Q(2), transcript: 'an answer' },
    ]);

    expect(result.steps).toEqual([
      'next_question:ok',
      'grade_answer:ok:ask_next_question',
      'next_question:ok',
      'grade_answer:rejected:wrong_question',
      'grade_answer:ok:ask_next_question',
    ]);
    // The refused call consumed nothing: two questions asked, two answered.
    expect(result.context.questionsRemaining).toBe(1);
  });

  it('re-syncs a model with no context through repeat_question', () => {
    // The dropped-connection case §353 gives `repeat_question` its slot for: a
    // session re-minted mid-question has a model that has never heard the
    // question. Repeating writes nothing and consumes nothing, however many
    // times it happens.
    const result = run(2, [
      { tool: 'next_question' },
      { tool: 'repeat_question' },
      { tool: 'repeat_question' },
      { tool: 'grade_answer', questionId: Q(1), transcript: 'an answer' },
    ]);

    expect(result.steps).toEqual([
      'next_question:ok',
      'repeat_question:ok',
      'repeat_question:ok',
      'grade_answer:ok:ask_next_question',
    ]);
    expect(result.asked).toEqual([Q(1)]);
    expect(result.context.questionsRemaining).toBe(1);
  });

  it('records a skip exactly as it records an answer, and moves on', () => {
    const result = run(3, [
      { tool: 'next_question' },
      { tool: 'skip_question', questionId: Q(1) },
      { tool: 'next_question' },
      { tool: 'grade_answer', questionId: Q(2), transcript: 'an answer' },
    ]);

    expect(result.steps).toEqual([
      'next_question:ok',
      'skip_question:ok:ask_next_question',
      'next_question:ok',
      'grade_answer:ok:ask_next_question',
    ]);
    expect(result.context.questionsRemaining).toBe(1);
  });

  it('refuses a skip for a question that is not outstanding', () => {
    const result = run(3, [
      { tool: 'skip_question', questionId: Q(1) },
      { tool: 'next_question' },
      { tool: 'skip_question', questionId: Q(2) },
    ]);

    expect(result.steps).toEqual([
      'skip_question:rejected:no_answer_outstanding',
      'next_question:ok',
      'skip_question:rejected:wrong_question',
    ]);
    // NOTHING WAS RECORDED by either refusal — the question the learner is
    // actually on is still outstanding.
    expect(result.context.outstandingQuestionId).toBe(Q(1));
    expect(result.context.questionsRemaining).toBe(3);
  });

  it('refuses an early "no questions left" and carries on', () => {
    // A model deciding the session is over. Believed, it would cut the session
    // short and the summary screen would agree with it.
    const result = run(3, [
      { tool: 'next_question' },
      { tool: 'grade_answer', questionId: Q(1), transcript: 'an answer' },
      { tool: 'end_session', reason: 'no_questions_left' },
      { tool: 'next_question' },
      { tool: 'grade_answer', questionId: Q(2), transcript: 'an answer' },
    ]);

    expect(result.steps).toEqual([
      'next_question:ok',
      'grade_answer:ok:ask_next_question',
      'end_session:rejected:questions_remain',
      'next_question:ok',
      'grade_answer:ok:ask_next_question',
    ]);
    expect(result.context.sessionStatus).toBe('in_progress');
  });

  it('stops the moment the learner asks, with questions left', () => {
    const result = run(5, [
      { tool: 'next_question' },
      { tool: 'grade_answer', questionId: Q(1), transcript: 'an answer' },
      { tool: 'end_session', reason: 'learner_asked' },
    ]);

    expect(result.steps).toEqual([
      'next_question:ok',
      'grade_answer:ok:ask_next_question',
      'end_session:ok:learner_asked',
    ]);
    expect(result.context.questionsRemaining).toBe(4);
  });

  it('refuses every tool once the session is closed', () => {
    // Whatever the model does after the session ends — including retrying the
    // call that ended it — it is told the same thing, and nothing is written.
    const result = run(2, [
      { tool: 'end_session', reason: 'learner_asked' },
      { tool: 'next_question' },
      { tool: 'grade_answer', questionId: Q(1), transcript: 'an answer' },
      { tool: 'repeat_question' },
      { tool: 'skip_question', questionId: Q(1) },
      { tool: 'end_session', reason: 'learner_asked' },
    ]);

    expect(result.steps).toEqual([
      'end_session:ok:learner_asked',
      'next_question:rejected:session_not_in_progress',
      'grade_answer:rejected:session_not_in_progress',
      'repeat_question:rejected:session_not_in_progress',
      'skip_question:rejected:session_not_in_progress',
      'end_session:rejected:session_not_in_progress',
    ]);
    expect(result.asked).toEqual([]);
  });

  it('exercises all five tools, so no tool is contract-only', () => {
    // A cheap guard against a sixth tool arriving with a schema, a name and no
    // scripted behaviour at all.
    const result = run(2, [
      { tool: 'next_question' },
      { tool: 'repeat_question' },
      { tool: 'grade_answer', questionId: Q(1), transcript: 'an answer' },
      { tool: 'next_question' },
      { tool: 'skip_question', questionId: Q(2) },
      { tool: 'end_session', reason: 'no_questions_left' },
    ]);

    const exercised = new Set(result.steps.map((step) => step.split(':')[0]));

    expect([...exercised].sort()).toEqual([...PRACTICE_REALTIME_TOOL_NAMES].sort());
    expect(result.steps.filter((step) => step.includes('rejected'))).toEqual([]);
  });
});
