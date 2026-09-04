// English vocabulary expansion and validation-tokenisation (E10, epic #59 /
// issue #130) — docs/specs/english-test.md §1.4.
//
// This file owns exactly one job: turning the two official USCIS vocabulary
// lists (`english-vocabulary-reading.json`, `english-vocabulary-writing.json`)
// into a flat allowed-token set per list, and tokenising a composed
// sentence's own text the same way, so `validateEnglishContent` — kept in
// this same file, because it is the only consumer of the token sets and
// splitting them would put a rule and its one caller in two places — can
// check every word of every sentence appears on its matching list. It also
// derives `vocabTags` from the same token→category lookup, per §1.4's
// "derive it from the lookup that already has to run" rule.
//
// Deliberately standalone and framework-free (no `@nestjs/*`, no
// `@prisma/client`) — a sibling posture to `validate-content.ts`, so it is
// importable from a Jest spec with no DI container and no database, and
// from `load-english-content.ts` with nothing extra to wire up.
//
// -----------------------------------------------------------------------------
// THE SENTINEL, AND WHY IT EXISTS
// -----------------------------------------------------------------------------
//
// `normalizeAnswer` (imported below, never re-implemented — §2.1) drops a
// LEADING article as its step 5: `normalizeAnswer("the")` is the empty
// string, and `normalizeAnswer("a")` is too. Tokenising a vocabulary entry
// (or a sentence, for validation) by calling `normalizeAnswer` directly on
// its own text would therefore silently delete "the" and "a" from both the
// reading list's OTHER_FUNCTION category and every allowed-token set built
// from it — after which the string "the" could never legally appear as a
// token anywhere, and every sentence that (correctly, per §1.1's own quoted
// USCIS guidance) contains "the" would fail validation.
//
// The fix: prefix the text with a SENTINEL token before normalising, then
// drop the sentinel's own output token afterward. The sentinel must be a
// token no filler pattern (`LEADING_FILLERS`) and no article rule
// (`LEADING_ARTICLES`) can ever match, so it always survives the pipeline
// unchanged and always ends up as `normalizeAnswer`'s own first output
// token — which is what makes "drop tokens[0]" a safe, mechanical step
// rather than a guess. `zzz` is that sentinel here — verified directly
// against the real function: it matches no filler regex, is not a leading
// article, is not a number word, and no abbreviation-expansion phrase in
// `answer-matching.ts` starts with it.
//
// THIS TOKENISATION IS DELIBERATELY STRICTER THAN THE SCORING TOKENISATION
// (§2.1), WHICH HAS NO SENTINEL: the reading/writing scorer normalises the
// reference sentence and the learner's hypothesis with a bare
// `normalizeAnswer(...).split(' ')` — no sentinel — so a sentence's own
// leading article is dropped identically on both sides before comparison,
// which is correct for SCORING (a missing leading "the" should never cost a
// learner a word-error). Validation is a different question — "does every
// word in this sentence appear on the vocabulary list" — and a leading
// article is a real word on that list that must be checked, not silently
// discarded. The sentinel is what lets validation ask that stricter
// question while the scorer keeps asking its own, looser one, both from the
// same underlying `normalizeAnswer` pipeline.
// -----------------------------------------------------------------------------

import { normalizeAnswer } from '../../src/practice/answer-matching';

// -----------------------------------------------------------------------------
// File shapes — matching the two checked-in vocabulary files and the
// sentence file exactly (apps/api/prisma/content/english-vocabulary-{reading,
// writing}.json, english-sentences.json). These are read-only content files;
// nothing here writes to them.
// -----------------------------------------------------------------------------

export type EnglishSegmentKindValue = 'reading' | 'writing';

export interface VocabularyCategory {
  /** USCIS's own category heading, transcribed verbatim (§1.1) — e.g. "PEOPLE", "QUESTION_WORDS". */
  tag: string;
  /**
   * Each entry is one vocabulary word or phrase, e.g. "President", "American
   * flag". A `/` denotes alternatives that expand before tokenising — e.g.
   * "state/states" → ["state", "states"], "one hundred/100" →
   * ["one hundred", "100"] (§1.4).
   */
  words: string[];
}

