import { bannedFamilyHits } from '../ai/coach/banned-topics';
import { coachEventForAttempt } from '../ai/coach/attempt-event';
import { COACH_REACTION_LINES } from '../ai/coach/reaction-lines';
import { reactionLine } from '../ai/coach/select-line';
import {
  SPOKEN_VERDICT_LINES,
  composeSpokenTurn,
  spokenAcceptedAnswer,
  spokenAcknowledgement,
  spokenVerdictKey,
  type SpokenTurnFacts,
} from './spoken-turn';

// =============================================================================
// composeSpokenTurn — tests (issue #351, epic #345)
// =============================================================================
//
// The headline acceptance of the whole epic is one sentence long: a learner who
// was RIGHT and a learner who was WRONG must not hear the same audio. Every
// other assertion in this file exists to keep the specific ways that regressed
// before from regressing again — the verdict going missing, the reason being
// spoken when no grader ran, and the accepted answer being read out before the
// retry it makes worthless.
//
// NO DATABASE, NO NEST, NO CLOCK. `composeSpokenTurn` is a pure function and
// this file calls it directly, which is the property issue #351 asks for
// explicitly ("unit-tested without a database").
// =============================================================================

const ATTEMPT_ID = 'b1111111-1111-4111-8111-111111111111';

/** The accepted answer every fixture below is graded against. */
const ANSWER = 'the Constitution';

/** A minimal, deliberately boring set of facts: a typed, correct attempt. */
function facts(overrides: Partial<SpokenTurnFacts> = {}): SpokenTurnFacts {
  return {
    outcome: 'correct',
    gradingMethod: 'exact',
    failureCause: null,
    aiFeedback: null,
    answerResolution: 'resolved',
    acceptedAnswers: [{ text: ANSWER }],
    heard: null,
    retryArmed: false,
    coachReaction: { text: 'Nice one.' },
    ...overrides,
  };
}

/** The supportive coach's real, curated line for an event — never invented here. */
function bankLine(event: string): string {
  return reactionLine('supportive', event, ATTEMPT_ID);
}

