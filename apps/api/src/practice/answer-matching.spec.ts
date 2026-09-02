import {
  MAX_RESPONSE_LENGTH,
  matchAnswer,
  normalizeAnswer,
  type AcceptedAnswer,
} from './answer-matching';

// =============================================================================
// answer-matching — tests (issue #70, epic #52 / E3)
// =============================================================================
//
// practice-sessions.md's normalisation table, one describe block per rule, in
// the order the rules run. These are pure functions, so every branch is
// reachable here without DI, HTTP or a database — including the ones that are
// awkward to stage over the wire (a 3000-character paste, a fullwidth keyboard,
// a response that normalises to nothing at all).
//
// Two conventions run through the whole file:
//
//   - Every rule that is symmetric is asserted in BOTH DIRECTIONS. A rewrite
//     that only fires on the learner's side is not normalisation, it is a bias:
//     `twenty-seven` would match the accepted `27` while `27` failed against an
//     accepted `twenty-seven`, and which of those a learner hits would depend
//     entirely on how the content happened to be seeded.
//   - The negative cases are as load-bearing as the positive ones. The
//     `Jefferson` / `Thomas Jefferson` case in particular is a REQUIREMENT that
//     this module say `incorrect`, not a gap — see its comment.
// =============================================================================

/** An accepted answer, with an id so assertions can name which one matched. */
function accepted(id: string, text: string): AcceptedAnswer {
  return { id, text };
}

