import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  buildInterviewDebrief,
  focusAreasFrom,
  type DebriefInput,
  type DebriefSegmentAttempt,
} from './debrief';
import { stripComments } from './test-support/strip-comments';
import type { InterviewDebriefQuestion } from './dto/interview-debrief.dto';

// =============================================================================
// buildInterviewDebrief — tests (issue #133, epic #57 / E8)
// =============================================================================
//
// `docs/specs/mock-interview.md` §11. The debrief is the first and only place
// a learner is told how a rehearsal went, so the properties worth pinning are
// the ones that would make it lie:
//
//   * `planned`/`threshold` ECHO the version row's numbers. A literal in this
//     module would be the "a threshold in code is a threshold that will one day
//     disagree with the seeded data" failure §15 rejects, one layer up.
//   * `stoppedEarly` describes what actually happened, including the case
//     where the pool was short rather than the learner stopped.
//   * `focusAreas` is a deterministic grouping, never a model's summary.
//   * `reading`/`writing` are reported SKIPPED, never omitted — §2.4's whole
//     argument is about a learner who cannot tell "not covered yet" from
//     "forgot to mention it exists".
// =============================================================================

const READINESS: DebriefInput['readiness'] = {
  score: 62,
  previousScore: 55,
  delta: 7,
  capReason: null,
  capMessage: null,
  interviewComponent: { value: 0.5, evidenceCount: 1 },
  spokenComponent: { value: 0.4, evidenceCount: 8 },
  recommendation: {
    componentKey: 'coverage',
    title: 'Cover more of the question bank',
    reason: 'You have seen 40 of the 100 questions.',
    path: '/practice',
  },
};

function attempt(
  overrides: Partial<DebriefInput['attempts'][number]> = {},
): DebriefInput['attempts'][number] {
  return {
    questionId: '11111111-1111-4111-8111-111111111111',
    number: 1,
    prompt: 'Name one branch or part of the government.',
    categoryName: 'American Government',
    outcome: 'correct',
    acceptedAnswers: ['Congress', 'legislative'],
    // E8's own transport, so the pre-existing cases below keep asserting
    // exactly what they asserted before E11 touched this builder.
    inputMode: 'typed',
    failureCause: null,
    asrConfidence: null,
    ...overrides,
  };
}

function segment(
  overrides: Partial<DebriefSegmentAttempt> = {},
): DebriefSegmentAttempt {
  return {
    kind: 'reading',
    outcome: 'correct',
    sentence: 'Who was the first President?',
    wer: 0,
    ...overrides,
  };
}

function debriefInput(overrides: Partial<DebriefInput> = {}): DebriefInput {
  return {
    passRule: { questionsAsked: 10, passThreshold: 6 },
    civicsAsked: 6,
    civicsCorrect: 6,
    stopReason: 'threshold_reached',
    passedCivics: true,
    attempts: [attempt()],
    segments: [],
    readiness: READINESS,
    ...overrides,
  };
}

