import { hashSeed, mulberry32, shuffleWithSeed } from './seeded-random';

// =============================================================================
// seeded-random.ts — tests (issue #123, epic #57 / E8 "Mock interview")
// =============================================================================
//
// The four properties the engine actually depends on: the same seed gives the
// same order, different seeds (over a list long enough for it to mean
// something) give different orders, the result is a permutation of the input,
// and the input is untouched.
// =============================================================================

/** Long enough that two different seeds agreeing by chance is not a real risk. */
const POOL = Array.from({ length: 60 }, (_, index) => `q${String(index + 1).padStart(3, '0')}`);

describe('hashSeed', () => {
  it('is deterministic for the same string', () => {
    expect(hashSeed('interview-a')).toBe(hashSeed('interview-a'));
  });

  it('separates strings that differ by one character', () => {
    expect(hashSeed('interview-a')).not.toBe(hashSeed('interview-b'));
  });

  it('returns an unsigned 32-bit integer', () => {
    for (const seed of ['', 'a', 'interview-a', '9f2c0f6e-0000-4000-8000-000000000001']) {
      const hash = hashSeed(seed);
      expect(Number.isInteger(hash)).toBe(true);
      expect(hash).toBeGreaterThanOrEqual(0);
      expect(hash).toBeLessThan(2 ** 32);
    }
  });
});

describe('mulberry32', () => {
  it('produces the same stream for the same seed', () => {
    const a = mulberry32(12345);
    const b = mulberry32(12345);
    const streamA = Array.from({ length: 20 }, () => a());
    const streamB = Array.from({ length: 20 }, () => b());

    expect(streamA).toEqual(streamB);
  });

  it('stays inside [0, 1)', () => {
    const random = mulberry32(hashSeed('interview-a'));
    for (let i = 0; i < 1000; i += 1) {
      const value = random();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe('shuffleWithSeed', () => {
  it('gives an identical order for the same seed, across many repeated calls', () => {
    const first = shuffleWithSeed(POOL, 'interview-a');

    for (let run = 0; run < 50; run += 1) {
      expect(shuffleWithSeed(POOL, 'interview-a')).toEqual(first);
    }
  });

  it('gives a different order for a different seed', () => {
    expect(shuffleWithSeed(POOL, 'interview-a')).not.toEqual(
      shuffleWithSeed(POOL, 'interview-b'),
    );
  });

  it('returns a permutation — same elements, same count, order only', () => {
    const shuffled = shuffleWithSeed(POOL, 'interview-a');

    expect(shuffled).toHaveLength(POOL.length);
    expect([...shuffled].sort()).toEqual([...POOL].sort());
  });

  it('never mutates its input and never returns the same array object', () => {
    const input = [...POOL];
    const shuffled = shuffleWithSeed(input, 'interview-a');

    expect(input).toEqual(POOL);
    expect(shuffled).not.toBe(input);
  });

  it('handles the degenerate lengths without special-casing them', () => {
    expect(shuffleWithSeed([], 'interview-a')).toEqual([]);
    expect(shuffleWithSeed(['only'], 'interview-a')).toEqual(['only']);
  });
});
