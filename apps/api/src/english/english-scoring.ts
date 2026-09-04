import { normalizeAnswer } from '../practice/answer-matching';

// =============================================================================
// English reading/writing scoring (issue #136, epic #59 / E10)
// =============================================================================
//
// `docs/specs/english-test.md` §2, as a pure module: a reference sentence and
// the learner's text in, a word-level diff and an outcome out.
//
// It imports exactly one thing, `normalizeAnswer`, and that single import is
// the reason this is a module rather than an `EnglishService` method. E3
// (`practice/answer-matching.ts`) already decided what "the same words" means
// for this product — NFKC, case, filler, possessives, punctuation,
// abbreviations, leading articles, number words — and a second normaliser
// written here would be a second answer to that question, free to drift on the
// next edit, after which the same words are judged differently depending on
// which screen the learner happened to be on.
//
// No NestJS, no Prisma, no `Clock`, no randomness, no I/O. Same input, same
// output, forever — which is what lets an attempt recorded today be re-scored
// months from now and reach the same verdict, the identical guarantee
// `answer-matching.ts` and `readiness-engine.ts` already make for their own
// rules.
//
// -----------------------------------------------------------------------------
// WORD-LEVEL, NEVER CHARACTER-LEVEL
// -----------------------------------------------------------------------------
//
// The alignment below is over TOKENS, not characters. A character-level edit
// distance would score "President"/"Presidents" as a near-perfect match (one
// character in ten) and "Congress"/"country" as a near-total miss, when what
// the reading test actually asks is whether the learner produced the right
// WORDS. It would also make the metric's denominator the sentence's length in
// characters, so the same one-word slip would cost more on a sentence made of
// long words. WER is the standard measure for exactly this task, and this file
// computes the standard thing.
//
// -----------------------------------------------------------------------------
// THE OUTCOME IS NOT A BARE COMPARISON AGAINST THE WER (§2.3)
// -----------------------------------------------------------------------------
//
// The product truth is "one word wrong is not a failure; two words wrong is not
// reading the sentence." One flat WER threshold cannot say that, because the
// seeded sentences run 3 to 8 tokens: ONE error in a 3-token sentence is 0.333,
// while TWO errors in an 8-token sentence is only 0.250 — a smaller rate for
// the worse mistake, purely because the sentence was longer. So the error COUNT
// carries the rule and the rate bounds it. See `classifyOutcome`.
// =============================================================================

/**
 * The most tokens this module will align.
 *
 * The alignment is O(n·m), so an unbounded hypothesis against a short reference
 * is a cheap way to make the server do expensive work. `MAX_RESPONSE_LENGTH`
 * (2000 characters) already bounds the raw string upstream in
 * `answer-matching.ts`; this bounds the token count after normalisation, which
 * is the dimension the matrix is actually sized by. A hypothesis longer than
 * this is truncated rather than rejected: the extra tokens are all insertions,
 * every one of them an error, so an attempt that hits this bound was never
 * going to be anything but `incorrect` and truncation cannot change its
 * outcome.
 */
export const MAX_ALIGNED_TOKENS = 200;

/** §2.3's bound on how much a single slip may cost. See `classifyOutcome`. */
export const WER_CORRECT_MAX = 0.34;

/** §2.3's outer bound for `partial` — "no more than half wrong". */
export const WER_PARTIAL_MAX = 0.5;

/** The four alignment operations, in the vocabulary a diff renderer needs. */
export type DiffOpKind = 'match' | 'substitute' | 'delete' | 'insert';

/**
 * One aligned position.
 *
 * `reference` is null for an `insert` (the learner said a word that is not in
 * the sentence) and `hypothesis` is null for a `delete` (a word of the sentence
 * they did not say). Both are present for `match` and `substitute`.
 *
 * `referenceIndex` is the position in the normalised reference this op belongs
 * to — what lets a renderer lay the diff over the sentence itself rather than
 * over a second list beside it.
 */
export interface DiffOp {
  kind: DiffOpKind;
  reference: string | null;
  hypothesis: string | null;
  referenceIndex: number;
}

/** §2.3's three outcomes. There is no `skipped`: an unsubmitted sentence is not an attempt. */
export type EnglishScoreOutcome = 'correct' | 'partial' | 'incorrect';

export interface EnglishScore {
  outcome: EnglishScoreOutcome;
  /** `errors / referenceTokenCount`, or `0` when the reference is empty. */
  wer: number;
  /** `substitutions + deletions + insertions` — the raw count §2.3 reads first. */
  errors: number;
  substitutions: number;
  deletions: number;
  insertions: number;
  /** The reference's own token count — WER's denominator, reported so a reader can check the arithmetic. */
  referenceTokenCount: number;
  /** The full alignment, in reference order, with insertions interleaved at the position they were said. */
  diff: DiffOp[];
  /** What was actually compared, after normalisation — the two strings that produced everything above. */
  normalizedReference: string;
  normalizedHypothesis: string;
}

/**
 * Normalise and split into comparable word tokens.
 *
 * Exported because the vocabulary validator and the tests both need to tokenise
 * exactly the way scoring does, and a second `split(/\s+/)` somewhere else is
 * the beginning of the drift this module exists to prevent.
 *
 * NOTE, and it matters: no sentinel prefix here, unlike the vocabulary
 * validator's own tokeniser. `normalizeAnswer` drops a LEADING article, and
 * scoring wants exactly that — it is applied to the reference and to the
 * hypothesis alike, so a learner who says "The White House is..." and a
 * reference reading "The White House is..." both lose the same leading `the`
 * and compare equal. The validator prefixes a sentinel because it is asking a
 * different question ("is this word on the list?"), where silently dropping the
 * article would mean never checking it.
 */
