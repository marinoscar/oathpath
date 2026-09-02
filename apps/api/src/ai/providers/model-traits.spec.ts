import { describeModelTraits } from './model-traits';

// =============================================================================
// OpenAI model traits (issue #176, epic #25)
// =============================================================================
//
// REAL MODEL IDS, not invented ones, for the same reason model-classifier.spec
// .ts uses a real fixture: the traits' whole job is to survive contact with
// OpenAI's actual naming, where three lines that all answer on the chat
// endpoint need three different request shapes.
//
// The rules overlap in the string sense — `o1-mini` matches `^o\d` exactly as
// `o3-mini` does — so the ORDER is asserted here as its own claim. Reordering
// the table would otherwise break the o1 previews silently.
// =============================================================================

describe('describeModelTraits — the gpt-5 line', () => {
  it.each(['gpt-5', 'gpt-5-mini', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-6'])(
    'reads %s as a reasoning model taking developer instructions at minimal effort',
    (id) => {
      expect(describeModelTraits(id)).toEqual({
        reasoning: true,
        supportsSampling: false,
        supportsReasoningEffort: true,
        minimumReasoningEffort: 'minimal',
        instructionRole: 'developer',
        minCompletionTokens: expect.any(Number),
      });
    },
  );

  it('is a generation comparison, not a match on the string "gpt-5"', () => {
    // A string match would miss the next line the day it ships, and the
    // symptom would be #176 again: a working key reported as unable to reach
    // its own model.
    expect(describeModelTraits('gpt-9-turbo').reasoning).toBe(true);
  });

  it('leaves the gpt-4 line alone', () => {
    expect(describeModelTraits('gpt-4.9').reasoning).toBe(false);
  });
});

describe('describeModelTraits — the o-series', () => {
  it.each(['o1', 'o3', 'o3-mini', 'o4-mini'])(
    'reads %s as a reasoning model taking developer instructions at low effort',
    (id) => {
      expect(describeModelTraits(id)).toMatchObject({
        reasoning: true,
        supportsSampling: false,
        supportsReasoningEffort: true,
        // The o-series has no `minimal` tier — sending one is an
        // `unsupported_value`, not a cheaper request.
        minimumReasoningEffort: 'low',
        instructionRole: 'developer',
      });
    },
  );

  it.each(['o1-mini', 'o1-preview', 'o1-mini-2024-09-12'])(
    'gives %s a USER instruction role, because it accepts neither system nor developer',
    (id) => {
      // The ordering claim. This rule sits before the general o-series rule,
      // which matches these ids too; swapping them sends an instruction turn
      // as `developer` and gets a 400 on every call.
      expect(describeModelTraits(id)).toMatchObject({
        reasoning: true,
        instructionRole: 'user',
        // Predates the parameter entirely.
        supportsReasoningEffort: false,
        minimumReasoningEffort: null,
      });
    },
  );
});

describe('describeModelTraits — the plain chat line', () => {
  it.each(['gpt-4', 'gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-3.5-turbo'])(
    'reads %s as a sampling chat model taking system instructions',
    (id) => {
      expect(describeModelTraits(id)).toMatchObject({
        reasoning: false,
        supportsSampling: true,
        // Sending `reasoning_effort` here is an unknown parameter, not a
        // no-op.
        supportsReasoningEffort: false,
        minimumReasoningEffort: null,
        instructionRole: 'system',
      });
    },
  );
});

describe('describeModelTraits — ids nobody anticipated', () => {
  it.each([
    // A `gpt-` id with no generation this codebase can parse.
    'gpt-turbo-next',
    'gpt-omega',
    'chatgpt-latest',
    // Not a chat id at all.
    'some-future-model-2027',
    'ft:custom-tune-abc123',
  ])('gives %s the conservative chat shape, never the reasoning one', (id) => {
    // The asymmetry the module header argues. Guessing non-reasoning sends a
    // plain chat request, which every chat model accepts; guessing reasoning
    // sends `reasoning_effort` to a model that rejects the parameter, on the
    // first attempt, forever.
    expect(describeModelTraits(id)).toMatchObject({
      reasoning: false,
      supportsReasoningEffort: false,
      instructionRole: 'system',
    });
  });

  it('handles degenerate input without throwing', () => {
    expect(describeModelTraits('').reasoning).toBe(false);
    expect(describeModelTraits(undefined as unknown as string).reasoning).toBe(
      false,
    );
  });
});

describe('describeModelTraits — the completion floor', () => {
  it('gives a reasoning model room to finish reasoning before emitting', () => {
    // The bug in #176, stated as a number. A reasoning model spends its whole
    // budget on hidden reasoning tokens before a visible one, so a small cap
    // is a guaranteed `400 ... model output limit was reached` rather than a
    // cheap probe.
    expect(describeModelTraits('gpt-5.4').minCompletionTokens).toBeGreaterThanOrEqual(
      2048,
    );
    expect(describeModelTraits('o3-mini').minCompletionTokens).toBeGreaterThanOrEqual(
      2048,
    );
  });

  it('keeps a plain chat model cheap, but never at one token', () => {
    const floor = describeModelTraits('gpt-4o').minCompletionTokens;

    expect(floor).toBeGreaterThan(1);
    expect(floor).toBeLessThan(2048);
  });
});

describe('describeModelTraits — the returned object', () => {
  it('is a copy, so a caller cannot rewrite the table for the process', () => {
    const first = describeModelTraits('gpt-5.4');
    first.instructionRole = 'user';

    expect(describeModelTraits('gpt-5.4').instructionRole).toBe('developer');
  });
});
