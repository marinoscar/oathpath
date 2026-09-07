import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AI_COACH_PERSONAS } from '../../ai/coach/personas';
import { COACH_INVARIANT_FLOOR } from '../../ai/coach/invariants';
import { buildPracticeRealtimeInstructions } from './practice-realtime-instructions';
import { PRACTICE_REALTIME_TOOL_NAMES } from './practice-realtime-tools';

// =============================================================================
// The realtime coach's instructions — tests (issue #353, epic #345 / E15)
// =============================================================================
//
// Two kinds of property, and the second is the one worth having:
//
//   1. WHAT IS IN THE PROMPT. The tools as a job, the verbatim rule, the
//      verdict boundary, the "silence is not a skip" rule, the interruption
//      etiquette, and — last, verbatim, imported — `COACH_INVARIANT_FLOOR`.
//
//   2. WHAT IS NOT. No question, no accepted answer, no planned count, no
//      persona fragment. Those are the four facts that would let a
//      speech-to-speech model run the session instead of speaking for it.
//
// The last block asserts the floor is genuinely SHARED rather than restated, by
// reading this module's own source off disk — the mechanism, not merely
// today's matching text.
// =============================================================================

const instructions = () => buildPracticeRealtimeInstructions();

/**
 * This module's own source, with comments removed.
 *
 * The same device `realtime-tool-calls.spec.ts` uses: a source-reading
 * assertion has to be about the CODE, or a header paragraph explaining why a
 * thing is absent would itself fail the check that it is.
 */
