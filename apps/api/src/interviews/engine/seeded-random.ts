// =============================================================================
// Seeded shuffle (issue #123, epic #57 / E8 "Mock interview — text mode")
// =============================================================================
//
// A 32-bit hash, a small PRNG, and a Fisher-Yates shuffle driven by them.
// Pure, self-contained, and dependency-free: no NestJS, no Prisma, no
// `Math.random`, no `Date`. Two calls with the same seed produce the same
// permutation on any machine, in any process, in any year.
//
// -----------------------------------------------------------------------------
// WHY SEEDED HERE, WHEN `practice/question-selection.ts` DELIBERATELY IS NOT
// -----------------------------------------------------------------------------
//
// `shuffleRandomly` in `practice/question-selection.ts` uses `Math.random` on
// purpose, and its own header explains why: a seeded practice shuffle would
// hand two learners with identical histories identical Quick 5s, and would
// hand one learner the same five questions back every time they restarted.
// For practice, reproducibility is a product loss.
//
// A mock interview is the opposite case, because an interview is a single
// durable OBJECT with an id, not a stream of exercises. Its question sequence
// must be reproducible **from its own id**:
//
//   - A resume must continue the same interview. A learner who closes the tab
//     after question 4 and returns an hour later must be asked question 5 of
//     the sequence they started, not question 5 of a freshly-rolled one. The
//     plan is derivable from the id, so a resume needs no second source of
//     truth and cannot disagree with the first.
//   - A debrief must describe the interview that happened. Re-deriving the
//     plan later — for a transcript view, a report, a backfill — must produce
//     the sequence the learner actually saw.
//   - A bug report must be reproducible. "Interview <id> asked me the same
//     question twice" is investigable when the id alone regenerates the plan;
//     it is not investigable when the order lived only in one process's memory.
//   - A test must be able to assert an exact order without stubbing globals.
//
// Reproducibility is bought here and NOT paid for in sameness, because the
// seed is the interview's own id: two learners get different interviews, and
// the same learner's second interview gets a different id and therefore a
// different order. Determinism per interview, variety across interviews.
// =============================================================================

/**
 * FNV-1a, 32-bit — a seed string folded into a seed number.
 *
 * Chosen for being short, well-known, and completely specified by its two
 * constants, so this function can be read in full and has no hidden state. It
 * is NOT a cryptographic hash and must never be used as one: nothing here
 * resists collision or preimage attack, and nothing needs to. The only
 * property required is that the same string always yields the same number.
 *
 * `>>> 0` after the multiply keeps every intermediate in unsigned 32-bit
 * range, so the result is identical on every JavaScript engine rather than
 * drifting with how a given engine happens to represent an overflowed int.
 */
export function hashSeed(seed: string): number {
  let hash = 0x811c9dc5; // FNV offset basis, 32-bit
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    // FNV prime, 32-bit (16777619), expressed as shifts and adds so the
    // multiply stays inside 32 bits without relying on float precision.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

/**
 * mulberry32 — a 32-bit PRNG returning values in [0, 1).
 *
 * Stateful by construction (each call advances an internal counter), but the
 * state is entirely local to the returned closure: two generators built from
 * the same seed produce the same stream, and neither can observe the other.
 * That is what makes {@link shuffleWithSeed} pure despite using one.
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fisher-Yates over a COPY, driven by `mulberry32(hashSeed(seed))`.
 *
 * PURE: the input array is never mutated, a new array is always returned, and
 * the result is a permutation of the input — same elements, same count, only
 * the order differs. The same `(items, seed)` pair produces the same array
 * forever; see this file's header for why an interview needs that and practice
 * does not.
 */
export function shuffleWithSeed<T>(items: readonly T[], seed: string): T[] {
  const out = [...items];
  const random = mulberry32(hashSeed(seed));

  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }

  return out;
}