export interface VocabularyFile {
  kind: EnglishSegmentKindValue;
  version: string;
  label: string;
  provenance: {
    sourceUrl: string;
    retrievedAt: string;
    sha256: string;
    transcription: { status: string; warning: string };
  };
  categories: VocabularyCategory[];
}

export interface EnglishSentenceEntry {
  kind: EnglishSegmentKindValue;
  ordinal: number;
  text: string;
  provenance: {
    sourceUrl: string;
    retrievedAt: string;
    sha256: string;
  };
}

export interface EnglishSentencesFile {
  version: string;
  label: string;
  composition: {
    status: string;
    reviewedBy: string;
    reviewedAt: string;
    note: string;
  };
  vocabulary: {
    reading: { sourceUrl: string; retrievedAt: string; sha256: string };
    writing: { sourceUrl: string; retrievedAt: string; sha256: string };
  };
  sentences: EnglishSentenceEntry[];
}

// -----------------------------------------------------------------------------
// Validation issue shape — deliberately the SAME SHAPE `validate-content.ts`
// already produces (`severity`/`code`/`message`), not a re-typed duplicate,
// so a caller that already knows how to render a civics `ValidationIssue`
// needs nothing new to render one of these.
// -----------------------------------------------------------------------------

export type EnglishIssueSeverity = 'error' | 'known_gap' | 'warning';

export interface EnglishValidationIssue {
  severity: EnglishIssueSeverity;
  code: string;
  message: string;
}

/**
 * A sentinel token that survives `normalizeAnswer` unchanged and is never
 * itself a real vocabulary word — see the header comment above for the full
 * reasoning and the verification this relies on.
 */
const VALIDATION_SENTINEL = 'zzz';

/**
 * Tokenise one piece of text (a vocabulary alternative, or a whole sentence)
 * through the full `normalizeAnswer` pipeline, WITH the sentinel guard, so a
 * leading "the"/"a"/"an" survives as a real token instead of being dropped
 * by step 5. See the header comment above for why this exists and why it is
 * deliberately stricter than the scorer's own (sentinel-free) tokenisation.
 */
export function tokenizeForVocabularyMatch(text: string): string[] {
  const normalized = normalizeAnswer(`${VALIDATION_SENTINEL} ${text}`);
  const tokens = normalized.split(' ').filter((token) => token.length > 0);
  // `normalizeAnswer` never matches a filler/article/abbreviation rule
  // against the sentinel itself (see header comment), so it is always
  // tokens[0] here — dropping it is a mechanical step, not a guess.
  return tokens.slice(1);
}

/**
 * A vocabulary entry containing "/" expands to its alternatives before
 * tokenising (§1.4) — `"state/states"` → `["state", "states"]`,
 * `"one hundred/100"` → `["one hundred", "100"]`.
 */
function expandAlternatives(entry: string): string[] {
  return entry
    .split('/')
    .map((alt) => alt.trim())
    .filter((alt) => alt.length > 0);
}

/**
 * Build one vocabulary list's flat allowed-token set: every token any
 * alternative of any entry on the list normalises to, mapped to the set of
 * category tags it came from (a token can legitimately belong to more than
 * one category — e.g. "of" appears inside both a CIVICS phrase like "Bill of
 * Rights" and the OTHER_FUNCTION word list itself).
 *
 * §1.4 is explicit that tokenising the vocabulary list through anything less
 * than the FULL `normalizeAnswer` pipeline (not just its early splitting
 * steps) would produce allowed tokens a normalised sentence can never
 * actually contain (`d`, `c`) and miss the token it can (`district`) — see
 * the worked "Washington, D.C." example in that section. This function
 * always runs the full pipeline via {@link tokenizeForVocabularyMatch}.
 */
