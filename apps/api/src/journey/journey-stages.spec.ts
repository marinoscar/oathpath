import { JourneyStage } from '@prisma/client';

import {
  JOURNEY_STAGES,
  JOURNEY_STAGE_KEYS,
  JOURNEY_STAGES_MATCH_DATABASE_ENUM,
  findJourneyStage,
  isJourneyStageKey,
} from './journey-stages';

// =============================================================================
// Journey stage registry — tests (issue #65, epic #50)
// =============================================================================
//
// The registry is data, so most of what could go wrong with it is a mismatch
// with something else: the database enum, the journey's own order, or a
// consumer that expects copy to exist. Those are what is asserted here.
// =============================================================================

describe('journey stage registry', () => {
  it('declares the eight VISION.md stages in journey order', () => {
    expect(JOURNEY_STAGE_KEYS).toEqual([
      'uncertain',
      'oriented',
      'learning',
      'remembering',
      'speaking',
      'practicing',
      'performing',
      'ready',
    ]);
  });

  it('agrees exactly with the JourneyStage database enum', () => {
    // The compile-time proof in the registry catches a mismatch at build
    // time. This asserts the same fact at runtime, so a regression is
    // reported by a failing test rather than only by a red editor, and so the
    // proof itself cannot be deleted without something noticing.
    expect([...JOURNEY_STAGE_KEYS].sort()).toEqual(
      Object.values(JourneyStage).sort(),
    );
    expect(JOURNEY_STAGES_MATCH_DATABASE_ENUM).toBe(true);
  });

  it('starts at the stage a new profile is created in', () => {
    // `learner_profiles.stage` defaults to `uncertain`. If the first entry
    // ever stopped being that value, every freshly created profile would
    // render as being partway along a journey it has not started.
    expect(JOURNEY_STAGES[0].key).toBe('uncertain');
  });

  it('gives every stage a non-empty label and description', () => {
    for (const stage of JOURNEY_STAGES) {
      expect(stage.label.length).toBeGreaterThan(0);
      expect(stage.description.length).toBeGreaterThan(0);
    }
  });

  it('has no duplicate keys', () => {
    expect(new Set(JOURNEY_STAGE_KEYS).size).toBe(JOURNEY_STAGE_KEYS.length);
  });

  describe('findJourneyStage', () => {
    it('returns the entry for a known key', () => {
      expect(findJourneyStage('oriented')).toEqual({
        key: 'oriented',
        label: 'Oriented',
        description:
          "You've told us where you stand, so we can show you the right test and a real countdown.",
      });
    });

    it('returns undefined for an unknown key', () => {
      expect(findJourneyStage('graduated')).toBeUndefined();
    });
  });

  describe('isJourneyStageKey', () => {
    it.each([...JOURNEY_STAGE_KEYS])('accepts %s', (key) => {
      expect(isJourneyStageKey(key)).toBe(true);
    });

    it.each(['', 'Oriented', 'ninth', 'ready '])('rejects %p', (key) => {
      expect(isJourneyStageKey(key)).toBe(false);
    });
  });
});
