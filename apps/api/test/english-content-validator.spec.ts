// Tests for the English vocabulary expansion and content validator (E10,
// epic #59 / issue #130) — docs/specs/english-test.md §1.4.
//
// Pure, no database — this only ever reads JSON files and pure functions
// over strings, mirroring `civics-content-validator.spec.ts`'s own posture.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeAnswer } from '../src/practice/answer-matching';
import {
  deriveVocabTags,
  expandVocabulary,
  tokenizeForVocabularyMatch,
  validateEnglishContent,
  type EnglishSentencesFile,
  type VocabularyFile,
} from '../prisma/content/english-vocabulary';

const CONTENT_DIR = join(__dirname, '..', 'prisma', 'content');

function loadJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(CONTENT_DIR, name), 'utf8')) as T;
}

const readingVocabulary = loadJson<VocabularyFile>('english-vocabulary-reading.json');
const writingVocabulary = loadJson<VocabularyFile>('english-vocabulary-writing.json');
const sentencesFile = loadJson<EnglishSentencesFile>('english-sentences.json');

// -----------------------------------------------------------------------------
// The required acceptance test: every word of every seeded sentence appears
// on its matching vocabulary list, computed from the real checked-in files
// through the real tokeniser — not a synthetic fixture standing in for them.
// -----------------------------------------------------------------------------

describe('validateEnglishContent — the real shipped content files', () => {
  it('has zero validation errors across all 36 real sentences (16 reading / 20 writing)', () => {
    const issues = validateEnglishContent(readingVocabulary, writingVocabulary, sentencesFile);
    const errors = issues.filter((issue) => issue.severity === 'error');

    // A failure here should name the actual offending token(s), not just
    // "something failed" — assert with the full list attached so a broken
    // sentence is diagnosable straight from the test output.
    expect(errors).toEqual([]);
  });

  it('is exactly 16 reading and 20 writing sentences, per docs/specs/english-test.md', () => {
    const reading = sentencesFile.sentences.filter((s) => s.kind === 'reading');
    const writing = sentencesFile.sentences.filter((s) => s.kind === 'writing');
    expect(reading).toHaveLength(16);
    expect(writing).toHaveLength(20);
  });

  it('every real sentence, tokenised for validation, resolves every token against its own kind\'s vocabulary', () => {
    const readingAllowed = expandVocabulary(readingVocabulary);
    const writingAllowed = expandVocabulary(writingVocabulary);

    for (const sentence of sentencesFile.sentences) {
      const allowed = sentence.kind === 'reading' ? readingAllowed : writingAllowed;
      const tokens = tokenizeForVocabularyMatch(sentence.text);
      expect(tokens.length).toBeGreaterThan(0);
      for (const token of tokens) {
        expect(allowed.has(token)).toBe(true);
      }
    }
  });
});

// -----------------------------------------------------------------------------
// §1.1: the reading and writing lists are validated SEPARATELY and never
// merged — a word legal on one list is illegal on the other, and the
// validator must catch that in either direction.
// -----------------------------------------------------------------------------

