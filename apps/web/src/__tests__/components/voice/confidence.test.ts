import { describe, expect, it } from 'vitest';

import {
  ASR_CONFIDENCE_THRESHOLD,
  isLowConfidence,
  spokenDoubt,
} from '../../../components/voice/confidence';

// =============================================================================
// spokenDoubt / isLowConfidence — issue #348, epic #345 (E15)
// =============================================================================
//
// One property carries this file: `unmeasured` IS NOT `low`, and neither of
// them is the other's default.
//
// `isLowConfidence` answered a three-way question with two values, and the
// missing third is the one most learners are actually in: the recommended
// `gpt-4o-transcribe` family reports no confidence at all, so `null` was
// arriving on every single transcription and being read — correctly, for the
// rule as written — as "nothing to worry about". Correct, and silent about the
// fact that nothing had checked.
//
// The tests below pin all three states, and pin the two ways a future edit
// would most plausibly break this:
//
//   * collapsing `unmeasured` into `low`, which would apologise to every
//     learner on the recommended model about a transcript nothing doubted, and
//   * changing the default for a caller that has NOT been taught the new fact,
//     which would make an un-updated screen start apologising on its own.
// =============================================================================

describe('spokenDoubt', () => {
  it('reads a measured score below the threshold as `low`', () => {
    expect(spokenDoubt(0.41, true)).toBe('low');
  });

  it('trusts a measured score at or above the threshold', () => {
    // STRICTLY BELOW, matching the server exactly: the boundary has to fall on
    // one side, and trusting the transcript is the side that cannot invent a
    // mishearing that did not happen.
    expect(spokenDoubt(ASR_CONFIDENCE_THRESHOLD, true)).toBe('trusted');
    expect(spokenDoubt(0.97, true)).toBe('trusted');
  });

  it('reports `unmeasured` when the deployment cannot score at all', () => {
    // The state issue #348 was filed about. Not an error, not a degradation —
    // just a fact the copy beside the transcript is allowed to say out loud.
    expect(spokenDoubt(null, false)).toBe('unmeasured');
    expect(spokenDoubt(undefined, false)).toBe('unmeasured');
  });

  it('does NOT report `unmeasured` as `low`', () => {
    // The regression this file exists to prevent. Merging the two would greet
    // every learner on the recommended model with "that may not be what you
    // said" about a transcript nothing was ever uncertain about.
    expect(spokenDoubt(null, false)).not.toBe('low');
  });

  it('lets a real number win over the deployment fact', () => {
    // A model that scored THIS recording measured this recording, whatever a
    // coarse per-deployment predicate says it can do. The measurement is the
    // more specific fact, so it settles it.
    expect(spokenDoubt(0.41, false)).toBe('low');
    expect(spokenDoubt(0.9, false)).toBe('trusted');
  });

  it('falls back to today`s behaviour when the caller has not been told', () => {
    // A screen that has not threaded `confidenceAvailable` through must not
    // start apologising. `null` with nothing known stays exactly as quiet as
    // `isLowConfidence` has always been about it.
    expect(spokenDoubt(null)).toBe('trusted');
    expect(spokenDoubt(null, null)).toBe('trusted');
    expect(spokenDoubt(undefined, true)).toBe('trusted');
  });
});

describe('isLowConfidence', () => {
  it('still means exactly what it always meant', () => {
    // Kept, and now defined in terms of `spokenDoubt`, so the two can never
    // disagree about the threshold.
    expect(isLowConfidence(0.41)).toBe(true);
    expect(isLowConfidence(ASR_CONFIDENCE_THRESHOLD)).toBe(false);
    expect(isLowConfidence(0.97)).toBe(false);
  });

  it('is false for null and undefined — UNKNOWN IS NOT LOW', () => {
    expect(isLowConfidence(null)).toBe(false);
    expect(isLowConfidence(undefined)).toBe(false);
  });
});
