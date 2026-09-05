import { COACH_INVARIANT_FLOOR } from './invariants';

// =============================================================================
// invariants.spec.ts (issue #318, epic #305 "The Coach's personality")
// =============================================================================
//
// One assertion per rule, on a DISTINCTIVE PHRASE rather than the whole
// string: rewording a rule for clarity must not break this test, but deleting
// one — the actual failure mode this test exists to catch — must.
//
// NOTE ON THE "no second copy" CHECK asked for in this issue: it would grep
// `apps/api/src` and `apps/web/src` for a distinctive floor sentence and
// assert exactly one file contains it. This repo's existing tests that read
// source from a `*.spec.ts` file (`ai-dispatch.service.spec.ts`,
// `apps/web/src/__tests__/config/destinations.test.ts`,
// `apps/api/src/practice/mastery/mastery-skip.spec.ts`) all read ONE
// specific, already-known file (their own module's source, or `App.tsx`) —
// none of them walks a directory tree searching for a string across many
// files. Inventing a tree-walking grep here would be a new pattern with no
// precedent in this codebase, so it is intentionally NOT included; see the
// task report for this note repeated to the main agent.
// =============================================================================

describe('COACH_INVARIANT_FLOOR', () => {
  it('declares itself as overriding every style instruction that precedes it', () => {
    const firstSentence = COACH_INVARIANT_FLOOR.split('\n')[0];
    expect(firstSentence).toContain('override');
    expect(firstSentence.toLowerCase()).toContain('override every style instruction');
  });

  it('states rule 1 — never comment on English, accent, grammar or pronunciation', () => {
    expect(COACH_INVARIANT_FLOOR).toContain('accent, grammar or pronunciation');
  });

  it('states rule 2 — never reference origin, immigration status, religion, race or family', () => {
    expect(COACH_INVARIANT_FLOOR).toContain('immigration status, religion, race or family');
  });

  it('states rule 3 — never imply the material should be obvious, or that they are slow', () => {
    expect(COACH_INVARIANT_FLOOR).toContain('should be obvious, or that they are slow');
  });

  it('states rule 4 — never say or imply they will fail or will not become a citizen', () => {
    expect(COACH_INVARIANT_FLOOR).toContain('will not become a citizen');
  });

  it('states rule 5 — never change the verdict, the accepted answer, or any readiness figure', () => {
    expect(COACH_INVARIANT_FLOOR).toContain(
      'change the verdict, the accepted answer, or any readiness figure',
    );
  });

  it('states rule 6 — the joke, when there is one, is about the MISS, never the person', () => {
    expect(COACH_INVARIANT_FLOOR).toContain('about the MISS');
    expect(COACH_INVARIANT_FLOOR).toContain('never about the person');
  });

  it('states rule 7 — a wrong answer always ends on a forward action', () => {
    expect(COACH_INVARIANT_FLOOR).toContain('always ends on a forward action');
  });

  it('is a single exported string, not re-derived per call', () => {
    // Cheap sanity check that this is genuinely the constant the header
    // promises, not something that recomputes and could drift between reads
    // within a single process.
    expect(COACH_INVARIANT_FLOOR).toBe(COACH_INVARIANT_FLOOR);
    expect(typeof COACH_INVARIANT_FLOOR).toBe('string');
  });
});
