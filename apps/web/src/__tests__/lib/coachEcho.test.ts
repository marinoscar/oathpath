/**
 * `isLikelyCoachEcho` — issue #399, epic #345 / E15.
 *
 * This module decides whether a real answer gets thrown away. A false
 * positive here silently discards a learner's correct answer and asks the
 * question again instead; a false negative lets an echoed question through to
 * be graded as though the learner had spoken. Both failure directions are
 * covered explicitly below, not just the happy path.
 *
 * `coachEcho.ts`'s own header states what this function is NOT: a grading
 * check, a fuzzy match, or anything that reads the transcript for meaning. The
 * tests in the last section hold that line by reading the module's own
 * source, the same technique `useRealtimePractice.source.test.ts` uses for
 * the hook — see that file's header for why the two are separate rather than
 * one test reading both modules.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  ECHO_MIN_CONTAINED_WORDS,
  isLikelyCoachEcho,
} from '../../lib/coachEcho';

const here = dirname(fileURLToPath(import.meta.url));

describe('exact matches are refused at any length', () => {
  it('refuses a single-word echo identical to a single-word coach line', () => {
    expect(isLikelyCoachEcho('constitution', 'Constitution.')).toBe(true);
  });

  it('refuses a full-sentence echo, case and punctuation aside', () => {
    const coach = 'Where is the Statue of Liberty?';
    expect(isLikelyCoachEcho('where is the statue of liberty', coach)).toBe(
      true,
    );
    expect(
      isLikelyCoachEcho('WHERE IS THE STATUE OF LIBERTY?!', coach),
    ).toBe(true);
  });

  it('refuses an exact match even when it is shorter than the containment floor', () => {
    // Two words — well under ECHO_MIN_CONTAINED_WORDS — but the WHOLE of what
    // the coach said, word for word. A coincidence this exact is not one worth
    // protecting.
    expect(isLikelyCoachEcho('New York', 'New York')).toBe(true);
    expect(2).toBeLessThan(ECHO_MIN_CONTAINED_WORDS);
  });
});

describe('a clipped echo is refused once it reaches the containment floor', () => {
  const coach =
    'The Constitution was written in 1787 and later ratified by the states.';

  it('does not refuse a shorter tail run that falls under the floor', () => {
    // Four words — see the boundary test below for the floor itself.
    expect(isLikelyCoachEcho('ratified by the states', coach)).toBe(false);
  });

  it('refuses a run of exactly ECHO_MIN_CONTAINED_WORDS words, in the coach’s own order', () => {
    expect(isLikelyCoachEcho('written in 1787 and later', coach)).toBe(true);
  });

  it('refuses a run from the MIDDLE of the coach’s utterance, not only the tail', () => {
    expect(
      isLikelyCoachEcho('was written in 1787 and', coach),
    ).toBe(true);
  });

  it('does not refuse a run one word short of the floor', () => {
    // Four words. Below ECHO_MIN_CONTAINED_WORDS, and not the whole utterance
    // either, so it is treated as ordinary (if wrong) learner speech.
    expect(ECHO_MIN_CONTAINED_WORDS).toBe(5);
    expect(isLikelyCoachEcho('written in 1787 and', coach)).toBe(false);
  });

  it('requires the coach’s OWN ORDER — a reordered run of the same words is not an echo', () => {
    // Same five words as the passing case above, scrambled. This is not what
    // a garbled echo of continuous audio looks like, and treating it as one
    // would only ever discard a genuine (if oddly phrased) answer.
    expect(
      isLikelyCoachEcho('and 1787 written later in', coach),
    ).toBe(false);
  });
});

describe('a short answer that happens to reuse the question’s words is graded', () => {
  it('does not refuse "the president" inside "who is the president now"', () => {
    // The task's own worked example: a short, legitimate answer that is a
    // genuine substring of the question. Two words, well under the floor, and
    // not the whole question either.
    expect(
      isLikelyCoachEcho('the president', 'Who is the president now?'),
    ).toBe(false);
  });

  it('does not refuse a one-word answer that is merely A word of a longer question', () => {
    expect(
      isLikelyCoachEcho(
        'liberty',
        'Where is the Statue of Liberty located in New York Harbor?',
      ),
    ).toBe(false);
  });
});

describe('an answer longer than, or different from, the question is never touched', () => {
  it('does not refuse an answer longer than the coach’s utterance', () => {
    // The whole coach line appears inside the transcript, but the transcript
    // itself is longer — a learner who answered in a full sentence that
    // happens to quote the question back. §'s own rule: refusal is
    // ONE-DIRECTIONAL, the transcript must fit INSIDE what the coach said.
    expect(
      isLikelyCoachEcho(
        'the supreme law of the land is the constitution, adopted in 1787',
        'What is the supreme law of the land?',
      ),
    ).toBe(false);
  });

  it('does not refuse an answer that shares no run of words with the coach line', () => {
    expect(
      isLikelyCoachEcho(
        'the bill of rights',
        'What is the supreme law of the land?',
      ),
    ).toBe(false);
  });

  it('does not refuse a wrong-but-genuine answer of unrelated length and content', () => {
    expect(
      isLikelyCoachEcho(
        'I think it might be the declaration of independence',
        'What is the supreme law of the land?',
      ),
    ).toBe(false);
  });
});

describe('the one-directional property, tested directly', () => {
  it('refuses (needle in haystack) but not the reverse (haystack in needle)', () => {
    const short = 'freedom of speech freedom of religion';
    const long =
      'The First Amendment protects freedom of speech, freedom of religion, and freedom of the press.';

    // The short one is fully contained, in order, inside the long one — but it
    // is only 6 normalised words, so this exercises containment rather than
    // the exact-match branch.
    expect(isLikelyCoachEcho(short, long)).toBe(true);

    // Reversed: the long transcript is NOT contained inside the short "coach"
    // utterance, so it must never be refused, however suspicious a naive
    // symmetric check might find it.
    expect(isLikelyCoachEcho(long, short)).toBe(false);
  });
});

describe('unknown provenance is not suspicious provenance', () => {
  it('never refuses when there is no coach utterance to compare against', () => {
    expect(isLikelyCoachEcho('anything at all', null)).toBe(false);
  });

  it('never refuses against an empty coach utterance', () => {
    expect(isLikelyCoachEcho('anything at all', '')).toBe(false);
  });

  it('never refuses an empty transcript', () => {
    // Not this function's problem — an empty `grade_answer` transcript is a
    // different call shape the API's own empty-transcript rejection covers.
    expect(isLikelyCoachEcho('', 'Where is the Statue of Liberty?')).toBe(
      false,
    );
  });

  it('treats a coach utterance of only punctuation/whitespace as nothing to compare against', () => {
    expect(isLikelyCoachEcho('the constitution', '   ...   ')).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// The module's own absences, read from its source
// -----------------------------------------------------------------------------
//
// `useRealtimePractice.source.test.ts` reads `useRealtimePractice.ts` and
// asserts it holds no grading ladder. The comparison this issue added lives
// in THIS module instead, so this file carries the equivalent contract for
// its own source — deliberately a second, focused file rather than one test
// reading two modules, matching this codebase's own preference for one door,
// one file, one test (see e.g. `personas.spec.ts` vs `reaction-lines.spec.ts`).

function moduleCode(): string {
  return readFileSync(resolve(here, '../..', 'lib/coachEcho.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('this module is a provenance check, not a grading one — read from its own source', () => {
  it('reads no accepted answer, no verdict, no score and no pass mark', () => {
    const code = moduleCode();
    const forbidden: RegExp[] = [
      /\bacceptedAnswers\b/,
      /\.outcome\b/,
      /\.correct\b/,
      /\bisCorrect\b/,
      /\.score\b/,
      /\.passed\b/,
      /\bpassMark\b/i,
      /\bPASS_THRESHOLD\b/,
      /\bfailureCause\b/,
      /\bgradeDeterministic\b/,
      /\.revealed\b/,
      /\basrConfidence\b/,
    ];
    for (const pattern of forbidden) {
      expect(code, `${pattern} must not appear in coachEcho.ts`).not.toMatch(
        pattern,
      );
    }
  });

  it('makes no network call and imports nothing beyond a bare comparison', () => {
    const code = moduleCode();
    expect(code).not.toMatch(/fetch\(/);
    expect(code).not.toMatch(/from ['"]\.\.\/services\//);
    expect(code).not.toMatch(/import /);
  });

  it('uses no fuzzy matching, edit distance or library — an exact word comparison only', () => {
    const code = moduleCode();
    // The header's own promise: "no fuzzy matching, no edit distance and no
    // library". A Levenshtein-shaped helper or a third-party import would be
    // exactly the drift this test exists to catch.
    expect(code).not.toMatch(/levenshtein/i);
    expect(code).not.toMatch(/\bdistance\(/i);
    expect(code).not.toMatch(/similarity/i);
  });
});