export function tokenizeForScoring(text: string): string[] {
  const normalized = normalizeAnswer(text);
  return normalized.length === 0 ? [] : normalized.split(/\s+/).filter((t) => t.length > 0);
}

/**
 * §2.3's compound rule. `errors` is checked FIRST; `wer` only bounds the
 * single-error case.
 *
 * Exported so the spec's own worked table can be asserted against this function
 * directly, rather than against a service that also touches a database.
 */
export function classifyOutcome(errors: number, wer: number): EnglishScoreOutcome {
  if (errors === 0) return 'correct';
  if (errors === 1 && wer <= WER_CORRECT_MAX) return 'correct';
  if (wer <= WER_PARTIAL_MAX) return 'partial';
  return 'incorrect';
}

/**
 * Score one reading or writing attempt against its sentence.
 *
 * Total: no throw for any string input, including the empty string on either
 * side. An empty hypothesis against a real reference is every reference token
 * deleted — `wer` of exactly `1`, `incorrect` — which is the honest verdict for
 * a blank submission and needs no special case above this function.
 *
 * An empty REFERENCE cannot arise from seeded content (§1.4 rejects a sentence
 * with no tokens) but is handled rather than asserted: `wer` is `0` and the
 * outcome follows from the insertion count alone, because dividing by zero to
 * report how wrong somebody was is worse than reporting a rate of nothing.
 */
export function scoreEnglishAttempt(reference: string, hypothesis: string): EnglishScore {
  const refTokens = tokenizeForScoring(reference).slice(0, MAX_ALIGNED_TOKENS);
  const hypTokens = tokenizeForScoring(hypothesis).slice(0, MAX_ALIGNED_TOKENS);

  const diff = alignTokens(refTokens, hypTokens);

  let substitutions = 0;
  let deletions = 0;
  let insertions = 0;
  for (const op of diff) {
    if (op.kind === 'substitute') substitutions += 1;
    else if (op.kind === 'delete') deletions += 1;
    else if (op.kind === 'insert') insertions += 1;
  }

  const errors = substitutions + deletions + insertions;
  // The denominator is the REFERENCE's length, never the hypothesis's: WER is a
  // rate against what should have been said, which is what makes two attempts
  // at the same sentence comparable however much each of them over- or
  // under-said.
  const wer = refTokens.length === 0 ? 0 : errors / refTokens.length;

  return {
    outcome: classifyOutcome(errors, wer),
    wer,
    errors,
    substitutions,
    deletions,
    insertions,
    referenceTokenCount: refTokens.length,
    diff,
    normalizedReference: refTokens.join(' '),
    normalizedHypothesis: hypTokens.join(' '),
  };
}

// -----------------------------------------------------------------------------
// Wagner-Fischer over tokens
// -----------------------------------------------------------------------------
//
// The textbook edit-distance matrix, with unit cost for each of the three
// operations, then a backtrace to recover WHICH operations were chosen — the
// distance alone would give the error count but not the diff, and the diff is
// the half of this that a learner can act on.
//
// The backtrace's tie-break order is fixed and documented because it is
// observable: on a tie the matrix prefers `substitute`/`match` (diagonal), then
// `delete`, then `insert`. That keeps a substituted word aligned with the word
// it replaced instead of rendering as an unrelated deletion-plus-insertion pair
// a few positions apart, which reads to a learner as two mistakes where they
// made one. A different order would produce the same `errors` count and a worse
// explanation.

function alignTokens(ref: string[], hyp: string[]): DiffOp[] {
  const n = ref.length;
  const m = hyp.length;

  // (n+1) x (m+1), flattened: one allocation instead of n+1 of them.
  const cost = new Int32Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;

  for (let i = 1; i <= n; i += 1) cost[at(i, 0)] = i;
  for (let j = 1; j <= m; j += 1) cost[at(0, j)] = j;

  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      const diagonal = cost[at(i - 1, j - 1)] + (ref[i - 1] === hyp[j - 1] ? 0 : 1);
      const deletion = cost[at(i - 1, j)] + 1;
      const insertion = cost[at(i, j - 1)] + 1;
      cost[at(i, j)] = Math.min(diagonal, deletion, insertion);
    }
  }

  const reversed: DiffOp[] = [];
  let i = n;
  let j = m;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0) {
      const same = ref[i - 1] === hyp[j - 1];
      if (cost[at(i, j)] === cost[at(i - 1, j - 1)] + (same ? 0 : 1)) {
        reversed.push({
          kind: same ? 'match' : 'substitute',
          reference: ref[i - 1],
          hypothesis: hyp[j - 1],
          referenceIndex: i - 1,
        });
        i -= 1;
        j -= 1;
        continue;
      }
    }

    if (i > 0 && cost[at(i, j)] === cost[at(i - 1, j)] + 1) {
      reversed.push({
        kind: 'delete',
        reference: ref[i - 1],
        hypothesis: null,
        referenceIndex: i - 1,
      });
      i -= 1;
      continue;
    }

    // Only `insert` remains. `referenceIndex` is `i` — the position in the
    // reference this extra word was said BEFORE — so a renderer can place it
    // between two reference words rather than at the end of the sentence.
    reversed.push({
      kind: 'insert',
      reference: null,
      hypothesis: hyp[j - 1],
      referenceIndex: i,
    });
    j -= 1;
  }

  return reversed.reverse();
}
