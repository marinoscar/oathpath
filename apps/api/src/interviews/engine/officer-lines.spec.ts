import { FALLBACK_OFFICER_LINES, N400_PROMPTS, fallbackOfficerLine } from './officer-lines';
import { INTERVIEW_PHASES } from './phases';

// =============================================================================
// officer-lines.ts — tests (issue #123, epic #57 / E8 "Mock interview")
// =============================================================================
//
// The property that matters here is not the prose. It is that the N-400
// rehearsal prompts ask for no real data — see that file's header for the rule
// and the failure mode it prevents. The assertions below are deliberately
// crude (no question marks, no digits, an explicit "practise" invitation)
// because a crude assertion is one a future edit trips over, and the wrong
// shape of prompt ("How many trips have you taken since 2020?") trips all
// three.
// =============================================================================

describe('N400_PROMPTS', () => {
  it('offers at least three prompts', () => {
    expect(N400_PROMPTS.length).toBeGreaterThanOrEqual(3);
  });

  it('never asks the learner for a real fact about themselves', () => {
    for (const prompt of N400_PROMPTS) {
      // A question mark is the tell: these name a topic and invite practice,
      // they do not interrogate.
      expect(prompt).not.toContain('?');
      // A digit in one of these is almost always a year, a count, or a
      // duration — i.e. a request for specifics about the applicant.
      expect(prompt).not.toMatch(/\d/);
      expect(prompt.toLowerCase()).toContain('practise how you would answer');
    }
  });

  it('describes what the officer will ask about, rather than asking it', () => {
    for (const prompt of N400_PROMPTS) {
      expect(prompt).toContain('The officer will ask');
    }
  });
});

describe('FALLBACK_OFFICER_LINES', () => {
  it('covers every phase, plus the greeting and the acknowledgement', () => {
    for (const phase of INTERVIEW_PHASES) {
      expect(typeof FALLBACK_OFFICER_LINES[phase]).toBe('string');
      expect(FALLBACK_OFFICER_LINES[phase].length).toBeGreaterThan(0);
    }

    expect(FALLBACK_OFFICER_LINES.greeting.length).toBeGreaterThan(0);
    expect(FALLBACK_OFFICER_LINES.acknowledgement.length).toBeGreaterThan(0);
  });

  it('says plainly that the skipped segments are not part of this rehearsal', () => {
    expect(FALLBACK_OFFICER_LINES.reading).toContain('does not include the reading test');
    expect(FALLBACK_OFFICER_LINES.writing).toContain('does not include the writing test');
  });

  it('never lets the acknowledgement reveal an outcome — wording, never verdict', () => {
    const acknowledgement = FALLBACK_OFFICER_LINES.acknowledgement.toLowerCase();

    for (const verdict of ['correct', 'incorrect', 'right', 'wrong', 'pass', 'fail']) {
      expect(acknowledgement).not.toContain(verdict);
    }
  });
});

describe('fallbackOfficerLine', () => {
  it('opens with the greeting on the first turn', () => {
    expect(fallbackOfficerLine('smalltalk', true)).toBe(FALLBACK_OFFICER_LINES.greeting);
  });

  it('uses the phase line on every later turn', () => {
    expect(fallbackOfficerLine('smalltalk', false)).toBe(FALLBACK_OFFICER_LINES.smalltalk);
    expect(fallbackOfficerLine('civics', false)).toBe(FALLBACK_OFFICER_LINES.civics);
    expect(fallbackOfficerLine('closing', false)).toBe(FALLBACK_OFFICER_LINES.closing);
  });
});
