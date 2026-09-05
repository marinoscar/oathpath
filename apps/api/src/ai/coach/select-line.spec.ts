import { randomUUID } from 'node:crypto';
import { reactionLine } from './select-line';
import { COACH_REACTION_EVENTS, COACH_REACTION_LINES, NEUTRAL_REACTION_LINE } from './reaction-lines';
import { COACH_PERSONAS } from '../../common/schemas/user-settings-namespaces.schema';

// =============================================================================
// select-line.spec.ts (issue #318, epic #305 "The Coach's personality")
// =============================================================================
//
// `reactionLine` is pure, total, and deterministic in `seed`. These tests
// cover exactly those three properties, plus that different seeds actually
// spread across a cell rather than degenerating onto one line.
// =============================================================================

// A few hundred synthetic seeds shaped like the real input: attempt/session
// ids are uuids in this codebase.
const SEEDS = Array.from({ length: 500 }, () => randomUUID());

describe('reactionLine — determinism', () => {
  it('returns the same string for the same (persona, event, seed) across many repeated calls', () => {
    const seed = randomUUID();
    const first = reactionLine('supportive', 'answer.correct', seed);
    for (let i = 0; i < 50; i += 1) {
      expect(reactionLine('supportive', 'answer.correct', seed)).toBe(first);
    }
  });

  it('returns the same string across a fresh module import', () => {
    // `jest.isolateModules` forces a fresh require of the module graph, so
    // this is not merely re-calling the same closure — it re-runs the
    // module's top-level code, exactly as a new process would.
    const seed = randomUUID();
    const before = reactionLine('unfiltered', 'session.complete_weak', seed);

    let after = '';
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fresh = require('./select-line');
      after = fresh.reactionLine('unfiltered', 'session.complete_weak', seed);
    });

    expect(after).toBe(before);
  });
});

describe('reactionLine — spread', () => {
  it('selects every line in a multi-line cell at least once over ~500 seeds, for every persona × event', () => {
    // "Every line appears at least once over N seeds" is the right shape —
    // robust to exactly which hash values land where. A chi-squared test
    // would be brittle: it would fail on a perfectly acceptable distribution
    // just because FNV-1a is not a cryptographic PRNG.
    const neverSelected: string[] = [];
    for (const persona of COACH_PERSONAS) {
      for (const event of COACH_REACTION_EVENTS) {
        const cell = COACH_REACTION_LINES[persona][event];
        const seen = new Set<string>();
        for (const seed of SEEDS) {
          seen.add(reactionLine(persona, event, seed));
        }
        for (const line of cell) {
          if (!seen.has(line)) {
            neverSelected.push(`${persona}["${event}"]: ${JSON.stringify(line)}`);
          }
        }
      }
    }
    expect(neverSelected).toEqual([]);
  });

  it('is not wildly degenerate: no single line takes more than 80% of selections in a multi-line cell', () => {
    const degenerate: string[] = [];
    for (const persona of COACH_PERSONAS) {
      for (const event of COACH_REACTION_EVENTS) {
        const cell = COACH_REACTION_LINES[persona][event];
        if (cell.length < 2) continue;
        const counts = new Map<string, number>();
        for (const seed of SEEDS) {
          const line = reactionLine(persona, event, seed);
          counts.set(line, (counts.get(line) ?? 0) + 1);
        }
        const max = Math.max(...counts.values());
        if (max / SEEDS.length >= 0.8) {
          degenerate.push(`${persona}["${event}"]: one line took ${max}/${SEEDS.length} selections`);
        }
      }
    }
    expect(degenerate).toEqual([]);
  });
});

describe('reactionLine — seed sensitivity', () => {
  it('returns more than one distinct line across many seeds, for a cell with more than one line', () => {
    const stuck: string[] = [];
    for (const persona of COACH_PERSONAS) {
      for (const event of COACH_REACTION_EVENTS) {
        const cell = COACH_REACTION_LINES[persona][event];
        if (cell.length < 2) continue;
        const seen = new Set<string>();
        for (const seed of SEEDS) {
          seen.add(reactionLine(persona, event, seed));
        }
        if (seen.size <= 1) {
          stuck.push(`${persona}["${event}"]: only one distinct line across ${SEEDS.length} seeds`);
        }
      }
    }
    expect(stuck).toEqual([]);
  });
});

describe('reactionLine — totality', () => {
  // The same open-set-on-the-wire discipline `outcomeDisplay` (apps/web's
  // `outcome.ts`) already applies for a newer server's value this build has
  // never heard of: say the one thing that is certainly true rather than
  // return `undefined` or throw.
  it('returns NEUTRAL_REACTION_LINE for an unknown persona', () => {
    expect(reactionLine('nonsense', 'answer.correct', randomUUID())).toBe(NEUTRAL_REACTION_LINE);
  });

  it('returns NEUTRAL_REACTION_LINE for an unknown event', () => {
    expect(reactionLine('supportive', 'nonsense', randomUUID())).toBe(NEUTRAL_REACTION_LINE);
  });

  it('returns NEUTRAL_REACTION_LINE for an empty persona', () => {
    expect(reactionLine('', 'answer.correct', randomUUID())).toBe(NEUTRAL_REACTION_LINE);
  });

  it('returns NEUTRAL_REACTION_LINE for an empty event', () => {
    expect(reactionLine('supportive', '', randomUUID())).toBe(NEUTRAL_REACTION_LINE);
  });

  it('returns NEUTRAL_REACTION_LINE for an empty seed (never undefined, never a throw)', () => {
    expect(() => reactionLine('supportive', 'answer.correct', '')).not.toThrow();
    // An empty seed is still a valid string seed — hashSeed('') is well
    // defined (the FNV offset basis, unmodified) — so this is not a case of
    // falling through to the neutral line; it is confirming the ordinary
    // path handles it without throwing and returns a real line from the
    // cell.
    const result = reactionLine('supportive', 'answer.correct', '');
    expect(typeof result).toBe('string');
    expect(COACH_REACTION_LINES.supportive['answer.correct']).toContain(result);
  });
});

describe('reactionLine — the returned value is always a member of its cell', () => {
  it('never returns a string absent from the cell it was drawn from', () => {
    for (const persona of COACH_PERSONAS) {
      for (const event of COACH_REACTION_EVENTS) {
        const cell = COACH_REACTION_LINES[persona][event];
        for (const seed of SEEDS.slice(0, 50)) {
          const result = reactionLine(persona, event, seed);
          expect(cell).toContain(result);
        }
      }
    }
  });
});
