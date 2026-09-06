import {
  COACH_MIN_LINES_PER_ANSWER_CELL,
  COACH_MIN_LINES_PER_SESSION_CELL,
  COACH_REACTION_EVENTS,
  COACH_REACTION_LINES,
  NEUTRAL_REACTION_LINE,
} from './reaction-lines';
import type { CoachReactionEvent } from './reaction-lines';
import { COACH_PERSONAS } from '../../common/schemas/user-settings-namespaces.schema';
import { bannedFamilyHits, BANNED_TOPIC_FAMILIES } from './banned-topics';
import { reactionLine } from './select-line';
import {
  coachCorrectRunLengths,
  coachEventForAttempt,
  type CoachAttemptFacts,
} from './attempt-event';
import { coachEventForSessionSummary } from './session-event';
import { MAX_PLANNED_COUNT } from '../../practice/dto/create-practice-session.dto';

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

  // ===========================================================================
  // THE DEPTH FLOOR (issue #352) — A RULE, ENFORCED HERE, NOT A COMMENT
  // ===========================================================================
  //
  // #318 shipped three lines per cell and a comment claiming three was the
  // minimum. Three rotates visibly, which was defect 1 of #352. The floor is
  // now derived from `MAX_PLANNED_COUNT`, and these two tests are the reason
  // it cannot quietly stop being true: the first pins the number to the
  // product's own session cap, the second pins every cell to the number.
  // ===========================================================================

  it('sets the answer-cell floor to the largest session this application can create', () => {
    // `reaction-lines.ts` deliberately declares the floor as a literal rather
    // than importing this constant — it is a content module that imports
    // nothing at runtime. THIS is where the two are bound together: raising
    // `MAX_PLANNED_COUNT` without deepening the bank fails here, rather than
    // silently shortening the guarantee the bank's header claims.
    expect(COACH_MIN_LINES_PER_ANSWER_CELL).toBe(MAX_PLANNED_COUNT);
  });

  it('gives every cell at least its floor: MAX_PLANNED_COUNT lines for an answer event, six for a session event', () => {
    const tooFew: string[] = [];
    for (const persona of COACH_PERSONAS) {
      for (const event of COACH_REACTION_EVENTS) {
        const cell = COACH_REACTION_LINES[persona][event];
        const floor = event.startsWith('answer.')
          ? COACH_MIN_LINES_PER_ANSWER_CELL
          : COACH_MIN_LINES_PER_SESSION_CELL;
        if (cell.length < floor) {
          tooFew.push(
            `${persona}["${event}"]: ${cell.length} line(s), floor is ${floor}`,
          );
        }
      }
    }
    expect(tooFew).toEqual([]);
  });

  it('repeats no line anywhere in the bank — not within a cell, not across cells, not across personas', () => {
    // Stronger than the per-cell duplicate check below, and it has to be: a
    // single session draws from SEVERAL cells (a correct answer, a run, a
    // miss, a skip), so a line shared between two of them is a repeat a
    // learner can hear inside one session — exactly what the depth floor
    // exists to prevent, leaking in through the one gap depth cannot cover.
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const { persona, event, line } of ALL_LINES) {
      const where = `${persona}["${event}"]`;
      const previous = seen.get(line);
      if (previous !== undefined) {
        collisions.push(`${JSON.stringify(line)} appears in ${previous} and ${where}`);
      } else {
        seen.set(line, where);
      }
    }
    expect(collisions).toEqual([]);
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

// =============================================================================
// A FULL SESSION AT `MAX_PLANNED_COUNT` (issue #352)
// =============================================================================
//
// Defect 1 of #352 was that the bank repeats fast. These tests are the two
// halves of the fix, and they are deliberately separate because they prove
// different things and only one of them is a guarantee:
//
//   1. STRUCTURAL, AND TRUE FOR EVERY SESSION THAT CAN EXIST. No cell can be
//      exhausted by one session: whatever the learner does, there are at least
//      as many lines in the cell as there are draws from it, so a repeat is
//      never FORCED. This is exactly what the depth floor buys and it is
//      checked over the extreme outcome patterns — twenty misses, twenty
//      skips, twenty of anything — not over a comfortable average.
//
//   2. CONCRETE, AND TRUE FOR ONE REAL SESSION. `select-line.ts` picks with
//      `hash(seed) % lines.length`, and two attempt ids in one session can
//      hash to the same index however deep the cell is — that is modular
//      hashing, not a bank problem, and no depth removes it. So the second
//      test walks ONE full twenty-question session end to end, through the
//      real mappers, and asserts every line the learner reads is different.
//      Its attempt ids are fixed by this test exactly as a real session's are
//      fixed by the database; it is a regression guard over the shipped bank
//      and hash, not a proof for all id sets, and this comment says so rather
//      than letting a reader infer the stronger claim.
// =============================================================================

/** The narrow row shape the two mappers read. */
interface SimulatedAttempt {
  id: string;
  outcome: CoachAttemptFacts['outcome'];
  gradingMethod: CoachAttemptFacts['gradingMethod'];
  failureCause: string | null;
}

/**
 * The events a session of these attempts produces, in order.
 *
 * Goes through `coachCorrectRunLengths` and `coachEventForAttempt` — the same
 * two functions `PracticeService` calls — rather than reimplementing the
 * precedence here. A test that mapped outcomes to events itself would keep
 * passing after the real precedence changed underneath it.
 */
function simulateEvents(attempts: SimulatedAttempt[]): CoachReactionEvent[] {
  const runs = coachCorrectRunLengths(attempts);
  return attempts.map((attempt) =>
    coachEventForAttempt({
      outcome: attempt.outcome,
      gradingMethod: attempt.gradingMethod,
      failureCause: attempt.failureCause,
      correctRunLength: runs.get(attempt.id) ?? 0,
    }),
  );
}

/** `n` attempts that all reach the same outcome, with real-looking ids. */
function uniformSession(
  n: number,
  shape: Omit<SimulatedAttempt, 'id'>,
): SimulatedAttempt[] {
  return Array.from({ length: n }, (_, i) => ({
    ...shape,
    id: `pattern-attempt-${String(i + 1).padStart(2, '0')}`,
  }));
}

describe('COACH_REACTION_LINES — a full session can never exhaust a cell', () => {
  // Every extreme a learner can actually reach in one session, including the
  // pathological ones: twenty consecutive misses is a session somebody has,
  // and the guarantee has to hold for them and not only for a good day.
  const EXTREME_PATTERNS: { name: string; attempts: SimulatedAttempt[] }[] = [
    {
      name: 'every question correct',
      attempts: uniformSession(MAX_PLANNED_COUNT, {
        outcome: 'correct',
        gradingMethod: 'exact',
        failureCause: null,
      }),
    },
    {
      name: 'every question missed',
      attempts: uniformSession(MAX_PLANNED_COUNT, {
        outcome: 'incorrect',
        gradingMethod: 'exact',
        failureCause: null,
      }),
    },
    {
      name: 'every question skipped',
      attempts: uniformSession(MAX_PLANNED_COUNT, {
        outcome: 'skipped',
        gradingMethod: 'exact',
        failureCause: null,
      }),
    },
    {
      name: 'every question partially correct (the AI grader’s near-miss)',
      attempts: uniformSession(MAX_PLANNED_COUNT, {
        outcome: 'partial',
        gradingMethod: 'ai',
        failureCause: 'expression',
      }),
    },
    {
      name: 'every question self-marked',
      attempts: uniformSession(MAX_PLANNED_COUNT, {
        outcome: 'correct',
        gradingMethod: 'self',
        failureCause: null,
      }),
    },
    {
      name: 'every question misheard',
      attempts: uniformSession(MAX_PLANNED_COUNT, {
        outcome: 'incorrect',
        gradingMethod: 'exact',
        failureCause: 'misheard',
      }),
    },
    {
      // The pattern that maximises `answer.correct` specifically: a third
      // consecutive correct answer becomes `answer.correct_run`, so two
      // correct answers then a miss draws the plain cell as often as any
      // session can.
      name: 'correct, correct, missed, repeating',
      attempts: Array.from({ length: MAX_PLANNED_COUNT }, (_, i) => ({
        id: `alternating-attempt-${String(i + 1).padStart(2, '0')}`,
        outcome: (i % 3 === 2 ? 'incorrect' : 'correct') as CoachAttemptFacts['outcome'],
        gradingMethod: 'exact' as const,
        failureCause: null,
      })),
    },
  ];

  for (const pattern of EXTREME_PATTERNS) {
    it(`draws no cell deeper than it is: ${pattern.name}`, () => {
      const events = simulateEvents(pattern.attempts);
      expect(events).toHaveLength(MAX_PLANNED_COUNT);

      const draws = new Map<CoachReactionEvent, number>();
      for (const event of events) {
        draws.set(event, (draws.get(event) ?? 0) + 1);
      }

      const overdrawn: string[] = [];
      for (const persona of COACH_PERSONAS) {
        for (const [event, count] of draws) {
          const cell = COACH_REACTION_LINES[persona][event];
          if (count > cell.length) {
            overdrawn.push(
              `${persona}["${event}"]: drawn ${count} times, only ${cell.length} line(s)`,
            );
          }
        }
      }
      expect(overdrawn).toEqual([]);
    });
  }
});

describe('COACH_REACTION_LINES — one concrete full session repeats no line', () => {
  /**
   * A twenty-question session with the shape a real one has: mostly right,
   * three misses, two skips, one self-mark, one mishearing.
   *
   * The self-marked row's `outcome` is `correct` (that is what the column
   * says after `POST .../self-mark`) and its `gradingMethod` is `self`, so it
   * both continues the run for the attempts after it AND reacts as
   * `answer.self_marked` itself — the precedence `attempt-event.ts` states.
   */
  const SESSION_ID = 'session-0011';
  const OUTCOMES: Omit<SimulatedAttempt, 'id'>[] = [
    { outcome: 'correct', gradingMethod: 'exact', failureCause: null },
    { outcome: 'correct', gradingMethod: 'exact', failureCause: null },
    { outcome: 'incorrect', gradingMethod: 'exact', failureCause: null },
    { outcome: 'correct', gradingMethod: 'exact', failureCause: null },
    { outcome: 'correct', gradingMethod: 'exact', failureCause: null },
    { outcome: 'correct', gradingMethod: 'exact', failureCause: null },
    { outcome: 'skipped', gradingMethod: 'exact', failureCause: null },
    { outcome: 'correct', gradingMethod: 'exact', failureCause: null },
    { outcome: 'incorrect', gradingMethod: 'exact', failureCause: null },
    { outcome: 'correct', gradingMethod: 'exact', failureCause: null },
    { outcome: 'correct', gradingMethod: 'self', failureCause: null },
    { outcome: 'correct', gradingMethod: 'exact', failureCause: null },
    { outcome: 'correct', gradingMethod: 'exact', failureCause: null },
    { outcome: 'correct', gradingMethod: 'exact', failureCause: null },
    { outcome: 'incorrect', gradingMethod: 'exact', failureCause: null },
    { outcome: 'skipped', gradingMethod: 'exact', failureCause: null },
    { outcome: 'correct', gradingMethod: 'exact', failureCause: null },
    { outcome: 'correct', gradingMethod: 'exact', failureCause: null },
    { outcome: 'incorrect', gradingMethod: 'exact', failureCause: 'misheard' },
    { outcome: 'correct', gradingMethod: 'exact', failureCause: null },
  ];

  const ATTEMPTS: SimulatedAttempt[] = OUTCOMES.map((shape, i) => ({
    ...shape,
    id: `${SESSION_ID}-attempt-${String(i + 1).padStart(2, '0')}`,
  }));

  /** Every line the learner reads in this session, closing line included. */
  function sessionLines(persona: string): string[] {
    const events = simulateEvents(ATTEMPTS);
    const lines = ATTEMPTS.map((attempt, i) =>
      reactionLine(persona, events[i], attempt.id),
    );

    // The closing line, from the same summary numbers the session's own
    // response carries, seeded by the SESSION id — `toSessionResponse`'s rule.
    const answered = ATTEMPTS.length;
    const correct = ATTEMPTS.filter((a) => a.outcome === 'correct').length;
    lines.push(
      reactionLine(
        persona,
        coachEventForSessionSummary({ answered, correct }),
        SESSION_ID,
      ),
    );

    return lines;
  }

  it('is a full session at the maximum planned count', () => {
    expect(ATTEMPTS).toHaveLength(MAX_PLANNED_COUNT);
  });

  for (const persona of COACH_PERSONAS) {
    it(`says twenty-one different things to a ${persona} learner`, () => {
      const lines = sessionLines(persona);
      const repeated = lines.filter(
        (line, i) => lines.indexOf(line) !== i,
      );
      expect(repeated).toEqual([]);
      expect(new Set(lines).size).toBe(MAX_PLANNED_COUNT + 1);
    });

    it(`says the same twenty-one things when the session is re-read (${persona})`, () => {
      // The determinism guarantee at session scale, and the reason nothing is
      // stored: a learner who finishes a session and reopens its summary must
      // read the same lines, and `reactionLine` being pure in (persona, event,
      // seed) is the whole mechanism. See `select-line.ts`'s header for what
      // this does NOT promise — a later edit to the bank re-maps the seeds,
      // deliberately.
      expect(sessionLines(persona)).toEqual(sessionLines(persona));
    });
  }
});