describe('normalizeAnswer', () => {
  describe('rule 1 — Unicode NFKC, then lowercase', () => {
    it.each([
      ['The Constitution', 'constitution'],
      ['THE CONSTITUTION', 'constitution'],
      ['tHe CoNsTiTuTiOn', 'constitution'],
    ])('lowercases %p', (input, expected) => {
      expect(normalizeAnswer(input)).toBe(expected);
    });

    it('folds fullwidth letters an IME produces into their ASCII forms', () => {
      // NFKC, not NFC, precisely so a phone or IME keyboard is compared on the
      // same footing as a laptop. Under NFC these stay distinct code points and
      // nothing downstream can ever match them.
      expect(normalizeAnswer('Ｕ.Ｓ.')).toBe(normalizeAnswer('U.S.'));
    });

    it('treats a non-breaking space as whitespace', () => {
      expect(normalizeAnswer('bill of rights')).toBe('bill of rights');
    });
  });

  describe('rule 2 — leading filler', () => {
    it.each([
      ['the answer is the Constitution', 'constitution'],
      ['my answer is the Constitution', 'constitution'],
      ["i think it's the Constitution", 'constitution'],
      ['i think its the Constitution', 'constitution'],
      ['i think the Constitution', 'constitution'],
      ['answer: the Constitution', 'constitution'],
      ['it is the Constitution', 'constitution'],
      ["it's the Constitution", 'constitution'],
      ['its the Constitution', 'constitution'],
    ])('strips %p', (input, expected) => {
      expect(normalizeAnswer(input)).toBe(expected);
    });

    it('strips a compound opening across passes', () => {
      // `i think` fires first; only then is `it is` at the start. This is why
      // filler stripping runs more than once.
      expect(normalizeAnswer('I think it is the Constitution')).toBe(
        'constitution',
      );
    });

    it('accepts a typographic apostrophe as well as an ASCII one', () => {
      // NFKC does NOT unify U+2019 with U+0027, so a rule written only for the
      // ASCII apostrophe would silently fail on most mobile input.
      expect(normalizeAnswer('I think it’s the Constitution')).toBe(
        'constitution',
      );
    });

    it.each([
      // Not leading — the phrase is in the middle, where it is content.
      ['a right it is', 'right it is'],
      // Not followed by whitespace — `itself` is one word, not filler plus a
      // word, and must survive intact.
      ['itself', 'itself'],
      ['answering the question', 'answering the question'],
    ])('leaves %p alone because the phrase is not a leading filler', (
      input,
      expected,
    ) => {
      expect(normalizeAnswer(input)).toBe(expected);
    });
  });

  describe('rule 3 — possessives, punctuation and hyphens', () => {
    it.each([
      ["the President's", 'president'],
      ['the President’s', 'president'],
      ["the Speaker of the House's", 'speaker of the house'],
    ])('deletes the possessive in %p rather than spacing it', (
      input,
      expected,
    ) => {
      // Deleted, not spaced: `president s` would leave a stray token with
      // nothing to meet on the other side.
      expect(normalizeAnswer(input)).toBe(expected);
    });

    it.each([
      ['We, the People.', 'we the people'],
      ['(the) Constitution!', 'constitution'],
      ['freedom of speech;', 'freedom of speech'],
    ])('replaces punctuation in %p with a space', (input, expected) => {
      expect(normalizeAnswer(input)).toBe(expected);
    });

    it('spaces an intra-word hyphen rather than deleting it', () => {
      // Spacing is the whole reason `twenty-seven` can meet `27`: deleting
      // would produce `twentyseven`, one token no number scanner can decompose.
      expect(normalizeAnswer('self-government')).toBe('self government');
    });

    it('collapses the runs of whitespace punctuation removal leaves behind', () => {
      expect(normalizeAnswer('  the   U. S.   ')).toBe('united states');
    });
  });

  describe('rule 4 — abbreviations, whole tokens only', () => {
    it.each([
      ['U.S.', 'united states'],
      ['US', 'united states'],
      ['U.S.A.', 'united states'],
      ['USA', 'united states'],
      ['the United States', 'united states'],
    ])('expands %p to the canonical country name', (input, expected) => {
      expect(normalizeAnswer(input)).toBe(expected);
    });

    it.each([
      ['D.C.', 'district of columbia'],
      ['DC', 'district of columbia'],
      ['Washington, D.C.', 'washington district of columbia'],
      ['Washington DC', 'washington district of columbia'],
      ['the District of Columbia', 'district of columbia'],
    ])('expands %p to the canonical district name', (input, expected) => {
      expect(normalizeAnswer(input)).toBe(expected);
    });

    it.each([
      ['POTUS', 'president'],
      ['the President of the United States', 'president'],
      ['President', 'president'],
    ])('reduces %p to the canonical office name', (input, expected) => {
      expect(normalizeAnswer(input)).toBe(expected);
    });

    it('applies the longest phrase first, so `us` never eats the office name', () => {
      // Ordering the table by phrase length is what keeps this independent of
      // which rules exist tomorrow, rather than a coincidence of today's list.
      expect(normalizeAnswer('President of the United States of America')).toBe(
        'president of america',
      );
    });

    it.each([
      ['houses', 'houses'],
      ['Congress discusses', 'congress discusses'],
      ['Douglass', 'douglass'],
    ])('never rewrites %p, because the table is whole-token only', (
      input,
      expected,
    ) => {
      // A substring rewrite turns `houses` into `hounited statesnes`, and that
      // class of bug is invisible until a learner reports it.
      expect(normalizeAnswer(input)).toBe(expected);
    });

    it('accepts the `us` pronoun collision knowingly', () => {
      // Documented in the module header: in a naturalisation-test answer `us`
      // is overwhelmingly the country, and the alternative leaves `the U.S.`
      // unmatched against `the United States` — the exact case #70 was filed
      // for. The collision is a deliberate trade, so it is asserted rather
      // than left to be discovered as a surprise.
      expect(normalizeAnswer('us')).toBe('united states');
    });
  });

  describe('rule 5 — leading articles', () => {
    it.each([
      ['the Constitution', 'constitution'],
      ['a Senator', 'senator'],
      ['an Amendment', 'amendment'],
    ])('drops the leading article in %p', (input, expected) => {
      expect(normalizeAnswer(input)).toBe(expected);
    });

    it('drops leading articles repeatedly, including one an expansion exposed', () => {
      expect(normalizeAnswer('the the Constitution')).toBe('constitution');
    });

    it.each([
      ['the Bill of Rights', 'bill of rights'],
      ['the House of Representatives', 'house of representatives'],
      ['freedom to petition the government', 'freedom to petition the government'],
    ])('leaves the interior words of %p alone', (input, expected) => {
      // Only LEADING articles are noise. `bill of rights` is an answer whose
      // interior words carry meaning.
      expect(normalizeAnswer(input)).toBe(expected);
    });
  });

  describe('rule 6 — number words and ordinals to digits', () => {
    it.each([
      ['zero', '0'],
      ['one', '1'],
      ['six', '6'],
      ['nineteen', '19'],
      ['twenty', '20'],
      ['ninety', '90'],
      ['hundred', '100'],
    ])('maps the cardinal %p to its digits', (input, expected) => {
      expect(normalizeAnswer(input)).toBe(expected);
    });

    it.each([
      ['twenty-seven', '27'],
      ['twenty seven', '27'],
      ['thirty five', '35'],
      ['one hundred', '100'],
      ['two hundred', '200'],
    ])('composes the compound cardinal %p', (input, expected) => {
      // Composed, not looked up: a 200-entry table would be wrong at 101 and
      // would have to be written twice, once for ordinals.
      expect(normalizeAnswer(input)).toBe(expected);
    });

    it.each([
      ['first', '1'],
      ['second', '2'],
      ['tenth', '10'],
      ['nineteenth', '19'],
      ['twentieth', '20'],
      ['thirtieth', '30'],
      ['twenty-first', '21'],
      ['twenty first', '21'],
    ])('maps the ordinal %p to its digits', (input, expected) => {
      expect(normalizeAnswer(input)).toBe(expected);
    });

    it('leaves digits that are already digits exactly as they are', () => {
      // How `27` meets `twenty-seven` from the other direction, without a
      // second table.
      expect(normalizeAnswer('27')).toBe('27');
    });

    it.each([
      ['twenty seven senators', '27 senators'],
      ['the first ten amendments', '1 10 amendments'],
    ])('rewrites only the number run inside %p', (input, expected) => {
      expect(normalizeAnswer(input)).toBe(expected);
    });

    it.each([
      // A tens word may only open a hundreds group, so this is two numbers,
      // not an invented 50.
      ['twenty thirty', '20 30'],
      // A unit may only be added onto a multiple of ten, so this is two 7s.
      ['seven seven', '7 7'],
    ])('refuses to invent a value from word salad: %p', (input, expected) => {
      expect(normalizeAnswer(input)).toBe(expected);
    });
  });

  describe('rule 7 — whitespace, and the total-function guarantees', () => {
    it.each([
      ['', ''],
      ['   ', ''],
      ['\t\n  \n', ''],
      ['...', ''],
      ['the', ''],
    ])('returns a normalised string for %p without throwing', (
      input,
      expected,
    ) => {
      expect(normalizeAnswer(input)).toBe(expected);
    });

    it('never returns leading, trailing or repeated whitespace', () => {
      const result = normalizeAnswer('   The   U. S.  Constitution!!!   ');

      expect(result).toBe('united states constitution');
      expect(result).not.toMatch(/^\s|\s$|\s\s/);
    });

    it('is deterministic and side-effect free over repeated calls', () => {
      // A module's purity cannot be asserted directly at runtime, so this
      // stands in for it: same input, same output, no accumulated state, and
      // nothing the caller owns is mutated (strings are immutable, and every
      // array the implementation builds is local to one call).
      const input = "  I think it's the U.S. Constitution — twenty-seven!  ";
      const first = normalizeAnswer(input);

      for (let i = 0; i < 5; i += 1) {
        expect(normalizeAnswer(input)).toBe(first);
      }

      // Interleaving other inputs must not change the answer either.
      normalizeAnswer('POTUS');
      normalizeAnswer('twenty first');
      expect(normalizeAnswer(input)).toBe(first);
    });

    it('is idempotent — normalising an already normalised string is a no-op', () => {
      const once = normalizeAnswer('the U.S.');

      expect(normalizeAnswer(once)).toBe(once);
    });
  });
});