describe('buildInterviewDebrief', () => {
  describe('§11 — the numbers are echoed from the version row', () => {
    it('reports `planned` and `threshold` as the pass rule gave them', () => {
      const debrief = buildInterviewDebrief(
        debriefInput({ passRule: { questionsAsked: 20, passThreshold: 12 } }),
      );

      expect(debrief.civics.planned).toBe(20);
      expect(debrief.civics.threshold).toBe(12);
    });

    it('carries a different version’s numbers through unchanged', () => {
      // Two rows, two answers, from one code path — which is what "reads from a
      // row, never a constant" means in practice.
      const senior = buildInterviewDebrief(
        debriefInput({ passRule: { questionsAsked: 10, passThreshold: 6 } }),
      );

      expect(senior.civics.planned).toBe(10);
      expect(senior.civics.threshold).toBe(6);
    });
  });

  describe('§4.1 — the early stop is described honestly', () => {
    it('marks a threshold_reached run as stopped early', () => {
      const debrief = buildInterviewDebrief(
        debriefInput({ civicsAsked: 6, stopReason: 'threshold_reached' }),
      );

      expect(debrief.civics.stoppedEarly).toBe(true);
      expect(debrief.civics.stopReason).toBe('threshold_reached');
      expect(debrief.civics.passed).toBe(true);
    });

    it('marks a threshold_unreachable run as stopped early, and failed', () => {
      const debrief = buildInterviewDebrief(
        debriefInput({
          civicsAsked: 9,
          civicsCorrect: 4,
          stopReason: 'threshold_unreachable',
          passedCivics: false,
        }),
      );

      expect(debrief.civics.stoppedEarly).toBe(true);
      expect(debrief.civics.passed).toBe(false);
    });

    it('does NOT mark a full run as stopped early', () => {
      const debrief = buildInterviewDebrief(
        debriefInput({
          civicsAsked: 10,
          civicsCorrect: 5,
          stopReason: 'all_asked',
          passedCivics: false,
        }),
      );

      expect(debrief.civics.stoppedEarly).toBe(false);
    });

    it('DOES mark a short-pool run as stopped early, even though the reason is all_asked', () => {
      // `stoppedEarly` is `asked < planned`, not `stopReason !== 'all_asked'`.
      // A pool shorter than N runs out at 4 of 10 — the interview really did
      // stop before the version row's full count, and telling the learner their
      // four-question run was a full ten would be the debrief lying about the
      // test it administered.
      const debrief = buildInterviewDebrief(
        debriefInput({
          civicsAsked: 4,
          civicsCorrect: 2,
          stopReason: 'all_asked',
          passedCivics: false,
        }),
      );

      expect(debrief.civics.stoppedEarly).toBe(true);
      expect(debrief.civics.stopReason).toBe('all_asked');
    });
  });

  describe('§2.4 — every phase is reported, and the two text mode cannot run say so', () => {
    it('lists all six phases in order', () => {
      const debrief = buildInterviewDebrief(debriefInput());

      expect(debrief.phases.map((phase) => phase.kind)).toEqual([
        'smalltalk',
        'n400',
        'civics',
        'reading',
        'writing',
        'closing',
      ]);
    });

    it('reports reading and writing SKIPPED rather than omitting them', () => {
      const debrief = buildInterviewDebrief(debriefInput());
      const skipped = debrief.phases
        .filter((phase) => phase.status === 'skipped')
        .map((phase) => phase.kind);

      expect(skipped).toEqual(['reading', 'writing']);
    });

    it('reports civics completed even when its section stopped early', () => {
      // The phase WAS conducted; the early stop is `civics.stopReason`'s job to
      // describe. Reporting `civics: 'skipped'` for an interview that asked six
      // questions and passed would be plainly wrong.
      const debrief = buildInterviewDebrief(
        debriefInput({ civicsAsked: 6, stopReason: 'threshold_reached' }),
      );

      expect(
        debrief.phases.find((phase) => phase.kind === 'civics')?.status,
      ).toBe('completed');
    });
  });

  describe('§11 — the questions carry their frozen accepted answers', () => {
    it('passes each attempt through with its own snapshot answers', () => {
      const debrief = buildInterviewDebrief(
        debriefInput({
          attempts: [
            attempt({ number: 3, acceptedAnswers: ['Congress', 'legislative'] }),
            attempt({
              questionId: '22222222-2222-4222-8222-222222222222',
              number: 28,
              prompt: 'What is the name of the President of the United States now?',
              categoryName: 'System of Government',
              outcome: 'incorrect',
              acceptedAnswers: ['Jane Q. Doe'],
            }),
          ],
        }),
      );

      expect(debrief.questions).toHaveLength(2);
      expect(debrief.questions[1].acceptedAnswers).toEqual(['Jane Q. Doe']);
      expect(debrief.questions[1].prompt).toBe(
        'What is the name of the President of the United States now?',
      );
    });
  });

  it('is deterministic — two calls on the same input are identical', () => {
    const given = debriefInput();

    expect(buildInterviewDebrief(given)).toEqual(buildInterviewDebrief(given));
  });

  describe('§4 — no threshold literal exists in this module', () => {
    it('contains no bare pass-mark integer in its own source', () => {
      // The same "read the source off disk" discipline `interview-engine.spec.ts`
      // applies to the engine, extended to the module that RENDERS those
      // numbers. The weaker test — feed two pass rules, assert the outputs
      // differ — passes just as happily against an implementation carrying a
      // hardcoded default on a path neither fixture exercises.
      // COMMENTS STRIPPED FIRST. This file's prose cites `mock-interview.md`
      // §11 and §4.1 constantly, and a scan that counted those would be a test
      // that punishes explanation — the exact thing this codebase asks for
      // most. What is being asserted is a property of the CODE.
      const source = stripComments(
        readFileSync(join(__dirname, 'debrief.ts'), 'utf8'),
      );

      // NO NUMERIC LITERAL AT ALL, not merely "none of today's pass marks".
      // The stronger form is the one worth having: a future edit that
      // introduced `Math.min(threshold, 6)` would fail, and so would one that
      // introduced `Math.min(threshold, 7)` — which a list of known-bad values
      // would happily let through.
      expect(source).not.toMatch(/(?<![\w.$])\d+(?![\w.$])/);
    });
  });
});

describe('focusAreasFrom', () => {
  function question(
    overrides: Partial<InterviewDebriefQuestion> = {},
  ): InterviewDebriefQuestion {
    return {
      questionId: '33333333-3333-4333-8333-333333333333',
      number: 1,
      prompt: 'Name one branch or part of the government.',
      categoryName: 'American Government',
      outcome: 'correct',
      acceptedAnswers: [],
      inputMode: 'typed',
      misheard: false,
      asrConfidence: null,
      ...overrides,
    };
  }

  it('is empty when nothing was missed', () => {
    expect(focusAreasFrom([question(), question({ number: 2 })])).toEqual([]);
  });

  it('names a category with at least one miss', () => {
    expect(
      focusAreasFrom([
        question(),
        question({ number: 2, outcome: 'incorrect' }),
      ]),
    ).toEqual(['American Government']);
  });

  it('lists each category once, in the order it was first missed', () => {
    const areas = focusAreasFrom([
      question({ categoryName: 'Integrated Civics', outcome: 'incorrect' }),
      question({ categoryName: 'American Government', outcome: 'incorrect' }),
      question({ categoryName: 'Integrated Civics', outcome: 'incorrect' }),
    ]);

    expect(areas).toEqual(['Integrated Civics', 'American Government']);
  });

  it.each(['incorrect', 'partial', 'skipped'] as const)(
    'counts a %s outcome as a miss',
    (outcome) => {
      expect(focusAreasFrom([question({ outcome })])).toEqual([
        'American Government',
      ]);
    },
  );

  it('carries no counts — it names the questions, not the person (§11.1)', () => {
    // A count per category would invite a screen to render "you missed 3 of 4
    // in American Government", which is a characterisation of a six-question
    // sample dressed as a measurement.
    const areas = focusAreasFrom([
      question({ outcome: 'incorrect' }),
      question({ number: 2, outcome: 'incorrect' }),
    ]);

    expect(areas).toEqual(['American Government']);
    expect(areas.every((area) => typeof area === 'string')).toBe(true);
  });
});