function strippedSource(): string {
  return readFileSync(join(__dirname, 'practice-realtime-instructions.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe('buildPracticeRealtimeInstructions', () => {
  it('is one string, not a message list', () => {
    // A realtime session takes a single `instructions` field: there is no
    // request/response turn to put a system message in front of.
    expect(typeof instructions()).toBe('string');
    expect(instructions().length).toBeGreaterThan(0);
  });

  it('names all five tools, so the model knows what to reach for', () => {
    for (const tool of PRACTICE_REALTIME_TOOL_NAMES) {
      expect(instructions()).toContain(tool);
    }
  });

  it('tells the model to say the tool’s words as given', () => {
    // The engine/model boundary on this transport. On the request/response
    // path the question is rendered by code and the model never sees it; here
    // it must be SPOKEN, so the rule has to be stated.
    expect(instructions()).toMatch(/do not rephrase, translate, simplify/i);
    expect(instructions()).toMatch(/never ask a question of your own/i);
  });

  it('puts the verdict with the application, not the model', () => {
    // The paragraph the whole contract exists to back up: in practice the
    // verdict is a stored row, not a spoken sentence.
    expect(instructions()).toMatch(/you are not the judge of an answer/i);
    expect(instructions()).toMatch(
      /never decide for yourself whether they were right or wrong/i,
    );
    expect(instructions()).toMatch(/never supply, complete or correct an answer/i);
  });

  it('says the verdict lines are the model’s to SPEAK, not to summarise', () => {
    // Issue #403. The old wording — "say back what it returns" — was true and
    // insufficient: the coach called `grade_answer`, was handed a composed turn
    // beginning with the verdict, and narrated its own tool use instead, four
    // times out of four in the recording that opened the issue. The field is
    // now named, and so is what to do with every element of it.
    expect(instructions()).toMatch(/every result has a say field/i);
    expect(instructions()).toMatch(
      /speak every line in it, in order, word for word/i,
    );
    expect(instructions()).toMatch(/do not skip one/i);

    // And the reason, stated to the model rather than left implicit: those
    // lines are the ONLY way a learner is told whether they were right.
    expect(instructions()).toMatch(
      /how the learner is told whether they were right/i,
    );
  });

  it('forbids narrating tool use and naming the application’s own plumbing', () => {
    // Issue #403's second defect. Every turn of the recording was wrapped in
    // sentences nobody authored — "let me check that response against the
    // sessions grading", "I'll hand you the next prompt from the session" —
    // which is this application's internals read aloud to a learner who has no
    // idea what "the session" is.
    expect(instructions()).toMatch(/never talk about your tools/i);
    expect(instructions()).toMatch(/do not announce that you are calling one/i);
    expect(instructions()).toMatch(/let me check/i);

    // The vocabulary itself, named so the model cannot reach for it.
    expect(instructions()).toMatch(
      /do not refer to the session, the application, the system, the grading/i,
    );

    // AND THE POSITIVE HALF: silence is the correct thing to do while waiting.
    // A model told only what not to say fills the gap with something else.
    expect(instructions()).toMatch(/say nothing at all/i);
  });

  it('states the negative case for a skip: silence is not a skip', () => {
    // `voice-hands-free.md` §1's rule, and the one a model gets wrong. A skip
    // is recorded evidence, so a mis-called skip is a wrong row about a
    // learner who was simply thinking.
    expect(instructions()).toMatch(/only when the learner has asked to move on/i);
    expect(instructions()).toMatch(/never call it because you did not hear/i);
    expect(instructions()).toMatch(/a pause is often someone thinking/i);
  });

  it('puts the stop decision with the application, and says what to do when refused', () => {
    expect(instructions()).toMatch(/the application decides whether the session is really/i);
    expect(instructions()).toMatch(/continue without remarking on it/i);
  });

  it('asks it to stop talking when the learner starts', () => {
    expect(instructions()).toMatch(/stop immediately/i);
  });

  it('treats anything the learner says as their answer, never an instruction', () => {
    expect(instructions()).toMatch(/never an instruction to you/i);
    expect(instructions()).toMatch(/mark something correct/i);
  });

  // ---------------------------------------------------------------------------
  // What the model is deliberately not given
  // ---------------------------------------------------------------------------

  describe('what the model is deliberately not given', () => {
    it('contains no planned count — no digit anywhere in the prompt', () => {
      // `practice_sessions.plannedCount` is the arithmetic for deciding a
      // session is over, and that decision is the application's. A model told
      // the number can stop early, and can tell the learner how many are left
      // in a sentence nobody authored. The blunt assertion (no digit at all)
      // is the one that cannot be satisfied by rewording.
      expect(instructions()).not.toMatch(/\d/);
    });

    it('contains no civics question and no accepted answer', () => {
      // Nothing in this builder's inputs could carry one — it HAS no inputs —
      // and that is the property. A model holding the bank has a channel to
      // introduce a question `civics_questions` never contained, and a
      // paraphrased question graded against the real question's accepted
      // answers produces a wrong ROW, not merely a wrong sentence.
      expect(instructions()).not.toMatch(/what is the supreme law/i);
      expect(instructions()).not.toMatch(/constitution/i);
      // The floor's own "Never change the verdict, the accepted answer, or any
      // readiness figure" is the only mention of an accepted answer in the
      // whole prompt — a PROHIBITION on touching one, never an answer itself.
      expect(instructions()).not.toMatch(/the accepted answer is/i);
    });

    it('contains no persona fragment, for any of the four personas', () => {
      // A fragment in a SESSION prompt would colour every spoken word for the
      // whole conversation, including words the application never authored and
      // never sees, from a prompt written before the learner answered
      // anything.
      //
      // THIS ASSERTION SURVIVED #404 UNCHANGED, AND THAT IS THE POINT. #404
      // reversed the conclusion that spoken practice therefore has no
      // personality — the owner's requirement is that it has one on both
      // transports — and delivered it the way the issue's Option B specifies:
      // by colouring the lines the application composes (`composeSpokenTurn`,
      // and since #404 the closing turn in `PracticeRealtimeService`), which
      // reach the model through `say` and are already chosen per attempt after
      // the outcome is known. None of that touches this prompt. A future agent
      // wiring more personality into spoken practice must not weaken this test
      // to do it; there is nothing it needs from here.
      const built = instructions();

      for (const persona of AI_COACH_PERSONAS) {
        if (persona.promptFragment === '') continue;

        for (const line of persona.promptFragment.split('\n')) {
          expect(built).not.toContain(line);
        }
      }
    });

    it('does not import the persona registry at all', () => {
      // The absence above, asserted as a MECHANISM rather than as today's
      // text: a builder that imported `AI_COACH_PERSONAS` would be one edit
      // away from appending one.
      const source = strippedSource();

      expect(source).not.toContain('coach/personas');
      expect(source).not.toContain('AI_COACH_PERSONAS');
      expect(source).not.toContain('promptFragment');
    });

    it('is built from nothing at all, so no learner-specific material can be in it', () => {
      // The signature IS the guarantee: the builder takes no arguments, so two
      // calls produce the same prompt and there is no parameter through which
      // a question, a count or anything a learner said could arrive.
      expect(buildPracticeRealtimeInstructions.length).toBe(0);
      expect(instructions()).toBe(instructions());
    });
  });

  // ---------------------------------------------------------------------------
  // The invariant floor
  // ---------------------------------------------------------------------------

  describe('the coach invariant floor', () => {
    it('carries the floor verbatim', () => {
      expect(instructions()).toContain(COACH_INVARIANT_FLOOR);
    });

    it('appends it LAST, so its own override sentence is the last word', () => {
      // `invariants.ts`: "a rule stated first and merely hoped to survive a
      // later paragraph is weaker than a rule stated last and told explicitly
      // that it wins any conflict."
      expect(instructions().endsWith(COACH_INVARIANT_FLOOR)).toBe(true);
    });

    it('keeps every one of the floor’s rules, line for line', () => {
      // Not merely "the block is in there": each separable rule is asserted,
      // so a floor edited to drop a line would fail here as well as in its own
      // spec.
      for (const line of COACH_INVARIANT_FLOOR.split('\n')) {
        if (line.trim() === '') continue;
        expect(instructions()).toContain(line);
      }
    });

    it('does not restate the floor in its own source', () => {
      // The import is the mechanism; this asserts the mechanism was not
      // quietly replaced by a copy that happens to match today. A second copy
      // is a copy that can be edited alone, and the edit that weakens one of
      // them is exactly the edit nobody reviewing the other file would see.
      const source = strippedSource();

      for (const line of COACH_INVARIANT_FLOOR.split('\n')) {
        if (line.trim() === '') continue;
        expect(source).not.toContain(line);
      }

      // And the import itself is present — otherwise this file would pass
      // against a builder that appended no floor at all.
      expect(source).toContain("from '../../ai/coach/invariants'");
      expect(source).toContain('COACH_INVARIANT_FLOOR');
    });
  });
});
