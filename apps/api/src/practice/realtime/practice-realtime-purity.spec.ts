import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// =============================================================================
// The two structural rules of E15's engine, read off the source (issue #354)
// =============================================================================
//
// A source-reading test, and it is the right shape for these two properties
// rather than a lazy one. Both are statements about what a FILE may contain —
// "this directory grades nothing" and "practice knows nothing about realtime" —
// and a behavioural test cannot express either: a second grading ladder that
// happened to agree with the first would pass every behavioural assertion in
// this repository on the day it was written, and go on passing until one of
// the two copies was edited alone. That is exactly the failure
// `realtime-practice.md` §5 records as already having happened once
// (`InterviewsService`' "second copy of the same `if` that was one condition
// shorter"), and the reason it was invisible is that it compiled and its
// symptom was a slightly-too-low readiness score.
//
// So the assertion is the one that catches it in review: the names cannot
// appear at all.
//
// This is the same device `ai-dispatch.service.ts`' own spec already uses to
// keep the organisation's API key out of the inference path — "asserts this
// address never appears in that file's source, by name" — applied to a
// different invariant on a different file.
// =============================================================================

const REALTIME_DIR = __dirname;
const PRACTICE_SERVICE = join(__dirname, '..', 'practice.service.ts');

/** Every non-test source file in `practice/realtime/`. */
function realtimeSources(): { name: string; source: string }[] {
  return readdirSync(REALTIME_DIR)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.spec.ts'))
    .map((name) => ({
      name,
      source: readFileSync(join(REALTIME_DIR, name), 'utf8'),
    }));
}

/**
 * Strip comments before matching.
 *
 * THE POINT OF THE WHOLE FILE WOULD BE LOST WITHOUT THIS, in both directions.
 * These modules' headers discuss the grading ladder at length — they have to,
 * because "we call `recordAttempt` instead of re-implementing
 * `escalateToGrader`" is not a sentence you can write without naming
 * `escalateToGrader` — so a raw substring search over the file would fail on
 * the very comments that document the rule. And a rule that forced those
 * comments to be deleted would have made the codebase worse to enforce a rule
 * about making it better.
 *
 * Deliberately a lexical strip rather than a parse: a `//` inside a string
 * literal would be over-removed, which can only make this check MORE
 * conservative in the direction that matters (it can hide a call, never invent
 * one) — and no file in this directory contains one.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, ' ')
    .replace(/\/\/.*$/gm, ' ');
}

describe('practice/realtime/ contains no second grading ladder', () => {
  // The three names `PracticeService.recordAttempt` reaches on its own way to a
  // row. A realtime handler that named any of them would be assembling the same
  // facts a second time, and every rule that has to hold on both surfaces — the
  // misheard mapping, the frozen answer snapshot, the retry link, the mastery
  // write — would become something two files have to agree about.
  const FORBIDDEN = ['gradeDeterministic', 'escalateToGrader', 'scheduleMastery'];

  for (const name of FORBIDDEN) {
    it(`never calls ${name}`, () => {
      const offenders = realtimeSources()
        .filter(({ source }) => withoutComments(source).includes(name))
        .map(({ name: file }) => file);

      expect(offenders).toEqual([]);
    });
  }

  it('reaches the evidence table only through PracticeService’s public methods', () => {
    // The positive half, and the reason the negative half above is not merely
    // an absence: SOMETHING in this directory must write the row, and this
    // asserts what. `recordAttempt` and `completeSession` are the two public
    // methods `POST .../attempts` and `POST .../complete` already call.
    const service = withoutComments(
      readFileSync(join(REALTIME_DIR, 'practice-realtime.service.ts'), 'utf8'),
    );

    expect(service).toContain('this.practice.recordAttempt(');
    expect(service).toContain('this.practice.completeSession(');
  });

  it('never reaches Prisma, the evidence table, or a model directly', () => {
    // A handler holding `PrismaService` could write a `practice_attempts` row
    // without going near `recordAttempt`, which would defeat every assertion
    // above while naming none of the forbidden three. `AttemptGradingService`
    // is named for the same reason: it is the shared ladder, and reaching it
    // from here would be `InterviewsService.gradeCivicsAnswer`'s shape — the
    // one this epic exists not to repeat.
    const offenders = realtimeSources()
      .filter(({ source }) => {
        const code = withoutComments(source);
        return (
          code.includes('PrismaService') ||
          code.includes('practiceAttempt.') ||
          code.includes('questionMastery.') ||
          code.includes('AttemptGradingService')
        );
      })
      .map(({ name }) => name);

    expect(offenders).toEqual([]);
  });
});

describe('the dependency runs one way', () => {
  it('PracticeService imports nothing from realtime/ and branches on no transport', () => {
    // THE HALF THAT IS EASIEST TO BREAK WITH A ONE-LINE EDIT, and the hardest
    // to notice afterwards: a `realtime`-shaped `if` inside `recordAttempt`
    // would put transport-specific behaviour in the one file that writes every
    // attempt row on every transport, which is the thing this epic's whole
    // single-`recordAttempt` rule exists to prevent.
    //
    // `PracticeRealtimeService` depends on `PracticeService`. Never the
    // reverse, and never a shared third thing that lets the reverse happen
    // quietly.
    const code = withoutComments(readFileSync(PRACTICE_SERVICE, 'utf8'));

    expect(code).not.toMatch(/from\s+'\.\/realtime\//);
    expect(code).not.toContain('PracticeRealtimeService');
    expect(code).not.toContain('realtime');
  });
});
