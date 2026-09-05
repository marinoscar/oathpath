import {
  AI_COACH_PERSONAS,
  findCoachPersona,
  resolveCoachPersona,
} from './personas';
import { COACH_PERSONAS } from '../../common/schemas/user-settings-namespaces.schema';
import { bannedFamilyHits, BANNED_TOPIC_FAMILIES } from './banned-topics';

// =============================================================================
// personas.spec.ts (issue #318, epic #305 "The Coach's personality")
// =============================================================================
//
// This is the runtime companion to `personas.ts`'s own compile-time proof
// (`CoachPersonaRegistryCoversEnum`). That proof is real, but it does not run
// in CI's test job — it is checked only when something actually TYPE-CHECKS
// the file, and a CI pipeline that runs `jest` without also running `tsc`
// would ship a divergence with a green build. The key-set assertion below is
// the same fact, checked at a time this repo's test job definitely runs.
// =============================================================================

describe('AI_COACH_PERSONAS', () => {
  it('declares exactly four entries, keyed exactly supportive/academic/playful/unfiltered', () => {
    expect(AI_COACH_PERSONAS).toHaveLength(4);
    expect(AI_COACH_PERSONAS.map((p) => p.key)).toEqual([
      'supportive',
      'academic',
      'playful',
      'unfiltered',
    ]);
  });

  it('matches COACH_PERSONAS from the settings schema as a set and in order', () => {
    const registryKeys = AI_COACH_PERSONAS.map((p) => p.key);

    // As a SET: no key is declared on one side and missing from the other.
    expect(new Set(registryKeys)).toEqual(new Set(COACH_PERSONAS));

    // In the same ORDER: the settings enum and the registry are two lists
    // that must not merely agree on membership — the schema header says the
    // registry is what #318 makes `COACH_PERSONAS` derive from next, and an
    // order mismatch today is the seam that inversion will trip over.
    expect(registryKeys).toEqual([...COACH_PERSONAS]);
  });

  it('gives every entry a non-empty label, description and sampleLine', () => {
    const empty: string[] = [];
    for (const persona of AI_COACH_PERSONAS) {
      if (persona.label.trim().length === 0) empty.push(`${persona.key}.label`);
      if (persona.description.trim().length === 0) empty.push(`${persona.key}.description`);
      if (persona.sampleLine.trim().length === 0) empty.push(`${persona.key}.sampleLine`);
    }
    expect(empty).toEqual([]);
  });

  it('gives supportive the empty promptFragment — deliberately, not by oversight', () => {
    // `supportive` IS today's voice, not a persona that merely resembles it.
    // Every system message already carries its own tone paragraph
    // (`explain-prompt.ts`, `grading.ts`), and appending anything here would
    // be a second, paraphrased copy of that tone, free to drift from the
    // original. It would also change the bytes of a prompt that must stay
    // byte-identical for a learner who never opens the coach setting — #319's
    // own acceptance criterion. Appending nothing is the only way to
    // guarantee that, so the empty string is the assertion, not a TODO.
    const supportive = AI_COACH_PERSONAS.find((p) => p.key === 'supportive');
    expect(supportive?.promptFragment).toBe('');
  });

  it('gives every other persona a non-empty promptFragment', () => {
    const empty: string[] = [];
    for (const persona of AI_COACH_PERSONAS) {
      if (persona.key === 'supportive') continue;
      if (persona.promptFragment.trim().length === 0) {
        empty.push(`${persona.key}.promptFragment`);
      }
    }
    expect(empty).toEqual([]);
  });

  describe('findCoachPersona', () => {
    it('returns the matching entry for a known key', () => {
      expect(findCoachPersona('academic')?.key).toBe('academic');
      expect(findCoachPersona('playful')?.key).toBe('playful');
      expect(findCoachPersona('unfiltered')?.key).toBe('unfiltered');
      expect(findCoachPersona('supportive')?.key).toBe('supportive');
    });

    it('returns undefined for an unrecognised, empty, undefined or null key', () => {
      expect(findCoachPersona('nonsense')).toBeUndefined();
      expect(findCoachPersona('')).toBeUndefined();
      expect(findCoachPersona(undefined)).toBeUndefined();
      expect(findCoachPersona(null)).toBeUndefined();
    });
  });

  describe('resolveCoachPersona', () => {
    // The single place "absent means supportive" is decided. Every one of
    // these four inputs is a different way of NOT having a valid, known
    // persona on file, and all four must land on the exact same entry so
    // that no caller can independently invent a different fallback.
    it('resolves an unrecognised, empty, undefined or null key to supportive', () => {
      for (const input of ['nonsense', '', undefined, null] as const) {
        expect(resolveCoachPersona(input).key).toBe('supportive');
        expect(resolveCoachPersona(input)).toBe(AI_COACH_PERSONAS[0]);
      }
    });

    it('resolves a known key to the matching entry', () => {
      expect(resolveCoachPersona('academic').key).toBe('academic');
      expect(resolveCoachPersona('playful').key).toBe('playful');
      expect(resolveCoachPersona('unfiltered').key).toBe('unfiltered');
    });
  });

  // ---------------------------------------------------------------------------
  // The banned-topic lint, over the two fields this registry actually SERVES
  // (`GET /api/ai/coach/personas` projects `label`/`description`/`sampleLine`,
  // never `promptFragment` — see the header comment in personas.ts). This is
  // the same lint `reaction-lines.spec.ts` runs over the reaction bank,
  // imported from `./banned-topics` rather than re-declared, because
  // `sampleLine` and `description` are learner-facing copy served over an
  // endpoint exactly as the reaction bank is, and a persona card is exactly
  // as capable of crossing the floor as a reaction line is.
  // ---------------------------------------------------------------------------
  describe('banned-topic lint over description and sampleLine', () => {
    for (const family of BANNED_TOPIC_FAMILIES) {
      it(`trips no persona's description or sampleLine on "${family.name}" (${family.citation})`, () => {
        const violations: string[] = [];
        for (const persona of AI_COACH_PERSONAS) {
          for (const [field, text] of [
            ['description', persona.description],
            ['sampleLine', persona.sampleLine],
          ] as const) {
            const hits = bannedFamilyHits(text).filter((n) => n === family.name);
            if (hits.length > 0) {
              violations.push(`${persona.key}.${field}: ${JSON.stringify(text)}`);
            }
          }
        }
        expect(violations).toEqual([]);
      });
    }
  });
});