export function expandVocabulary(file: VocabularyFile): Map<string, Set<string>> {
  const allowed = new Map<string, Set<string>>();

  for (const category of file.categories) {
    for (const entry of category.words) {
      for (const alternative of expandAlternatives(entry)) {
        for (const token of tokenizeForVocabularyMatch(alternative)) {
          let tags = allowed.get(token);
          if (!tags) {
            tags = new Set<string>();
            allowed.set(token, tags);
          }
          tags.add(category.tag);
        }
      }
    }
  }

  return allowed;
}

/**
 * A sentence's `vocabTags` (§1.4): the union, sorted, of every category any
 * of its own tokens resolved to on the matching vocabulary list. Tokens with
 * no match contribute nothing here — an off-list token is a validation
 * `error` (see {@link validateEnglishContent}), not this function's concern.
 *
 * Deterministic and stable: the same tokens in the same vocabulary always
 * produce the same sorted array, because `Set` iteration order here is only
 * ever read back through `Array.sort()`, never relied on directly.
 */
export function deriveVocabTags(
  tokens: readonly string[],
  vocabulary: ReadonlyMap<string, ReadonlySet<string>>,
): string[] {
  const tags = new Set<string>();
  for (const token of tokens) {
    const entryTags = vocabulary.get(token);
    if (entryTags) {
      for (const tag of entryTags) {
        tags.add(tag);
      }
    }
  }
  return [...tags].sort();
}

function err(code: string, message: string): EnglishValidationIssue {
  return { severity: 'error', code, message };
}

/**
 * Validate a sentence file against its two matching vocabulary lists —
 * §1.4's enforced, structural (`error`-severity, never a `known_gap`) rule:
 * every token of every sentence must appear on the vocabulary list matching
 * that sentence's own `kind`, and the reading and writing lists are NEVER
 * merged into one allowed set (§1.1 — "the lists are not the same").
 *
 * Returns a plain issue list (`validate-content.ts`'s own shape) rather than
 * a full report object — the loader (`load-english-content.ts`) only ever
 * needs to know whether any `error` issue exists.
 */
export function validateEnglishContent(
  readingVocabulary: VocabularyFile,
  writingVocabulary: VocabularyFile,
  sentences: EnglishSentencesFile,
): EnglishValidationIssue[] {
  const issues: EnglishValidationIssue[] = [];

  const readingAllowed = expandVocabulary(readingVocabulary);
  const writingAllowed = expandVocabulary(writingVocabulary);

  // Duplicate (kind, ordinal) would collide on the loader's own upsert key
  // (`@@unique([kind, version, ordinal])`) — caught here, before the
  // database ever sees it, with a message that names the actual sentences
  // in conflict rather than a bare constraint-violation error.
  const seenOrdinals = new Map<EnglishSegmentKindValue, Set<number>>();

  for (const sentence of sentences.sentences) {
    const label = `${sentence.kind} #${sentence.ordinal} ("${sentence.text}")`;

    let ordinalsForKind = seenOrdinals.get(sentence.kind);
    if (!ordinalsForKind) {
      ordinalsForKind = new Set<number>();
      seenOrdinals.set(sentence.kind, ordinalsForKind);
    }
    if (ordinalsForKind.has(sentence.ordinal)) {
      issues.push(
        err(
          'sentence.duplicateOrdinal',
          `${label}: ordinal ${sentence.ordinal} is used more than once within kind "${sentence.kind}".`,
        ),
      );
    }
    ordinalsForKind.add(sentence.ordinal);

    // §1.1: reading sentences check ONLY against the reading list, writing
    // sentences ONLY against the writing list — never their union.
    const allowed = sentence.kind === 'reading' ? readingAllowed : writingAllowed;
    const otherListName = sentence.kind === 'reading' ? 'writing' : 'reading';

    for (const token of tokenizeForVocabularyMatch(sentence.text)) {
      if (!allowed.has(token)) {
        issues.push(
          err(
            'sentence.offVocabularyToken',
            `${label}: token "${token}" does not appear on the ${sentence.kind} vocabulary list ` +
              `(checked separately from the ${otherListName} list, per docs/specs/english-test.md §1.1 — ` +
              `the two lists are never merged).`,
          ),
        );
      }
    }
  }

  return issues;
}
