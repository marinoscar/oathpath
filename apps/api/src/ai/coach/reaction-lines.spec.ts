import {
  COACH_REACTION_EVENTS,
  COACH_REACTION_LINES,
  NEUTRAL_REACTION_LINE,
} from './reaction-lines';
import { COACH_PERSONAS } from '../../common/schemas/user-settings-namespaces.schema';
import { bannedFamilyHits, BANNED_TOPIC_FAMILIES } from './banned-topics';

// =============================================================================
// reaction-lines.spec.ts (issue #318, epic #305 "The Coach's personality")
// =============================================================================
//
// This is the mechanical half of the guarantee `invariants.ts`'s header
// describes: the floor's seven rules are a REQUEST a model can in principle
// decline, but this bank is a finite, closed, human-authored set of strings,
// so a lint over it at merge time is a GUARANTEE rather than a hope.
//
// This suite is Jest, not Vitest — `expect()` here takes no second "custom
// message" argument (that is a Vitest-only overload). Every loop-based check
// below collects a `violations: string[]` array naming exactly which
// persona/event/line failed and asserts `expect(violations).toEqual([])`, so
// a failure's diff still names the offender without relying on an API this
// runner doesn't have.
// =============================================================================

const ALL_LINES: { persona: string; event: string; line: string }[] = [];
for (const persona of COACH_PERSONAS) {
  for (const event of COACH_REACTION_EVENTS) {
    for (const line of COACH_REACTION_LINES[persona][event]) {
      ALL_LINES.push({ persona, event, line });
    }
  }
}