describe('composeSpokenTurn', () => {
  // ===========================================================================
  // THE HEADLINE ACCEPTANCE OF EPIC #345
  // ===========================================================================

  describe('a right answer and a wrong answer are audibly different', () => {
    it('produces DIFFERENT turns for the same question answered correctly and incorrectly', () => {
      // THE DEFECT, STATED AS A TEST. Before this module the loop said
      // `acceptedAnswers[0].text` and nothing else, so both of these produced
      // the single string "the Constitution" — byte-identical audio for the two
      // opposite things that can happen to a learner.
      const right = composeSpokenTurn(
        facts({
          outcome: 'correct',
          coachReaction: { text: bankLine('answer.correct') },
        }),
      );
      const wrong = composeSpokenTurn(
        facts({
          outcome: 'incorrect',
          coachReaction: { text: bankLine('answer.incorrect') },
        }),
      );

      expect(right.lines).not.toEqual(wrong.lines);

      // And specifically: the VERDICT differs, which is the element whose
      // absence was the bug. Asserting only "the arrays differ" would pass on a
      // build where the only difference was the coach's flavour line.
      expect(right.lines).toContain(SPOKEN_VERDICT_LINES.correct);
      expect(wrong.lines).toContain(SPOKEN_VERDICT_LINES.incorrect);
      expect(right.lines).not.toContain(SPOKEN_VERDICT_LINES.incorrect);
      expect(wrong.lines).not.toContain(SPOKEN_VERDICT_LINES.correct);

      // The old behaviour, gone: a correct answer is not told what the answer
      // was. It was just given.
      expect(right.lines).not.toContain(spokenAcceptedAnswer(ANSWER));
      expect(wrong.lines).toContain(spokenAcceptedAnswer(ANSWER));
    });

    it('produces a DISTINCT turn for every outcome, including partial and skipped', () => {
      // Per issue #351's first acceptance criterion, asserted per outcome value
      // rather than only for the right/wrong pair — `partial` and `skipped` are
      // exactly the two a "correct vs incorrect" test would leave collapsed.
      const turns = new Map<string, string[]>();

      for (const outcome of ['correct', 'partial', 'incorrect', 'skipped'] as const) {
        turns.set(
          outcome,
          composeSpokenTurn(facts({ outcome, coachReaction: null })).lines,
        );
      }

      const serialised = [...turns.values()].map((lines) => lines.join('|'));
      expect(new Set(serialised).size).toBe(serialised.length);
    });

    it('says something different again when the recogniser was not trusted', () => {
      // `misheard` is a statement about the MICROPHONE, never about the
      // speaker (`docs/specs/voice.md` §3), so it must not sound like being
      // told you were wrong — even though the row's `outcome` says `incorrect`.
      const misheard = composeSpokenTurn(
        facts({ outcome: 'incorrect', failureCause: 'misheard', coachReaction: null }),
      );

      expect(misheard.lines).toContain(SPOKEN_VERDICT_LINES.misheard);
      expect(misheard.lines).not.toContain(SPOKEN_VERDICT_LINES.incorrect);
    });

    it('never returns an empty turn, for any combination of facts', () => {
      // The silence this issue exists to remove must be unreachable. The
      // verdict is unconditional; everything else is optional.
      for (const outcome of ['correct', 'partial', 'incorrect', 'skipped'] as const) {
        for (const retryArmed of [false, true]) {
          for (const answerResolution of ['resolved', 'state_required'] as const) {
            const turn = composeSpokenTurn(
              facts({
                outcome,
                retryArmed,
                answerResolution,
                acceptedAnswers: [],
                coachReaction: null,
                aiFeedback: null,
              }),
            );
            expect(turn.lines.length).toBeGreaterThanOrEqual(1);
          }
        }
      }
    });
  });

  // ===========================================================================
  // ORDER
  // ===========================================================================

  describe('element order', () => {
    it('is verdict → reason → accepted answer → coach reaction', () => {
      const coach = bankLine('answer.incorrect');
      const turn = composeSpokenTurn(
        facts({
          outcome: 'incorrect',
          gradingMethod: 'ai',
          failureCause: 'not_recalled',
          aiFeedback: { feedback: 'You named a document, but not this one.' },
          coachReaction: { text: coach },
        }),
      );

      expect(turn.lines).toEqual([
        SPOKEN_VERDICT_LINES.incorrect,
        'You named a document, but not this one.',
        spokenAcceptedAnswer(ANSWER),
        coach,
      ]);
      expect(turn.retryBoundary).toBeNull();
    });

    it('puts the verdict and the reason BEFORE the accepted answer', () => {
      // Stated as an index comparison as well as an exact array, because the
      // exact array above would also pass if every element moved together.
      const turn = composeSpokenTurn(
        facts({
          outcome: 'incorrect',
          gradingMethod: 'ai',
          aiFeedback: { feedback: 'Close, but that is a different document.' },
          coachReaction: null,
        }),
      );

      const verdictAt = turn.lines.indexOf(SPOKEN_VERDICT_LINES.incorrect);
      const reasonAt = turn.lines.indexOf('Close, but that is a different document.');
      const answerAt = turn.lines.indexOf(spokenAcceptedAnswer(ANSWER));

      expect(verdictAt).toBeGreaterThanOrEqual(0);
      expect(reasonAt).toBeGreaterThan(verdictAt);
      expect(answerAt).toBeGreaterThan(reasonAt);
    });

    it('echoes what was heard first, and ONLY on a miss', () => {
      const missed = composeSpokenTurn(
        facts({ outcome: 'incorrect', heard: 'the declaration', coachReaction: null }),
      );
      expect(missed.lines[0]).toBe(spokenAcknowledgement('the declaration'));

      // Echoing a RIGHT answer back is padding — time a walking learner cannot
      // skip — so it is deliberately absent.
      const right = composeSpokenTurn(
        facts({ outcome: 'correct', heard: 'the constitution', coachReaction: null }),
      );
      expect(right.lines[0]).toBe(SPOKEN_VERDICT_LINES.correct);
      expect(right.lines.join(' ')).not.toContain('I heard');
    });
  });

  // ===========================================================================
  // THE REASON — only when a grader actually ran
  // ===========================================================================

  describe('the reason', () => {
    it('is spoken verbatim when `gradingMethod` is `ai`', () => {
      const turn = composeSpokenTurn(
        facts({
          outcome: 'partial',
          gradingMethod: 'ai',
          aiFeedback: { feedback: 'That is one part of the answer; there is another.' },
          coachReaction: null,
        }),
      );

      // VERBATIM: the grader's own sentence, unframed and unedited.
      expect(turn.lines).toContain('That is one part of the answer; there is another.');
    });

    it('is ABSENT when no grader ran, even if a failure cause is on the row', () => {
      // The server writes `failureCause: 'misheard'` ITSELF, with no model
      // involved. A cause-based test here would speak a diagnosis of the
      // learner that nothing ever made — the one thing this product must not
      // say out loud.
      const turn = composeSpokenTurn(
        facts({
          outcome: 'incorrect',
          gradingMethod: 'exact',
          failureCause: 'misheard',
          aiFeedback: { feedback: 'should never be spoken' },
          coachReaction: null,
        }),
      );

      expect(turn.lines).not.toContain('should never be spoken');
    });

    it('is absent when the grader returned an empty feedback sentence', () => {
      const turn = composeSpokenTurn(
        facts({
          outcome: 'incorrect',
          gradingMethod: 'ai',
          aiFeedback: { feedback: '   ' },
          coachReaction: null,
        }),
      );

      expect(turn.lines).toEqual([
        SPOKEN_VERDICT_LINES.incorrect,
        spokenAcceptedAnswer(ANSWER),
      ]);
    });
  });

  // ===========================================================================
  // THE RETRY-ORDERING DEFECT
  // ===========================================================================

  describe('the retry boundary', () => {
    it('offers the retry BEFORE the accepted answer is read', () => {
      // THE SECOND DEFECT #345 NAMES. The loop used to read the answer aloud
      // and then invite a retry — which makes the retry a repeat-after-me and
      // the `correct` attempt it records worthless as evidence of recall.
      const coach = bankLine('answer.misheard');
      const turn = composeSpokenTurn(
        facts({
          outcome: 'incorrect',
          failureCause: 'misheard',
          heard: 'the consternation',
          retryArmed: true,
          coachReaction: { text: coach },
        }),
      );

      expect(turn.retryBoundary).not.toBeNull();

      const boundary = turn.retryBoundary as number;
      const beforeRetry = turn.lines.slice(0, boundary);
      const afterRetry = turn.lines.slice(boundary);

      // The answer is on the FAR side of the retry opportunity.
      expect(beforeRetry).not.toContain(spokenAcceptedAnswer(ANSWER));
      expect(afterRetry).toContain(spokenAcceptedAnswer(ANSWER));

      // And everything a learner needs in order to decide whether to retry is
      // on the near side: what was heard, the verdict, and the coach's line.
      expect(beforeRetry).toEqual([
        spokenAcknowledgement('the consternation'),
        SPOKEN_VERDICT_LINES.misheard,
        coach,
      ]);
    });

    it('is null when no retry is available, and then nothing is deferred', () => {
      const turn = composeSpokenTurn(
        facts({ outcome: 'incorrect', retryArmed: false, coachReaction: null }),
      );

      expect(turn.retryBoundary).toBeNull();
      expect(turn.lines).toContain(spokenAcceptedAnswer(ANSWER));
    });

    it('is a valid index into the turn — never past its end', () => {
      // `state_required` with a retry armed: there IS no accepted answer to
      // defer, so the boundary lands on the end of the array. That is
      // legitimate and still means "a retry is armed", which is why the field
      // is not merely "the answer's index or null".
      const turn = composeSpokenTurn(
        facts({
          outcome: 'skipped',
          answerResolution: 'state_required',
          acceptedAnswers: [],
          retryArmed: true,
          coachReaction: null,
        }),
      );

      expect(turn.retryBoundary).toBe(turn.lines.length);
      expect(turn.lines.slice(turn.retryBoundary as number)).toEqual([]);
    });
  });

  // ===========================================================================
  // THE ACCEPTED ANSWER
  // ===========================================================================

  describe('the accepted answer', () => {
    it('is omitted when the answers could not be resolved for this learner', () => {
      // `state_required` — a state-scope question for a learner who has not set
      // their state. Saying nothing is honest; saying "there was no correct
      // answer" would be a lie about the question.
      const turn = composeSpokenTurn(
        facts({
          outcome: 'skipped',
          answerResolution: 'state_required',
          acceptedAnswers: [],
          coachReaction: null,
        }),
      );

      expect(turn.lines).toEqual([SPOKEN_VERDICT_LINES.skipped]);
    });

    it('reads the FIRST accepted answer, not all of them', () => {
      const turn = composeSpokenTurn(
        facts({
          outcome: 'incorrect',
          acceptedAnswers: [
            { text: 'Congress' },
            { text: 'the President' },
            { text: 'the courts' },
          ],
          coachReaction: null,
        }),
      );

      expect(turn.lines).toContain(spokenAcceptedAnswer('Congress'));
      expect(turn.lines.join(' ')).not.toContain('the President');
    });

    it('is spoken on a skip, which is a miss for this purpose', () => {
      const turn = composeSpokenTurn(
        facts({ outcome: 'skipped', coachReaction: null }),
      );
      expect(turn.lines).toContain(spokenAcceptedAnswer(ANSWER));
    });
  });

  // ===========================================================================
  // THE COACH'S LINE
  // ===========================================================================

  describe('the coach reaction', () => {
    it('is the EXACT curated bank string, never paraphrased', () => {
      // Epic #345's locked decision: the persona reaches speech as a curated
      // line read verbatim, never as a model-authored verdict. This asserts
      // both halves — the string is byte-identical to what `reactionLine`
      // selected, AND that string is genuinely a member of the shipped bank
      // rather than something this composer wrote.
      const line = bankLine('answer.incorrect');

      expect(COACH_REACTION_LINES.supportive['answer.incorrect']).toContain(line);

      const turn = composeSpokenTurn(
        facts({ outcome: 'incorrect', coachReaction: { text: line } }),
      );

      expect(turn.lines[turn.lines.length - 1]).toBe(line);
    });

    it('is ABSENT entirely when the learner has turned reactions off', () => {
      // `coach.reactions: false` reaches this function as `coachReaction: null`
      // — the same `null` the wire field carries — and NOTHING stands in for
      // it: not a placeholder, not a neutral substitute.
      const withCoach = composeSpokenTurn(
        facts({ outcome: 'incorrect', coachReaction: { text: bankLine('answer.incorrect') } }),
      );
      const withoutCoach = composeSpokenTurn(
        facts({ outcome: 'incorrect', coachReaction: null }),
      );

      expect(withoutCoach.lines).toEqual([
        SPOKEN_VERDICT_LINES.incorrect,
        spokenAcceptedAnswer(ANSWER),
      ]);
      expect(withoutCoach.lines.length).toBe(withCoach.lines.length - 1);
    });

    it('adds no AI call and no model-authored sentence of its own', () => {
      // Stated structurally rather than by mocking a dispatcher: the module
      // imports nothing that could make a call. `composeSpokenTurn`'s only
      // sources of text are its own frozen bank, its three frames, the
      // grader's already-validated `feedback`, and the line it was handed.
      const turn = composeSpokenTurn(
        facts({ outcome: 'incorrect', coachReaction: { text: 'A curated line.' } }),
      );

      for (const line of turn.lines) {
        expect(
          line === SPOKEN_VERDICT_LINES.incorrect ||
            line === spokenAcceptedAnswer(ANSWER) ||
            line === 'A curated line.',
        ).toBe(true);
      }
    });
  });

  // ===========================================================================
  // THE BANK — the same lint E14 runs over its own copy
  // ===========================================================================

  describe('the verdict bank', () => {
    it('trips none of E14’s banned-topic families', () => {
      // The identical check `personas.spec.ts` and `reaction-lines.spec.ts`
      // run over their own learner-facing copy, applied to this bank so that
      // the COACH_INVARIANT_FLOOR's rules are enforced on the words the engine
      // itself speaks, not only on the words the coach speaks.
      for (const [key, line] of Object.entries(SPOKEN_VERDICT_LINES)) {
        expect({ key, hits: bannedFamilyHits(line) }).toEqual({ key, hits: [] });
      }
      expect(bannedFamilyHits(spokenAcknowledgement('X'))).toEqual([]);
      expect(bannedFamilyHits(spokenAcceptedAnswer('X'))).toEqual([]);
    });

    it('interpolates nothing — every verdict is a constant', () => {
      // `reaction-lines.ts`'s "NO INTERPOLATION, EVER", restated for this bank:
      // no question prompt, no learner response, no score, no count.
      for (const line of Object.values(SPOKEN_VERDICT_LINES)) {
        expect(line).not.toMatch(/\$\{|%s|\{\{/);
        expect(line).not.toMatch(/\d/);
      }
    });

    it('is frozen, so no caller can rewrite what a learner hears', () => {
      expect(Object.isFrozen(SPOKEN_VERDICT_LINES)).toBe(true);
    });
  });

  // ===========================================================================
  // PRECEDENCE — the same order `coachEventForAttempt` uses
  // ===========================================================================

  describe('spokenVerdictKey', () => {
    it('ranks misheard above the outcome, and self-mark above correct', () => {
      expect(
        spokenVerdictKey({
          outcome: 'incorrect',
          gradingMethod: 'ai',
          failureCause: 'misheard',
        }),
      ).toBe('misheard');

      expect(
        spokenVerdictKey({
          outcome: 'correct',
          gradingMethod: 'self',
          failureCause: null,
        }),
      ).toBe('self_marked');
    });

    it('agrees with `coachEventForAttempt` about WHICH fact wins', () => {
      // Two functions with the same precedence is a drift risk; this is the
      // assertion that closes it. The coach reacts to one thing and the engine
      // states a verdict about another only if these disagree.
      const cases: Array<Pick<SpokenTurnFacts, 'outcome' | 'gradingMethod' | 'failureCause'>> = [
        { outcome: 'incorrect', gradingMethod: 'ai', failureCause: 'misheard' },
        { outcome: 'correct', gradingMethod: 'self', failureCause: null },
        { outcome: 'correct', gradingMethod: 'exact', failureCause: null },
        { outcome: 'partial', gradingMethod: 'ai', failureCause: 'expression' },
        { outcome: 'incorrect', gradingMethod: 'ai', failureCause: 'not_known' },
        { outcome: 'skipped', gradingMethod: 'exact', failureCause: null },
      ];

      for (const c of cases) {
        const event = coachEventForAttempt({ ...c, correctRunLength: 1 });
        expect(`answer.${spokenVerdictKey(c)}`).toBe(event);
      }
    });
  });
});
