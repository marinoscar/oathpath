import { INTERVIEW_PHASES } from '../engine';
import {
  END_PHASE_VALUES,
  INTERVIEW_REALTIME_TOOLS,
  REALTIME_SESSION_TTL_SECONDS,
} from './realtime-tools';

// =============================================================================
// The realtime tool contract — tests (issue #157, epic #60 / E11)
// =============================================================================
//
// One property matters more than everything else in this file, and issue #155
// states it: "a tool contract that lives only in a system prompt is not a
// contract." So the assertions below are about the SCHEMAS — what the provider
// will and will not let the model send — never about the wording of a
// description.
//
// The compile-time proof in `realtime-tools.ts` already makes a `verdict`
// property a build break. These tests cover what a type cannot: that
// `additionalProperties` is closed (so an undeclared field is refused rather
// than merely undocumented), and that `end_phase`'s enum tracks the engine's
// own phase list rather than a copy of it.
// =============================================================================

function toolNamed(name: string) {
  const tool = INTERVIEW_REALTIME_TOOLS.find((entry) => entry.name === name);
  if (!tool) throw new Error(`No tool named ${name}`);

  return tool.parameters as {
    type: string;
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

describe('the realtime interview tools', () => {
  it('declares exactly the three §4 specifies, in turn order', () => {
    expect(INTERVIEW_REALTIME_TOOLS.map((tool) => tool.name)).toEqual([
      'next_question',
      'grade_answer',
      'end_phase',
    ]);
  });

  it('gives every tool a closed argument shape', () => {
    // WITHOUT THIS, "no verdict field" is a statement about what is documented
    // rather than about what can arrive: a model that volunteers one lands it
    // in an unvalidated bag a later handler could start reading.
    for (const tool of INTERVIEW_REALTIME_TOOLS) {
      expect(toolNamed(tool.name).additionalProperties).toBe(false);
    }
  });

  it('gives every tool a description the provider can weight', () => {
    // The provider gives a tool its own description field and models weight
    // it; an empty one is how a tool ends up never being called for a reason
    // nothing in the transcript explains.
    for (const tool of INTERVIEW_REALTIME_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });

  describe('next_question', () => {
    it('takes no arguments at all', () => {
      // The model asks to be TOLD what to say. There is no field through which
      // it could propose a question, a topic or a difficulty — the same "no
      // field to put it in" enforcement the text transport gets by
      // concatenating the question server-side.
      expect(Object.keys(toolNamed('next_question').properties)).toEqual([]);
    });
  });

  describe('grade_answer', () => {
    it('takes what was heard, and nothing that judges it', () => {
      expect(Object.keys(toolNamed('grade_answer').properties).sort()).toEqual([
        'confidence',
        'questionId',
        'transcript',
      ]);
    });

    it('has no verdict field, under any of the names one would be given', () => {
      // §4.2, and §13's rejected "letting `grade_answer`'s verdict be believed"
      // row: a self-reported grade that is merely preferred-against is a grade
      // that gets believed the first time a deterministic match is ambiguous.
      const properties = Object.keys(toolNamed('grade_answer').properties);

      for (const forbidden of [
        'verdict',
        'grade',
        'outcome',
        'correct',
        'isCorrect',
        'score',
        'passed',
        'result',
      ]) {
        expect(properties).not.toContain(forbidden);
      }
    });

    it('requires the question id, so an out-of-order call is detectable', () => {
      // Naming the question rather than assuming "the current one" is what
      // makes §4.2's rejection rule expressible at all.
      expect(toolNamed('grade_answer').required).toEqual([
        'questionId',
        'transcript',
      ]);
    });

    it('leaves confidence optional, because absent means unknown', () => {
      // `ai.types.ts`: `null` confidence is UNKNOWN and never low. Requiring
      // it would make every mint on a provider that reports none an interview
      // where the model has to invent a number, and `misheard` would then be
      // decided by a guess.
      expect(toolNamed('grade_answer').required).not.toContain('confidence');
    });

    it('bounds confidence to the range the misheard rule reads', () => {
      const confidence = toolNamed('grade_answer').properties.confidence as {
        minimum: number;
        maximum: number;
      };

      expect(confidence.minimum).toBe(0);
      expect(confidence.maximum).toBe(1);
    });
  });

  describe('end_phase', () => {
    it('names its phases from the engine’s own list, minus the closing', () => {
      // DERIVED, NOT COPIED. A second hand-written list is a phase the engine
      // conducts that the model cannot report, or the reverse, on the day the
      // sequence changes — and `phases.ts` is the only place that sequence is
      // stated.
      expect(END_PHASE_VALUES).toEqual(
        INTERVIEW_PHASES.filter((phase) => phase !== 'closing'),
      );
      expect(END_PHASE_VALUES).not.toContain('closing');
    });

    it('constrains the phase argument to that list', () => {
      const phase = toolNamed('end_phase').properties.phase as {
        enum: readonly string[];
      };

      expect(phase.enum).toEqual(END_PHASE_VALUES);
      expect(toolNamed('end_phase').required).toEqual(['phase']);
    });
  });

  it('asks for a session lifetime measured in seconds, not minutes', () => {
    // §3 fixes this short on purpose: the secret only has to survive the
    // handshake, and a session already under way is not cut off when it
    // expires. A value that had drifted into the minutes would be a
    // browser-held bearer credential outliving its purpose for no benefit.
    expect(REALTIME_SESSION_TTL_SECONDS).toBeGreaterThan(0);
    expect(REALTIME_SESSION_TTL_SECONDS).toBeLessThanOrEqual(120);
  });
});
