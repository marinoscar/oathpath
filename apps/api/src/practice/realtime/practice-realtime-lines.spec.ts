import {
  bannedFamilyHits,
  BANNED_TOPIC_FAMILIES,
} from '../../ai/coach/banned-topics';
import { PRACTICE_REALTIME_CLOSING_LINE } from './practice-realtime-lines';

// =============================================================================
// The one line this transport authors itself (issue #354, epic #345 / E15)
// =============================================================================
//
// Small file, small bank, and the same lint `reaction-lines.spec.ts` and
// `spoken-turn.spec.ts` already run over theirs. The point is not that one
// sentence is likely to break the floor today — it is that the sentence a
// learner hears LAST, in a warm voice, with no screen between them and it, is
// checked by the same mechanism as every other spoken string in this codebase
// rather than by whoever happened to review the pull request.
// =============================================================================

describe('PRACTICE_REALTIME_CLOSING_LINE', () => {
  for (const family of BANNED_TOPIC_FAMILIES) {
    it(`trips nothing on "${family.name}" (${family.citation})`, () => {
      expect(
        bannedFamilyHits(PRACTICE_REALTIME_CLOSING_LINE).filter(
          (name) => name === family.name,
        ),
      ).toEqual([]);
    });
  }

  it('carries no digit', () => {
    // `practice-realtime-instructions.ts`' own rule, applied to the closing.
    // A spoken count would be a second account of what the summary screen
    // shows, composed at a different moment from different data — and the
    // learner who stopped early does not need to be told a number.
    expect(PRACTICE_REALTIME_CLOSING_LINE).not.toMatch(/\d/);
  });

  it('interpolates nothing', () => {
    // A constant, not a frame. Nothing about the learner, the session, the
    // score or the question reaches it, so there is no path by which it could
    // say something nobody authored.
    expect(PRACTICE_REALTIME_CLOSING_LINE).not.toMatch(/[${}]/);
  });

  it('ends on a door rather than a grade', () => {
    // `COACH_INVARIANT_FLOOR`'s closing rule, checked at the one place this
    // transport gets the last word: no verdict vocabulary, and an invitation
    // back.
    expect(PRACTICE_REALTIME_CLOSING_LINE.toLowerCase()).not.toMatch(
      /\b(correct|incorrect|wrong|right|score|passed|failed)\b/,
    );
    expect(PRACTICE_REALTIME_CLOSING_LINE.toLowerCase()).toContain('come back');
  });
});
