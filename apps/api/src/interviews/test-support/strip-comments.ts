// =============================================================================
// strip-comments (issue #133, epic #57 / E8) — test support only
// =============================================================================
//
// Several tests in this module assert a property of what a file's CODE does not
// contain — most importantly that no pass-mark literal appears anywhere in the
// interview path, which `mock-interview.md` §4 requires and
// `interview-engine.spec.ts` already enforces one layer down by reading the
// engine's own source off disk.
//
// That technique needs one adjustment here. `interview-engine.ts` cites the
// spec sparingly; `debrief.ts` and `interviews.service.ts` cite it constantly —
// "§11", "§4.1", "§2.4", "rung 2", "120 seconds" — and a naive scan counts every
// one of those as a numeric literal. The result would be a test that punishes
// the thing this codebase asks for most: explaining why, at length, next to the
// code. So comments come out first, and the assertion is made against the code
// that remains.
//
// -----------------------------------------------------------------------------
// A REGEX, AND WHY THAT IS ENOUGH HERE
// -----------------------------------------------------------------------------
//
// This is not a TypeScript parser and does not try to be. It is deliberately
// naive about one case — a `//` or `/*` sequence appearing inside a string
// literal, which it would treat as the start of a comment and delete from
// there. That is acceptable for exactly this use, and stating why matters more
// than the code does:
//
//   * It is used only by tests in this module, against files in this module.
//   * Its failure mode is to remove MORE than it should, which can only make an
//     "X does not appear" assertion pass more easily on a file that gained an
//     unusual string — never fail a correct file spuriously.
//   * The one thing that would matter — a pass-mark literal hidden inside a
//     string after a `//` inside another string — is not a way anybody writes a
//     threshold, and would be caught by the behavioural tests either way.
//
// Reaching for the TypeScript compiler API to do this properly would be a real
// dependency and real setup cost in a spec, for a guarantee the assertions
// above do not need.
// =============================================================================

/**
 * The source with `//` line comments and block comments removed.
 *
 * Block comments first, so a `//` inside one cannot survive as a line comment
 * marker after the block around it is gone.
 */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}
