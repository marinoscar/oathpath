import { buildProgressGuidePrompt } from './progress-guide-prompt';
import type { ReadinessComponentResult, ReadinessResult } from './readiness-engine';

// =============================================================================
// The Progress Guide prompt's grounding rule, asserted (issue #134, epic #55
// / E6 "Readiness and Progress")
// =============================================================================
//
// `buildProgressGuidePrompt` is pure, so every fact `docs/specs/
// readiness-model.md` §9 requires the prompt to carry is checkable here — no
// DI, no HTTP, no provider. The identical reason `explain-prompt.spec.ts`
// exists for `buildExplainPrompt`.
// =============================================================================

function component(value: number, weight: number): ReadinessComponentResult {
  return { value, weight, contribution: value * weight };
}

/** A fully-populated `ReadinessResult`, overridable per test. */
function readinessResult(overrides: Partial<ReadinessResult> = {}): ReadinessResult {
  return {
    score: 59,
    components: {
      coverage: component(0.55, 0.15),
      recall: component(0.95, 0.2),
      retention: component(0.436364, 0.2),
      consistency: component(1.0, 0.1),
      remediation: component(0.8, 0.1),
      english: component(0, 0.05),
      spoken: component(0, 0.1),
      interview: component(0.5, 0.1),
    },
    evidenceCounts: {
      coverage: { distinctQuestionsAttempted: 55, totalQuestionsInVersion: 100 },
      recall: {
        qualifyingAttempts: 20,
        correctCount: 19,
        partialCount: 0,
        incorrectCount: 1,
        skippedCount: 0,
      },
      retention: { masteredCount: 12, reviewCount: 20, totalAttemptedQuestions: 55 },
      consistency: { distinctPracticeDaysInLast14: 7 },
      remediation: { everWeakCount: 5, remediatedCount: 4 },
      english: { readingSentences: 0, writingSentences: 0, readingCredit: 0, writingCredit: 0 },
      spoken: { attempts: 0 },
      interview: { attempts: 1 },
    },
    capReason: null,
    ...overrides,
  };
}

/** The messages as one string — the model reads them as one context. */
function whole(result: ReadinessResult): string {
  return buildProgressGuidePrompt(result)
    .map((message) => message.content)
    .join('\n\n');
}

describe('buildProgressGuidePrompt', () => {
  describe('shape', () => {
    it('produces exactly one system turn and one user turn', () => {
      const messages = buildProgressGuidePrompt(readinessResult());

      expect(messages.map((message) => message.role)).toEqual(['system', 'user']);
    });

    it('states the overall score', () => {
      const [, user] = buildProgressGuidePrompt(readinessResult({ score: 59 }));

      expect(user.content).toContain('59');
    });
  });

  // ---------------------------------------------------------------------------
  // Grounding — every component's own evidence, never a guess
  // ---------------------------------------------------------------------------

  describe('grounding — high components', () => {
    it('carries recall\'s real evidence counts when recall is strong', () => {
      const prompt = whole(
        readinessResult({
          components: {
            ...readinessResult().components,
            recall: component(0.95, 0.2),
          },
          evidenceCounts: {
            ...readinessResult().evidenceCounts,
            recall: {
              qualifyingAttempts: 20,
              correctCount: 19,
              partialCount: 0,
              incorrectCount: 1,
              skippedCount: 0,
            },
          },
        }),
      );

      expect(prompt).toContain('19');
      expect(prompt).toContain('20');
    });
  });

  describe('grounding — low components', () => {
    it('carries coverage\'s real (low) evidence counts when coverage is weak', () => {
      const prompt = whole(
        readinessResult({
          components: {
            ...readinessResult().components,
            coverage: component(0.2, 0.15),
          },
          evidenceCounts: {
            ...readinessResult().evidenceCounts,
            coverage: { distinctQuestionsAttempted: 20, totalQuestionsInVersion: 100 },
          },
        }),
      );

      expect(prompt).toContain('20');
      expect(prompt).toContain('100');
    });

    it('states "not enough" for recall rather than fabricating a percentage below the 5-attempt floor', () => {
      const prompt = whole(
        readinessResult({
          components: { ...readinessResult().components, recall: component(0, 0.2) },
          evidenceCounts: {
            ...readinessResult().evidenceCounts,
            recall: {
              qualifyingAttempts: 2,
              correctCount: 1,
              partialCount: 0,
              incorrectCount: 1,
              skippedCount: 0,
            },
          },
        }),
      );

      expect(prompt).toMatch(/not enough unassisted answers/i);
    });
  });

  // ---------------------------------------------------------------------------
  // The cap — named plainly when set, absent when not
  // ---------------------------------------------------------------------------

  describe('capped', () => {
    it('states the cap plainly, and names why, when capReason is typed_only', () => {
      const prompt = whole(readinessResult({ capReason: 'typed_only' }));

      expect(prompt).toMatch(/Cap: YES/);
      expect(prompt).toMatch(/no spoken-answer evidence and no completed mock/i);
    });
  });

  describe('not capped', () => {
    it('says plainly that no cap is in effect, when capReason is null', () => {
      const prompt = whole(readinessResult({ capReason: null }));

      expect(prompt).toMatch(/Cap: no cap is currently in effect/);
      expect(prompt).not.toMatch(/Cap: YES/);
    });
  });

  // ---------------------------------------------------------------------------
  // Never invited to invent — every declared component is present, in order
  // ---------------------------------------------------------------------------

  describe('completeness', () => {
    it('lists all eight components, in readiness-engine.ts\'s declared order', () => {
      const [, user] = buildProgressGuidePrompt(readinessResult());

      // `english`'s label changed with #141 (epic #59 / E10): the component
      // is scored from `english_attempts` — sentences read aloud and typed —
      // not from civics answers spoken in English, and the label a learner's
      // narrative is grounded in has to say which.
      const order = ['Coverage', 'Recall', 'Retention', 'Consistency', 'Remediation', 'English reading and writing', 'Spoken practice', 'Mock interviews'];
      const positions = order.map((label) => user.content.indexOf(label));

      for (const position of positions) {
        expect(position).toBeGreaterThanOrEqual(0);
      }
      // Strictly increasing — the declared order is preserved verbatim.
      for (let i = 1; i < positions.length; i += 1) {
        expect(positions[i]).toBeGreaterThan(positions[i - 1]);
      }
    });

    it('instructs the model never to invent a fact outside the given data', () => {
      const [system] = buildProgressGuidePrompt(readinessResult());

      expect(system.content).toMatch(/do not invent a fact/i);
    });

    it('instructs the model never to declare the learner "ready" or "not ready"', () => {
      const [system] = buildProgressGuidePrompt(readinessResult());

      expect(system.content).toMatch(/never say the learner is "ready" or "not ready"/i);
    });
  });
});