describe('COACH_REACTION_LINES — matrix coverage', () => {
  it('has a cell for every persona × every event', () => {
    // Iterate both lists explicitly rather than `Object.keys` on the bank, so
    // a persona or event ADDED to the source-of-truth lists without a
    // matching cell fails here — a blank screen at merge time, not at
    // runtime for the first learner who picks it.
    const missing: string[] = [];
    for (const persona of COACH_PERSONAS) {
      for (const event of COACH_REACTION_EVENTS) {
        const cell = COACH_REACTION_LINES[persona]?.[event];
        if (cell === undefined) missing.push(`${persona}["${event}"]`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('gives every cell at least three lines', () => {
    const tooFew: string[] = [];
    for (const persona of COACH_PERSONAS) {
      for (const event of COACH_REACTION_EVENTS) {
        const cell = COACH_REACTION_LINES[persona][event];
        if (cell.length < 3) tooFew.push(`${persona}["${event}"]: only ${cell.length} line(s)`);
      }
    }
    expect(tooFew).toEqual([]);
  });

  it('has no empty (after trimming) or duplicate line within a cell', () => {
    const problems: string[] = [];
    for (const persona of COACH_PERSONAS) {
      for (const event of COACH_REACTION_EVENTS) {
        const cell = COACH_REACTION_LINES[persona][event];
        for (const line of cell) {
          if (line.trim().length === 0) {
            problems.push(`${persona}["${event}"] has an empty line`);
          }
        }
        if (new Set(cell).size !== cell.length) {
          problems.push(`${persona}["${event}"] has a duplicate line`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('never templates a line — no {, }, ${ or %s in any line', () => {
    // The bank is constants, never templates: the moment a line takes an
    // argument it becomes a template that can be pointed at untrusted text
    // (a question prompt, a learner's own response). See reaction-lines.ts's
    // own "NO INTERPOLATION, EVER" rule.
    const forbiddenTokens = ['{', '}', '${', '%s'];
    const problems: string[] = [];
    for (const { persona, event, line } of ALL_LINES) {
      for (const token of forbiddenTokens) {
        if (line.includes(token)) {
          problems.push(`${persona}["${event}"] contains "${token}": ${JSON.stringify(line)}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});

describe('COACH_REACTION_LINES — banned-topic lint (the centrepiece of #318)', () => {
  // Every line in every persona's bank, `unfiltered` included, PLUS the
  // neutral fallback — nothing is exempt from the floor just because it is
  // the safety-net line rather than a persona's own voice.
  const linesWithNeutral = [
    ...ALL_LINES,
    { persona: '(none)', event: '(neutral fallback)', line: NEUTRAL_REACTION_LINE },
  ];

  for (const family of BANNED_TOPIC_FAMILIES) {
    it(`trips no line on "${family.name}" (${family.citation})`, () => {
      const violations: string[] = [];
      for (const { persona, event, line } of linesWithNeutral) {
        const hits = bannedFamilyHits(line).filter((n) => n === family.name);
        if (hits.length > 0) {
          violations.push(`${persona}["${event}"]: ${JSON.stringify(line)}`);
        }
      }
      expect(violations).toEqual([]);
    });
  }
});

describe('COACH_REACTION_LINES — supportive is today’s voice', () => {
  // The bar for `supportive` is not "warm" — it is that a learner who never
  // opens the coach setting cannot tell E14 shipped at all. This does not
  // assert an exact string (the shipped lines are not `outcome.ts`'s exact
  // `detail` strings and are not meant to be), but it does assert something
  // meaningful: that `supportive` stays in the plain, unpunctuated register
  // those existing strings ("That matches an accepted answer." / "That
  // doesn't match an accepted answer.") already use, rather than drifting
  // toward the punchier registers the other three personas are allowed to
  // use. An exclamation mark, or the blunt imperative-mock tone `unfiltered`
  // uses ("Don't get comfortable."), would be the first sign this persona's
  // "voice" had quietly changed under a learner who never asked for that.
  it('never uses an exclamation mark, in any cell', () => {
    const violations: string[] = [];
    for (const event of COACH_REACTION_EVENTS) {
      for (const line of COACH_REACTION_LINES.supportive[event]) {
        if (line.includes('!')) {
          violations.push(`supportive["${event}"]: ${JSON.stringify(line)}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('never mocks the learner the way unfiltered’s lines do (no bare imperative addressed at them, no "don\'t")', () => {
    // A crude but defensible proxy for the imperative-mock register
    // `unfiltered` deliberately uses ("Don't get comfortable.", "Fine. That
    // one was correct."): `supportive` should not open a line with a bare
    // dismissive imperative. We check specifically for the phrase "don't get
    // comfortable" and the word "fine" as a standalone opener, both of which
    // appear in `unfiltered`'s bank and neither of which appears in
    // `supportive`'s today.
    const violations: string[] = [];
    for (const event of COACH_REACTION_EVENTS) {
      for (const line of COACH_REACTION_LINES.supportive[event]) {
        const lower = line.toLowerCase();
        if (lower.includes('don’t get comfortable') || lower.startsWith('fine.')) {
          violations.push(`supportive["${event}"]: ${JSON.stringify(line)}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

describe('COACH_REACTION_LINES — every wrong-answer line ends on a forward action (floor rule 7)', () => {
  // A defensible mechanical proxy, not a semantic one: each of
  // answer.incorrect / answer.partial / answer.skipped, for all four
  // personas, must contain at least one of a small set of forward-action
  // markers. If a shipped line fails this, that is reported rather than
  // fixed here by widening the marker list to fit — see this issue's own
  // instruction on the identical point for the banned-topic lint.
  const FORWARD_ACTION_MARKERS = [
    'read',
    'try',
    'go',
    'come back',
    'next time',
    'tomorrow',
    'review',
    'note',
    'study',
    'attempt',
    'finish',
    'practise',
  ];

  const WRONG_ANSWER_EVENTS = ['answer.incorrect', 'answer.partial', 'answer.skipped'] as const;

  it('contains a forward-action marker in every incorrect/partial/skipped line, for every persona', () => {
    const violations: string[] = [];
    for (const persona of COACH_PERSONAS) {
      for (const event of WRONG_ANSWER_EVENTS) {
        for (const line of COACH_REACTION_LINES[persona][event]) {
          const lower = line.toLowerCase();
          const hasMarker = FORWARD_ACTION_MARKERS.some((marker) => lower.includes(marker));
          if (!hasMarker) {
            violations.push(`${persona}["${event}"]: ${JSON.stringify(line)}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
