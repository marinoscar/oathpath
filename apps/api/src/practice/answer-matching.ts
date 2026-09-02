// =============================================================================
// Answer normalisation and deterministic matching (issue #70, epic #52 / E3)
// =============================================================================
//
// practice-sessions.md's normalisation table, as a pure module: a string in, a
// string out, and a verdict over a list of accepted answers.
//
// It is a standalone module rather than a `PracticeService` method for exactly
// the reason `civics/answer-resolution.ts` and `journey/next-action.ts` are
// standalone: the rule must never drift, so it lives in one named file,
// unit-tested directly, with nothing else allowed to inline "well, close
// enough" logic of its own. Every branch of the table below is reachable from
// a spec without DI, HTTP, or a database — which is what makes it cheap to add
// the twentieth normalisation case the first time a real learner types
// something we did not anticipate.
//
// Consequently this file imports NOTHING. No `@nestjs/*`, no `@prisma/client`,
// no injected dependency, no `Clock` (it has no notion of "now" — the same
// answer is the same answer at any instant), and no model client. Grep it for
// an import statement and the result is empty.
//
// -----------------------------------------------------------------------------
// THERE IS NO EDIT DISTANCE HERE, AND THERE MUST NEVER BE ONE
// -----------------------------------------------------------------------------
//
// No Levenshtein threshold, no similarity score, no substring containment, no
// "starts with", no token-overlap ratio. The matcher answers `correct` only
// when the two strings are equal — either raw, or after the fully documented,
// fully deterministic rewrite below.
//
// This is a deliberate scope line, not an unfinished feature. A response that a
// distance threshold WOULD accept — `Jefferson` for `Thomas Jefferson`,
// `the senate` for `the House of Representatives` with an unlucky ratio — is
// precisely the case E4's grader (#53) exists to judge, with the question, the
// accepted answers and a rubric in front of it. Approving those here with an
// arbitrary constant would pre-empt that judgement with a strictly worse
// answer, and would do it invisibly: nothing in the response tells a learner
// that they were graded by a number somebody picked.
//
// Substring containment fails worse still and in both directions. `not the
// president` contains `the president`; `Washington` is contained by `George
// Washington` AND by `Washington, D.C.`, which are answers to different
// questions. There is no threshold that makes those safe, so there is no
// threshold.
//
// The honest division of labour: THIS module decides the cases where the
// learner is unambiguously right and only their typing differs. Everything
// else it reports `incorrect`, and E4 is free to overturn that with reasoning.
// A false `incorrect` here is a second opinion away from being fixed; a false
// `correct` here is a learner walking into an interview believing a wrong
// answer, and it never reaches the grader at all.
// =============================================================================

/**
 * The longest response this module will consider at all.
 *
 * A civics answer is a handful of words. Anything past 2000 characters is not
 * a long answer — it is a paste, a stuck key, or somebody probing what the
 * endpoint does with a megabyte. It is reported `incorrect` rather than
 * rejected with an exception, because a normalisation helper throwing is a 500
 * on a practice screen, and "that is not a match" is both true and useful
 * where a stack trace is neither.
 *
 * The bound is on the RAW length, checked before any work happens, so a
 * pathological input costs one comparison rather than a regex pass over a
 * megabyte of text.
 */
export const MAX_RESPONSE_LENGTH = 2000;