describe('validateEnglishContent — the reading and writing lists are never merged', () => {
  function syntheticSentencesFile(entries: EnglishSentencesFile['sentences']): EnglishSentencesFile {
    return {
      ...sentencesFile,
      sentences: entries,
    };
  }

  it('rejects a reading sentence containing a writing-only word ("taxes")', () => {
    const file = syntheticSentencesFile([
      {
        kind: 'reading',
        ordinal: 1,
        text: 'We pay taxes.',
        provenance: sentencesFile.sentences[0].provenance,
      },
    ]);

    const issues = validateEnglishContent(readingVocabulary, writingVocabulary, file);
    const errors = issues.filter((issue) => issue.severity === 'error');

    expect(errors.some((issue) => issue.code === 'sentence.offVocabularyToken' && issue.message.includes('taxes'))).toBe(
      true,
    );
  });

  it('rejects a writing sentence containing a reading-only word ("colors")', () => {
    const file = syntheticSentencesFile([
      {
        kind: 'writing',
        ordinal: 1,
        text: 'What are the colors of the flag?',
        provenance: sentencesFile.sentences[0].provenance,
      },
    ]);

    const issues = validateEnglishContent(readingVocabulary, writingVocabulary, file);
    const errors = issues.filter((issue) => issue.severity === 'error');

    expect(
      errors.some((issue) => issue.code === 'sentence.offVocabularyToken' && issue.message.includes('colors')),
    ).toBe(true);
  });

  it('"taxes" is on the writing allowed-token set and NOT on the reading one', () => {
    const readingAllowed = expandVocabulary(readingVocabulary);
    const writingAllowed = expandVocabulary(writingVocabulary);
    expect(writingAllowed.has('taxes')).toBe(true);
    expect(readingAllowed.has('taxes')).toBe(false);
  });

  it('"colors" is on the reading allowed-token set and NOT on the writing one', () => {
    const readingAllowed = expandVocabulary(readingVocabulary);
    const writingAllowed = expandVocabulary(writingVocabulary);
    expect(readingAllowed.has('colors')).toBe(true);
    expect(writingAllowed.has('colors')).toBe(false);
  });

  it('accepts the exact same off-list word once it is on the correct list ("taxes" as writing)', () => {
    const file = syntheticSentencesFile([
      {
        kind: 'writing',
        ordinal: 1,
        text: 'We pay taxes.',
        provenance: sentencesFile.sentences[0].provenance,
      },
    ]);
    const issues = validateEnglishContent(readingVocabulary, writingVocabulary, file);
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// The sentinel regression this refinement exists for (docs/specs/
// english-test.md §1.4's "one refinement §1.4 does not yet name"): a naive
// per-entry normalizeAnswer call drops a leading "the"/"a" as an article,
// which would delete both from the allowed-token set and fail every
// sentence containing them. The sentinel guard must prevent that.
// -----------------------------------------------------------------------------

describe('tokenizeForVocabularyMatch — the sentinel regression', () => {
  it('demonstrates the underlying bug this exists to prevent: normalizeAnswer alone drops "the" and "a" entirely', () => {
    expect(normalizeAnswer('the')).toBe('');
    expect(normalizeAnswer('a')).toBe('');
  });

  it('"the" and "a" survive tokenizeForVocabularyMatch as real tokens', () => {
    expect(tokenizeForVocabularyMatch('the')).toEqual(['the']);
    expect(tokenizeForVocabularyMatch('a')).toEqual(['a']);
  });

  it('"the" and "a" are present as allowed tokens on the real reading vocabulary list', () => {
    const readingAllowed = expandVocabulary(readingVocabulary);
    expect(readingAllowed.has('the')).toBe(true);
    expect(readingAllowed.has('a')).toBe(true);
    expect(readingAllowed.get('the')).toEqual(new Set(['OTHER_FUNCTION']));
    expect(readingAllowed.get('a')).toEqual(new Set(['OTHER_FUNCTION']));
  });

  it('a sentence whose ONLY non-vocabulary-list content is its own leading article still validates ("The flag is red, white, and blue.")', () => {
    // Every one of these words is on the writing list ("the", "flag", "is",
    // "red", "white", "and", "blue") — this is sentence #6 in the real
    // file, restated here as a synthetic, isolated case so this test does
    // not depend on the real file's own ordinal numbering.
    const file: EnglishSentencesFile = {
      ...sentencesFile,
      sentences: [
        {
          kind: 'writing',
          ordinal: 1,
          text: 'The flag is red, white, and blue.',
          provenance: sentencesFile.sentences[0].provenance,
        },
      ],
    };
    const issues = validateEnglishContent(readingVocabulary, writingVocabulary, file);
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('a leading article mid-sentence-equivalent (non-leading "the") is unaffected either way', () => {
    // "of the United States" — the sentinel only changes what happens to a
    // LEADING article; a non-leading "the" was never dropped by
    // normalizeAnswer's own step 5 in the first place (see
    // answer-matching.ts's dropLeadingArticles — leading-only).
    expect(tokenizeForVocabularyMatch('of the United States')).toEqual(['of', 'the', 'united', 'states']);
  });
});

// -----------------------------------------------------------------------------
// expandVocabulary — "/" alternatives and multi-word entries.
// -----------------------------------------------------------------------------

describe('expandVocabulary', () => {
  it('expands a "/" entry into independent alternatives ("state/states")', () => {
    const readingAllowed = expandVocabulary(readingVocabulary);
    expect(readingAllowed.has('state')).toBe(true);
    expect(readingAllowed.has('states')).toBe(true);
  });

  it('a numeric "/" alternative and its word form resolve to the SAME token ("one hundred/100" -> "100")', () => {
    const writingAllowed = expandVocabulary(writingVocabulary);
    // Both "one hundred" and "100" normalise, through the full
    // normalizeAnswer pipeline's own number-word step, to the single digit
    // token "100" — verified directly here rather than assumed. The literal
    // word "one" never survives as its own token either, for the identical
    // reason: standalone "one" (also its own OTHER_CONTENT entry) normalises
    // to the digit "1", the same token "first" (an ordinal, elsewhere on the
    // same list) normalises to.
    expect(writingAllowed.has('100')).toBe(true);
    expect(writingAllowed.has('one')).toBe(false);
    expect(writingAllowed.has('1')).toBe(true);
  });

  it('a multi-word entry contributes each of its own words as separate tokens ("American flag" -> "american", "flag")', () => {
    const readingAllowed = expandVocabulary(readingVocabulary);
    expect(readingAllowed.get('american')).toEqual(new Set(['CIVICS']));
    // "flag" also resolves from "Flag Day" (HOLIDAYS) — a token
    // legitimately belonging to more than one category is expected, not a
    // bug (see expandVocabulary's own doc comment).
    expect(readingAllowed.get('flag')).toEqual(new Set(['CIVICS', 'HOLIDAYS']));
  });

  it('"Washington, D.C." expands through the full abbreviation pipeline, not a naive split ("washington", "district", "of", "columbia")', () => {
    const writingAllowed = expandVocabulary(writingVocabulary);
    for (const token of ['washington', 'district', 'of', 'columbia']) {
      expect(writingAllowed.has(token)).toBe(true);
    }
    // The intermediate tokens a naive (non-abbreviation-aware) tokeniser
    // would have produced must NOT be the ones actually stored — "d" and
    // "c" alone can never appear in a normalised sentence, per
    // docs/specs/english-test.md §1.4's own worked example.
    expect(writingAllowed.has('d')).toBe(false);
    expect(writingAllowed.has('c')).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// deriveVocabTags — determinism and sort order.
// -----------------------------------------------------------------------------

describe('deriveVocabTags', () => {
  it('is deterministic: the same tokens against the same vocabulary always produce the same array', () => {
    const readingAllowed = expandVocabulary(readingVocabulary);
    const tokens = tokenizeForVocabularyMatch('Who was the first President?');
    const first = deriveVocabTags(tokens, readingAllowed);
    const second = deriveVocabTags(tokens, readingAllowed);
    expect(first).toEqual(second);
  });

  it('is sorted', () => {
    const readingAllowed = expandVocabulary(readingVocabulary);
    const tokens = tokenizeForVocabularyMatch('Who was the first President?');
    const tags = deriveVocabTags(tokens, readingAllowed);
    expect(tags).toEqual([...tags].sort());
    expect(tags.length).toBeGreaterThan(0);
  });

  it('ignores a token with no vocabulary match rather than throwing', () => {
    const readingAllowed = expandVocabulary(readingVocabulary);
    expect(() => deriveVocabTags(['not-a-real-token'], readingAllowed)).not.toThrow();
    expect(deriveVocabTags(['not-a-real-token'], readingAllowed)).toEqual([]);
  });

  it('matches every real sentence\'s derived tags against a hand-checked case ("Where is the White House?")', () => {
    const readingAllowed = expandVocabulary(readingVocabulary);
    const tokens = tokenizeForVocabularyMatch('Where is the White House?');
    // where -> QUESTION_WORDS; is -> VERBS; the -> OTHER_FUNCTION;
    // white house -> CIVICS.
    const tags = deriveVocabTags(tokens, readingAllowed);
    expect(tags).toEqual(['CIVICS', 'OTHER_FUNCTION', 'QUESTION_WORDS', 'VERBS']);
  });
});