describe('matchAnswer', () => {
  describe('exact matches', () => {
    it('reports an identical response as `exact`, not as `normalized`', () => {
      const answers = [accepted('a1', 'the Constitution')];

      expect(matchAnswer('the Constitution', answers)).toEqual({
        outcome: 'correct',
        matchedAnswerId: 'a1',
        matchedAnswerText: 'the Constitution',
        rule: 'exact',
      });
    });

    it('trims the raw strings before comparing them', () => {
      const answers = [accepted('a1', 'the Constitution')];

      expect(matchAnswer('  the Constitution  ', answers).rule).toBe('exact');
    });

    it('checks exact across EVERY answer before checking normalised against any', () => {
      // The reason the two passes are not fused. Fused, a learner typing
      // `President` verbatim would be reported as a `normalized` match against
      // `the President` — the wrong id AND the wrong rule, purely because of
      // list order.
      const answers = [accepted('a1', 'the President'), accepted('a2', 'President')];

      expect(matchAnswer('President', answers)).toEqual({
        outcome: 'correct',
        matchedAnswerId: 'a2',
        matchedAnswerText: 'President',
        rule: 'exact',
      });
    });

    it('is case-sensitive on the exact pass, falling through to normalised', () => {
      const answers = [accepted('a1', 'the Constitution')];

      expect(matchAnswer('THE CONSTITUTION', answers).rule).toBe('normalized');
    });
  });

  describe.each([
    // The headline case of issue #70, and the case the e2e spec pins.
    ['the u.s.', 'the United States'],
    ['the United States', 'the u.s.'],
    ['USA', 'the United States'],
    ['the president', 'President'],
    ['President', 'the president'],
    ['POTUS', 'the President of the United States'],
    ['twenty-seven', '27'],
    ['27', 'twenty-seven'],
    ['first', '1'],
    ['1', 'first'],
    ["I think it's the Constitution", 'the Constitution'],
    ['the Constitution', "It's the Constitution"],
    ['Washington, D.C.', 'Washington DC'],
    ["the President's", 'the President'],
    ['THE BILL OF RIGHTS', 'the Bill of Rights'],
  ])('normalised match: %p against %p', (response, acceptedText) => {
    it('is correct, by the `normalized` rule, naming the answer it matched', () => {
      const answers = [accepted('right', acceptedText)];

      expect(matchAnswer(response, answers)).toEqual({
        outcome: 'correct',
        matchedAnswerId: 'right',
        matchedAnswerText: acceptedText,
        rule: 'normalized',
      });
    });
  });

  it('names the accepted answer that matched, out of several', () => {
    const answers = [
      accepted('legislative', 'Congress'),
      accepted('executive', 'the President'),
      accepted('judicial', 'the courts'),
    ];

    const result = matchAnswer('POTUS', answers);

    expect(result.matchedAnswerId).toBe('executive');
    expect(result.matchedAnswerText).toBe('the President');
  });

  describe.each([
    // Plainly different answers to the same question.
    ['the Senate', 'the House of Representatives'],
    ['george washington', 'Thomas Jefferson'],
    ['Congress', 'the President'],
    // A near-miss an edit distance WOULD accept. This module must NOT: it is
    // deliberately E4's (#53) job to judge a partial answer, with the question
    // and a rubric in front of it. Approving it here with an arbitrary
    // threshold would pre-empt that judgement with a strictly worse answer,
    // and would do it invisibly.
    ['Jefferson', 'Thomas Jefferson'],
    ['Thomas Jefferson Jr', 'Thomas Jefferson'],
    // Substring containment, which fails in both directions: `Washington` is
    // contained by `George Washington` AND by `Washington, D.C.` — answers to
    // different questions.
    ['Washington', 'George Washington'],
    ['the President', 'not the President'],
    // One transposed letter. Cheap for a distance metric, still not this
    // module's call to make.
    ['Consitution', 'the Constitution'],
  ])('non-match: %p against %p', (response, acceptedText) => {
    it('is incorrect, with nothing named and no rule', () => {
      expect(matchAnswer(response, [accepted('right', acceptedText)])).toEqual({
        outcome: 'incorrect',
        matchedAnswerId: null,
        matchedAnswerText: null,
        rule: null,
      });
    });
  });

  describe('degenerate input is answered, never thrown on', () => {
    const answers = [accepted('a1', 'the Constitution')];

    it.each([
      ['an empty string', ''],
      ['whitespace only', '   \t\n '],
      ['punctuation only', '...'],
      ['an article only', 'the'],
    ])('reports %s as incorrect', (_label, response) => {
      expect(() => matchAnswer(response, answers)).not.toThrow();
      expect(matchAnswer(response, answers).outcome).toBe('incorrect');
    });

    it('reports a 3000-character response as incorrect without throwing', () => {
      const huge = 'a'.repeat(3000);

      expect(huge.length).toBeGreaterThan(MAX_RESPONSE_LENGTH);
      expect(() => matchAnswer(huge, answers)).not.toThrow();
      expect(matchAnswer(huge, answers)).toEqual({
        outcome: 'incorrect',
        matchedAnswerId: null,
        matchedAnswerText: null,
        rule: null,
      });
    });

    it('rejects an over-long response even when it would otherwise match', () => {
      // The bound is on the raw length and is checked first, so a paste can
      // never buy itself a comparison it did not earn.
      const padded = `the Constitution${' '.repeat(MAX_RESPONSE_LENGTH)}`;

      expect(matchAnswer(padded, answers).outcome).toBe('incorrect');
    });

    it('accepts a response of exactly MAX_RESPONSE_LENGTH characters', () => {
      // The bound is inclusive; asserting the boundary keeps a later `>=`
      // typo from quietly shortening the limit by one.
      const atLimit = 'x'.repeat(MAX_RESPONSE_LENGTH);

      expect(matchAnswer(atLimit, [accepted('a1', atLimit)]).rule).toBe('exact');
    });

    it('reports incorrect against an empty answer list', () => {
      expect(matchAnswer('the Constitution', []).outcome).toBe('incorrect');
    });

    it('never lets an empty accepted answer match a blank response', () => {
      // Not structurally prevented in the content, so it is prevented here.
      expect(matchAnswer('   ', [accepted('blank', '  ')]).outcome).toBe(
        'incorrect',
      );
    });
  });

  it('does not mutate the accepted answers it was given', () => {
    const answers = [accepted('a1', 'the Constitution'), accepted('a2', '27')];
    const snapshot = JSON.stringify(answers);

    matchAnswer('twenty-seven', answers);

    expect(JSON.stringify(answers)).toBe(snapshot);
  });

  it('is deterministic over repeated calls with the same input', () => {
    const answers = [accepted('a1', 'the United States')];
    const first = matchAnswer('the u.s.', answers);

    for (let i = 0; i < 5; i += 1) {
      expect(matchAnswer('the u.s.', answers)).toEqual(first);
    }
  });
});