// -----------------------------------------------------------------------------
// Step 2 — leading filler
// -----------------------------------------------------------------------------
//
// Spoken and typed answers arrive wrapped in a preamble: "I think it's the
// Constitution". The content of that answer is `the Constitution`; the wrapper
// is the learner being a person. Stripping it is not a guess about meaning —
// each phrase below is a fixed, listed opening, matched ONLY at the very start
// and ONLY when followed by whitespace, so a phrase can never be found in the
// middle of an answer and can never swallow the answer whole.
//
// Ordered LONGEST FIRST, and matched in that order. Reversing it would let the
// 7-character `i think` fire on `i think it's the constitution`, leaving the
// `it's` behind for the shorter rules to trip over on the next pass.
//
// Both apostrophes are accepted (`'` U+0027 and `’` U+2019). NFKC in step 1
// does NOT unify them — a phone's smart quotes survive normalisation intact —
// so a rule written with only the ASCII apostrophe would silently fail on the
// majority of mobile input.
//
// KNOWN COLLISION, ACCEPTED: `its` and `it's` are real English words, so an
// answer that genuinely begins "its ..." loses its first token. Requiring a
// following space is the whole guard, and it is enough in practice because no
// accepted civics answer begins with a possessive pronoun — while "it's the
// Constitution" is an extremely common way for a learner to answer. The
// alternative (dropping the rule) fails the ordinary case to protect one that
// does not occur in this domain.
const LEADING_FILLERS: readonly RegExp[] = [
  /^the answer is(?=\s)/,
  /^my answer is(?=\s)/,
  /^i think it['’]s(?=\s)/,
  /^i think its(?=\s)/,
  /^i think(?=\s)/,
  /^answer:(?=\s)/,
  /^it is(?=\s)/,
  /^it['’]s(?=\s)/,
  /^its(?=\s)/,
];

/**
 * How many times filler stripping is re-applied.
 *
 * More than one pass is needed for genuine compound openings — "I think it is
 * the Constitution" strips `i think`, and only then is `it is` at the start.
 * The count is bounded rather than looped-until-stable so that no input, however
 * adversarial, can make this function run long: four passes is more preamble
 * than any real answer carries, and the fifth would only ever be eating a real
 * answer anyway.
 */
const MAX_FILLER_PASSES = 4;

// -----------------------------------------------------------------------------
// Step 4 — abbreviations
// -----------------------------------------------------------------------------
//
// Whole-token and whole-phrase replacements ONLY. Never a substring rewrite:
// a naive `.replace('us', 'united states')` turns `houses` into
// `hounited statesnes`, and that class of bug is invisible until a learner
// reports it, because it only fires on answers nobody wrote a test for.
//
// The table is applied by a single left-to-right scan (see
// {@link expandAbbreviations}) that takes the LONGEST match at each position
// and does not rescan what it emitted. Both properties are load-bearing:
//
//   - Longest-first is why `president of the united states` becomes
//     `president` rather than being chewed up by a shorter rule first. Note
//     that `us` cannot in fact reach it — step 3 has already split `U.S.` into
//     two tokens and this phrase contains the spelled-out `united states` —
//     but ordering the table by length makes that independent of which rules
//     exist tomorrow, rather than a coincidence of today's list.
//   - Not rescanning output is why expanding `u s` to `united states` cannot
//     cascade into some later rule matching the words we just produced.
//
// KNOWN COLLISION, ACCEPTED AND DELIBERATE: `us` is also the English object
// pronoun. In a civics answer it is overwhelmingly the country — this is a
// naturalisation test, and "us" as a pronoun is not an answer to any of its
// 100 questions, while `U.S.` (which step 3 renders as the tokens `u s`) is
// part of a great many of them. The alternative is leaving `the U.S.`
// unmatched against `the United States`, which is the exact headline case
// issue #70 was filed to fix. We take the collision knowingly.
const ABBREVIATION_EXPANSIONS: readonly (readonly [
  readonly string[],
  readonly string[],
])[] = [
  [['president', 'of', 'the', 'united', 'states'], ['president']],
  [['u', 's', 'a'], ['united', 'states']],
  [['u', 's'], ['united', 'states']],
  [['d', 'c'], ['district', 'of', 'columbia']],
  [['usa'], ['united', 'states']],
  [['us'], ['united', 'states']],
  [['dc'], ['district', 'of', 'columbia']],
  [['potus'], ['president']],
];

/** Step 5. Leading only — `bill of rights` must keep its `of`-adjacent words. */
const LEADING_ARTICLES: ReadonlySet<string> = new Set(['a', 'an', 'the']);

// -----------------------------------------------------------------------------
// Step 6 — number words
// -----------------------------------------------------------------------------
//
// Four small maps and a scanner, NOT a lookup table of every number from 1 to
// 100. The table would be 200 entries to maintain, would still be wrong at 101,
// and would have to be written twice (cardinals and ordinals). The scanner is
// composed from the same pieces English is: `twenty` + `seven`, `one` +
// `hundred`, `twenty` + `first`.
const CARDINAL_UNITS: ReadonlyMap<string, number> = new Map([
  ['zero', 0],
  ['one', 1],
  ['two', 2],
  ['three', 3],
  ['four', 4],
  ['five', 5],
  ['six', 6],
  ['seven', 7],
  ['eight', 8],
  ['nine', 9],
  ['ten', 10],
  ['eleven', 11],
  ['twelve', 12],
  ['thirteen', 13],
  ['fourteen', 14],
  ['fifteen', 15],
  ['sixteen', 16],
  ['seventeen', 17],
  ['eighteen', 18],
  ['nineteen', 19],
]);

const CARDINAL_TENS: ReadonlyMap<string, number> = new Map([
  ['twenty', 20],
  ['thirty', 30],
  ['forty', 40],
  ['fifty', 50],
  ['sixty', 60],
  ['seventy', 70],
  ['eighty', 80],
  ['ninety', 90],
]);

const ORDINAL_UNITS: ReadonlyMap<string, number> = new Map([
  ['first', 1],
  ['second', 2],
  ['third', 3],
  ['fourth', 4],
  ['fifth', 5],
  ['sixth', 6],
  ['seventh', 7],
  ['eighth', 8],
  ['ninth', 9],
  ['tenth', 10],
  ['eleventh', 11],
  ['twelfth', 12],
  ['thirteenth', 13],
  ['fourteenth', 14],
  ['fifteenth', 15],
  ['sixteenth', 16],
  ['seventeenth', 17],
  ['eighteenth', 18],
  ['nineteenth', 19],
]);

const ORDINAL_TENS: ReadonlyMap<string, number> = new Map([
  ['twentieth', 20],
  ['thirtieth', 30],
  ['fortieth', 40],
  ['fiftieth', 50],
  ['sixtieth', 60],
  ['seventieth', 70],
  ['eightieth', 80],
  ['ninetieth', 90],
]);

/**
 * Normalise a free-text answer to the canonical form the matcher compares.
 *
 * The seven steps run in the order documented in practice-sessions.md, and the
 * ORDER IS PART OF THE CONTRACT, not an implementation detail:
 *
 *   1. NFKC, then lowercase.
 *   2. Strip a leading filler opening.
 *   3. Strip possessives, then punctuation and hyphens to spaces.
 *   4. Expand abbreviations, whole tokens only.
 *   5. Drop leading articles.
 *   6. Number words and ordinals to digits.
 *   7. Collapse whitespace.
 *
 * Two dependencies between steps are worth naming, because reordering them
 * looks harmless and is not:
 *
 *   - Step 2 runs BEFORE step 3 because the filler phrases contain apostrophes
 *     and a colon (`it's`, `answer:`). Strip the punctuation first and `it's`
 *     has become the two tokens `it s`, which no filler pattern matches.
 *   - Step 4 runs AFTER step 3 because `U.S.A.` is only three comparable
 *     tokens once the periods are spaces. The abbreviation table is written in
 *     terms of what step 3 produces, which is why it contains `u s a` and not
 *     `u.s.a.`.
 *
 * Pure and total: no I/O, no clock, no randomness, no mutation of anything the
 * caller owns (strings are immutable; every array here is created locally), and
 * no throw for any string input. The same input yields the same output forever,
 * which is what lets a practice attempt be re-graded months later and reach the
 * same verdict.
 */
export function normalizeAnswer(text: string): string {
  // Defensive rather than type-driven: this is reached from a JSON request
  // body, where the compiler's `string` is a claim about the DTO and not about
  // what actually arrived. Returning the empty string makes the caller report
  // `incorrect`, which is the correct verdict for a non-answer.
  if (typeof text !== 'string' || text.length === 0) {
    return '';
  }

  // --- 1. Unicode NFKC, then lowercase. -------------------------------------
  //
  // NFKC is the compatibility form on purpose: it folds the fullwidth Latin
  // letters an IME produces (`Ｕ.Ｓ.`), ligatures, and the several Unicode
  // spaces into their ordinary ASCII equivalents, so a learner typing on a
  // phone keyboard is compared on the same footing as one on a laptop. NFC
  // would leave all of those distinct.
  //
  // Lowercasing is what makes the whole comparison case-insensitive; note that
  // `matchAnswer` still checks the case-SENSITIVE raw equality first, so an
  // exact answer is never demoted to merely "normalized" (see below).
  let working = text.normalize('NFKC').toLowerCase().trim();

  // --- 2. Leading filler. ---------------------------------------------------
  for (let pass = 0; pass < MAX_FILLER_PASSES; pass += 1) {
    const before = working;

    for (const filler of LEADING_FILLERS) {
      if (filler.test(working)) {
        working = working.replace(filler, '').trimStart();
        break; // Longest-first: the first hit is the right one for this pass.
      }
    }

    if (working === before) {
      break;
    }
  }

  // --- 3. Possessives, then punctuation. ------------------------------------
  //
  // Possessives go FIRST and are DELETED rather than spaced, because
  // `president's` must become `president` and not `president s` — the stray
  // `s` would then have to be matched against nothing on the other side. The
  // lookahead confines the rule to the end of a token, so a stray apostrophe
  // inside a word is left to the punctuation rule below.
  working = working.replace(/['’]s(?![\p{L}\p{N}])/gu, '');

  // Everything that is not a letter, a digit, or whitespace becomes a space —
  // hyphens explicitly included. Spacing rather than deleting is the entire
  // reason `twenty-seven` can meet `27`: deleting would produce `twentyseven`,
  // a single token no number scanner can decompose, while spacing produces the
  // two tokens step 6 already knows how to add together.
  //
  // `\p{L}` and `\p{N}` rather than `A-Za-z0-9` so that a diacritic in a name
  // is a letter and not punctuation to be shredded.
  working = working.replace(/[^\p{L}\p{N}\s]/gu, ' ');

  let tokens = working.split(/\s+/).filter((token) => token.length > 0);

  // --- 4, 5, 6. -------------------------------------------------------------
  tokens = expandAbbreviations(tokens);
  tokens = dropLeadingArticles(tokens);
  tokens = numberWordsToDigits(tokens);

  // --- 7. Collapse whitespace, trim. ----------------------------------------
  //
  // Free by construction: the token list carries no empty entries and joining
  // with a single space cannot produce a run or an edge space.
  return tokens.join(' ');
}

/**
 * Step 4, as one left-to-right pass that never rescans its own output.
 *
 * At each position the longest phrase in {@link ABBREVIATION_EXPANSIONS} that
 * matches from there wins; if none does, the token is copied through unchanged.
 * A rewrite advances past the tokens it consumed and pushes the replacement
 * onto the OUTPUT, so an expansion can never be re-read as the input to another
 * rule.
 */
function expandAbbreviations(tokens: readonly string[]): string[] {
  const out: string[] = [];

  let i = 0;
  while (i < tokens.length) {
    let matched = false;

    for (const [phrase, replacement] of ABBREVIATION_EXPANSIONS) {
      if (i + phrase.length > tokens.length) {
        continue;
      }
      if (phrase.every((word, offset) => tokens[i + offset] === word)) {
        out.push(...replacement);
        i += phrase.length;
        matched = true;
        break;
      }
    }

    if (!matched) {
      out.push(tokens[i]);
      i += 1;
    }
  }

  return out;
}

/**
 * Step 5. Repeated, because step 4 can put an article back in reach: `the
 * president of the united states` becomes `the president`, and only the second
 * look sees the leading `the` with nothing but the answer behind it.
 *
 * Non-leading articles are untouched — `bill of rights` and `house of
 * representatives` are answers whose interior words are not noise.
 */
function dropLeadingArticles(tokens: readonly string[]): string[] {
  let start = 0;
  while (start < tokens.length && LEADING_ARTICLES.has(tokens[start])) {
    start += 1;
  }
  return tokens.slice(start);
}

/**
 * Step 6. Rewrite every maximal run of number words as one digit token.
 *
 * The scanner composes rather than looks up: a run accumulates units, tens and
 * `hundred` the way English does, and an ORDINAL ENDS THE RUN because English
 * ordinals are terminal — `twenty first` is a number, `first twenty` is two.
 *
 * The two ordering guards are what stop it inventing values out of word salad.
 * A unit may only be added onto a multiple of ten (so `twenty seven` is 27 but
 * `seven seven` is two separate 7s), and a tens word may only start a fresh
 * hundreds group (so `seven twenty` is `7 20`, not 27). Anything the guards
 * reject simply ends the run and starts a new one, which keeps the function
 * total: there is no input it refuses.
 *
 * Tokens that are already digits are left exactly as they are — that is how
 * `27` meets `twenty-seven` from the other direction, without a second table.
 */
function numberWordsToDigits(tokens: readonly string[]): string[] {
  const out: string[] = [];

  let i = 0;
  while (i < tokens.length) {
    const scanned = scanNumber(tokens, i);

    if (scanned === null) {
      out.push(tokens[i]);
      i += 1;
      continue;
    }

    out.push(String(scanned.value));
    i = scanned.next;
  }

  return out;
}

/**
 * Consume the number word run starting at `start`, or return null if there
 * isn't one. `next` is the index of the first token the run did not consume.
 */
function scanNumber(
  tokens: readonly string[],
  start: number,
): { value: number; next: number } | null {
  let value = 0;
  let matched = false;
  let i = start;

  while (i < tokens.length) {
    const token = tokens[i];

    // `hundred` multiplies what has been accumulated so far, defaulting to one
    // so that a bare `hundred` is 100 rather than 0.
    if (token === 'hundred' || token === 'hundredth') {
      value = (value === 0 ? 1 : value) * 100;
      matched = true;
      i += 1;
      // `hundredth` is an ordinal, and ordinals end the run.
      if (token === 'hundredth') {
        break;
      }
      continue;
    }

    const tens = CARDINAL_TENS.get(token);
    if (tens !== undefined) {
      // A tens word can only open a hundreds group. `twenty thirty` is not a
      // number, and pretending it is 50 would be worse than leaving it alone.
      if (value !== 0 && value % 100 !== 0) {
        break;
      }
      value += tens;
      matched = true;
      i += 1;
      continue;
    }

    const unit = CARDINAL_UNITS.get(token);
    if (unit !== undefined) {
      // Only onto a multiple of ten: `twenty seven` yes, `twenty seven eight`
      // stops after 27 and leaves the 8 to start its own run.
      if (value % 10 !== 0) {
        break;
      }
      value += unit;
      matched = true;
      i += 1;
      continue;
    }

    const ordinalTens = ORDINAL_TENS.get(token);
    if (ordinalTens !== undefined) {
      if (value !== 0 && value % 100 !== 0) {
        break;
      }
      value += ordinalTens;
      matched = true;
      i += 1;
      break;
    }

    const ordinalUnit = ORDINAL_UNITS.get(token);
    if (ordinalUnit !== undefined) {
      if (value % 10 !== 0) {
        break;
      }
      value += ordinalUnit;
      matched = true;
      i += 1;
      break;
    }

    break;
  }

  return matched ? { value, next: i } : null;
}

/** One accepted answer, narrowed to the two fields matching actually reads. */
export interface AcceptedAnswer {
  readonly id: string;
  readonly text: string;
}

/**
 * How a match was reached, so the caller can say so.
 *
 *  - `exact`      — the raw strings were equal, trimmed and case-sensitive.
 *  - `normalized` — they were equal only after the rewrite above.
 *
 * Reporting the two separately is not cosmetic. It is the only signal
 * downstream has that the deterministic path did any work at all, so a
 * normalisation rule that starts firing far more often than expected — or one
 * that never fires — is visible in the data instead of hidden inside a boolean.
 */
export type MatchRule = 'exact' | 'normalized';

/** The verdict, plus which accepted answer produced it. */
export interface AnswerMatch {
  outcome: 'correct' | 'incorrect';
  /** The accepted answer that matched, or null on `incorrect`. */
  matchedAnswerId: string | null;
  /** That answer's ORIGINAL text, never the normalised form. */
  matchedAnswerText: string | null;
  rule: MatchRule | null;
}

/** Every `incorrect` verdict, built fresh so no caller can share a mutation. */
function incorrect(): AnswerMatch {
  return {
    outcome: 'incorrect',
    matchedAnswerId: null,
    matchedAnswerText: null,
    rule: null,
  };
}

/**
 * Grade a free-text response against a question's accepted answers.
 *
 * EXACT IS CHECKED ACROSS EVERY ANSWER BEFORE NORMALISED IS CHECKED AGAINST
 * ANY. This is why the loops are not fused. A question with the accepted
 * answers `the President` and `President` would, in a single fused loop,
 * report a learner who typed `President` verbatim as a `normalized` match
 * against `the President` — the wrong answer id AND the wrong rule, purely
 * because of list order. Two passes make the reported rule a fact about the
 * response rather than a fact about how the content happened to be seeded.
 *
 * Everything that is not a match is `incorrect` — never an exception, never a
 * partial credit, never a score. `matchAnswer` is total over its input: the
 * empty string, whitespace, and a megabyte of noise all get a verdict.
 *
 * The `acceptedAnswers` list is read and never mutated; the answer objects are
 * never handed back, only their `id` and `text` copied out.
 */
export function matchAnswer(
  response: string,
  acceptedAnswers: readonly AcceptedAnswer[],
): AnswerMatch {
  if (typeof response !== 'string') {
    return incorrect();
  }

  // Checked on the RAW length, before any regex touches it: bounding the work
  // is the point, so the bound cannot itself be the expensive part.
  if (response.length > MAX_RESPONSE_LENGTH) {
    return incorrect();
  }

  const trimmed = response.trim();

  // A learner who submitted nothing has not answered. This is checked before
  // the exact pass so that an empty (or whitespace-only) accepted answer —
  // which should not exist, but is not structurally prevented — can never
  // exact-match an empty response and report a blank as correct.
  if (trimmed.length === 0) {
    return incorrect();
  }

  // --- Pass 1: exact, case-sensitive, over every accepted answer. -----------
  for (const accepted of acceptedAnswers) {
    if (accepted.text.trim() === trimmed) {
      return {
        outcome: 'correct',
        matchedAnswerId: accepted.id,
        matchedAnswerText: accepted.text,
        rule: 'exact',
      };
    }
  }

  // --- Pass 2: normalised. --------------------------------------------------
  const normalizedResponse = normalizeAnswer(response);

  // Normalisation can legitimately empty a response — `it's` on its own is all
  // filler, `...` is all punctuation. An empty normalised form must not be
  // allowed to meet an equally empty accepted answer and be called correct.
  if (normalizedResponse.length === 0) {
    return incorrect();
  }

  for (const accepted of acceptedAnswers) {
    if (normalizeAnswer(accepted.text) === normalizedResponse) {
      return {
        outcome: 'correct',
        matchedAnswerId: accepted.id,
        matchedAnswerText: accepted.text,
        rule: 'normalized',
      };
    }
  }

  // No third pass. See this file's header: the near-miss that a distance
  // threshold would accept here is E4's (#53) to judge, with the question and a
  // rubric in front of it.
  return incorrect();
}
