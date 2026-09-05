import {
  END_SESSION_REASONS,
  PRACTICE_REALTIME_SESSION_TTL_SECONDS,
  PRACTICE_REALTIME_TOOLS,
  PRACTICE_REALTIME_TOOL_NAMES,
} from './practice-realtime-tools';

// =============================================================================
// The realtime practice tool contract — tests (issue #353, epic #345 / E15)
// =============================================================================
//
// One property matters more than everything else in this file: a tool contract
// that lives only in a system prompt is not a contract. So the assertions below
// are about the SCHEMAS — what the provider will and will not let the model
// send — never about the wording of a description.
//
// The compile-time proofs in `practice-realtime-tools.ts` already make a
// `verdict` or a `confidence` property a build break. These tests cover what a
// type cannot: that `additionalProperties` is closed on EVERY tool (so an
// undeclared field is refused rather than merely undocumented), that the two
// no-argument tools genuinely have none, and that `end_session`'s enum is a
// pair of observations rather than a judgement.
// =============================================================================

function toolNamed(name: string) {
  const tool = PRACTICE_REALTIME_TOOLS.find((entry) => entry.name === name);
  if (!tool) throw new Error(`No tool named ${name}`);

  return tool.parameters as {
    type: string;
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

/** Every name a verdict, a grade or a self-reported certainty would be given. */
const FORBIDDEN_ARGUMENT_NAMES = [
  'verdict',
  'grade',
  'outcome',
  'correct',
  'isCorrect',
  'score',
  'passed',
  'result',
  'assessment',
  'evaluation',
  'failureCause',
  'confidence',
  'asrConfidence',
  'certainty',
  'confidenceScore',
];

describe('the realtime practice tools', () => {
  it('declares exactly the five the contract specifies, in turn order', () => {
    expect(PRACTICE_REALTIME_TOOLS.map((tool) => tool.name)).toEqual([
      'next_question',
      'grade_answer',
      'repeat_question',
      'skip_question',
      'end_session',
    ]);
  });

  it('exports the names derived from the tools themselves', () => {
    // DERIVED, NOT COPIED: a sixth tool cannot exist as a schema without also
    // existing as a name a result can be labelled with.
    expect(PRACTICE_REALTIME_TOOL_NAMES).toEqual(
      PRACTICE_REALTIME_TOOLS.map((tool) => tool.name),
    );
  });

  it('gives every tool a closed argument shape', () => {
    // WITHOUT THIS, "no verdict field" is a statement about what is documented
    // rather than about what can arrive: a model that volunteers one lands it
    // in an unvalidated bag a later handler could start reading. And on this
    // transport that bag is one refactor away from a `practice_attempts` row.
    for (const tool of PRACTICE_REALTIME_TOOLS) {
      expect(toolNamed(tool.name).additionalProperties).toBe(false);
      expect(toolNamed(tool.name).type).toBe('object');
    }
  });

  it('gives every tool a description the provider can weight', () => {
    for (const tool of PRACTICE_REALTIME_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });

  it('declares no verdict-shaped argument on ANY tool', () => {
    // Stated over the whole contract rather than only over `grade_answer`,
    // because the guarantee is about the transport: any tool that grew one
    // would be a channel from the model's opinion into the evidence table.
    for (const tool of PRACTICE_REALTIME_TOOLS) {
      const properties = Object.keys(toolNamed(tool.name).properties);

      for (const forbidden of FORBIDDEN_ARGUMENT_NAMES) {
        expect(properties).not.toContain(forbidden);
      }
    }
  });

  describe('next_question', () => {
    it('takes no arguments at all', () => {
      // The model asks to be TOLD what to say. There is no field through which
      // it could propose a question, a topic, a category or a difficulty —
      // selection stays with `mastery/selector.ts` and the learner's own
      // spaced-repetition state.
      expect(Object.keys(toolNamed('next_question').properties)).toEqual([]);
      expect(toolNamed('next_question').required).toBeUndefined();
    });
  });

  describe('grade_answer', () => {
    it('takes what was heard, and nothing that judges it', () => {
      expect(Object.keys(toolNamed('grade_answer').properties).sort()).toEqual([
        'questionId',
        'transcript',
      ]);
    });

    it('has no verdict field, under any of the names one would be given', () => {
      const properties = Object.keys(toolNamed('grade_answer').properties);

      for (const forbidden of FORBIDDEN_ARGUMENT_NAMES) {
        expect(properties).not.toContain(forbidden);
      }
    });

    it('has no confidence field — the one place this is narrower than E11’s', () => {
      // On the request/response path a confidence is the RECOGNISER's, about
      // audio it processed, and it feeds `isMisheardAttempt`, which skips
      // mastery scheduling. Here the same number would be the model reporting
      // its own certainty about its own hearing — a different quantity wearing
      // the same name, and one a model could use to suppress a scheduling
      // update by claiming it was unsure.
      expect(Object.keys(toolNamed('grade_answer').properties)).not.toContain(
        'confidence',
      );
      expect(toolNamed('grade_answer').required).not.toContain('confidence');
    });

    it('requires both of its arguments, so an out-of-order call is detectable', () => {
      // Naming the question rather than assuming "the current one" is what
      // makes the wrong-question refusal expressible at all.
      expect(toolNamed('grade_answer').required).toEqual([
        'questionId',
        'transcript',
      ]);
    });
  });

  describe('repeat_question', () => {
    it('takes no arguments at all', () => {
      // There is only ever one outstanding question and the session knows
      // which. A `questionId` here would be a field through which the model
      // could ask for a question that is not the one being answered.
      expect(Object.keys(toolNamed('repeat_question').properties)).toEqual([]);
    });
  });

  describe('skip_question', () => {
    it('takes the question id and nothing else', () => {
      // A skip is RECORDED EVIDENCE (`practice_attempts.outcome: 'skipped'`)
      // and it schedules, so this schema reaches the same rows `grade_answer`
      // does and is closed the same way.
      expect(Object.keys(toolNamed('skip_question').properties)).toEqual([
        'questionId',
      ]);
      expect(toolNamed('skip_question').required).toEqual(['questionId']);
    });
  });

  describe('end_session', () => {
    it('names two observations, and no judgement', () => {
      // There is deliberately no `learner_struggling`, no `enough_for_today`
      // and no `mastered`: a model that could end a session because it judged
      // the learner had done badly would be making the product's most
      // discouraging decision on its own.
      expect(END_SESSION_REASONS).toEqual(['no_questions_left', 'learner_asked']);
    });

    it('constrains the reason argument to that pair', () => {
      const reason = toolNamed('end_session').properties.reason as {
        enum: readonly string[];
      };

      expect(reason.enum).toEqual(END_SESSION_REASONS);
      expect(toolNamed('end_session').required).toEqual(['reason']);
    });
  });

  it('asks for a session lifetime measured in seconds, not minutes', () => {
    // Short on purpose: the secret only has to survive the handshake, and a
    // session already under way is not cut off when it expires. A value that
    // had drifted into the minutes would be a browser-held bearer credential
    // outliving its purpose for no benefit.
    expect(PRACTICE_REALTIME_SESSION_TTL_SECONDS).toBeGreaterThan(0);
    expect(PRACTICE_REALTIME_SESSION_TTL_SECONDS).toBeLessThanOrEqual(120);
  });
});
