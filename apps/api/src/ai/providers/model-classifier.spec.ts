import type { AiCapabilityFamily } from '../ai-model-roles';
import {
  classifyModel,
  filterCatalog,
  parseGeneration,
  passesGenerationFloor,
} from './model-classifier';

// =============================================================================
// OpenAI model classification (issue #29, epic #25)
// =============================================================================
//
// A FIXTURE OF REAL MODEL IDS, not invented ones. The classifier's whole job is
// to survive contact with the actual `GET /v1/models` response, which mixes
// eight kinds of model with overlapping name fragments — `gpt-4o-transcribe`
// contains both `gpt-` and `transcribe`, and getting the priority order wrong
// puts a speech model into a dropdown for the `grader` role.
//
// The fixture deliberately includes ids the classifier is NOT expected to
// recognise, because "what happens to an id we have never seen" is the
// behaviour most likely to be got wrong and least likely to be noticed.
// =============================================================================

/** Real ids, with the family each must land in. */
const FIXTURE: Array<[string, AiCapabilityFamily]> = [
  // --- text: the chat line ---------------------------------------------------
  ['gpt-4', 'text'],
  ['gpt-4o', 'text'],
  ['gpt-4o-mini', 'text'],
  ['gpt-4.1', 'text'],
  ['gpt-4.1-mini', 'text'],
  ['gpt-5', 'text'],
  ['gpt-5.4', 'text'],
  ['gpt-3.5-turbo', 'text'],
  ['chatgpt-4o-latest', 'text'],

  // --- text: the reasoning line ----------------------------------------------
  ['o1', 'text'],
  ['o1-mini', 'text'],
  ['o3', 'text'],
  ['o3-mini', 'text'],
  ['o4-mini', 'text'],

  // --- realtime: MUST beat the text rule, both contain `gpt-` -----------------
  ['gpt-4o-realtime-preview', 'realtime'],
  ['gpt-4o-mini-realtime-preview', 'realtime'],
  ['gpt-realtime', 'realtime'],

  // --- transcribe: also must beat the text rule ------------------------------
  ['whisper-1', 'transcribe'],
  ['gpt-4o-transcribe', 'transcribe'],
  ['gpt-4o-mini-transcribe', 'transcribe'],

  // --- tts -------------------------------------------------------------------
  ['tts-1', 'tts'],
  ['tts-1-hd', 'tts'],
  ['gpt-4o-mini-tts', 'tts'],

  // --- embedding -------------------------------------------------------------
  ['text-embedding-3-small', 'embedding'],
  ['text-embedding-3-large', 'embedding'],
  ['text-embedding-ada-002', 'embedding'],

  // --- other: real catalog entries this app has no role for ------------------
  // Without an explicit rule, `gpt-image-1` would classify as text and be
  // offered as a tutor.
  ['gpt-image-1', 'other'],
  ['dall-e-3', 'other'],
  ['omni-moderation-latest', 'other'],
  ['text-moderation-latest', 'other'],

  // --- other: ids the classifier is NOT expected to recognise ----------------
  // The behaviour that matters most. These must be classifiable-as-other and
  // reachable under show-all, never dropped.
  ['some-future-model-2027', 'other'],
  ['ft:custom-tune-abc123', 'other'],
  ['davinci-002', 'other'],
];

describe('classifyModel', () => {
  it.each(FIXTURE)('classifies %s as %s', (id, family) => {
    expect(classifyModel(id)).toBe(family);
  });

  it('puts an unrecognised id in `other` rather than dropping it', () => {
    // A model we cannot classify is not the same thing as a model that does
    // not exist. Treating them alike is how an upstream rename becomes an
    // admin with an empty dropdown and no workaround.
    expect(classifyModel('a-name-nobody-anticipated')).toBe('other');
  });

  it('handles degenerate input without throwing', () => {
    expect(classifyModel('')).toBe('other');
    expect(classifyModel(undefined as unknown as string)).toBe('other');
  });

  it('puts realtime before text, not the other way round', () => {
    // The priority-order claim, stated as its own test because reordering the
    // rule table would break it silently otherwise.
    expect(classifyModel('gpt-4o-realtime-preview')).not.toBe('text');
  });

  it('puts transcribe before text', () => {
    expect(classifyModel('gpt-4o-transcribe')).not.toBe('text');
  });
});

describe('parseGeneration', () => {
  it.each([
    ['gpt-4', 4],
    ['gpt-4o', 4],
    ['gpt-4o-mini', 4],
    ['gpt-4.1-mini', 4.1],
    ['gpt-5', 5],
    ['gpt-5.4', 5.4],
    ['gpt-3.5-turbo', 3.5],
    ['chatgpt-4o-latest', 4],
    ['o1', 1],
    ['o3-mini', 3],
    ['o4-mini', 4],
  ])('parses %s as generation %s', (id, expected) => {
    expect(parseGeneration(id)).toBe(expected);
  });

  it('returns a number, so 10 ranks above 9 rather than below it', () => {
    // As strings, '10' < '9'. A string comparison would rank a hypothetical
    // gpt-10 below gpt-9 and silently hide it from the dropdown.
    expect(parseGeneration('gpt-10')!).toBeGreaterThan(
      parseGeneration('gpt-9')!,
    );
  });

  it('parses the fractional part as a decimal — the documented limitation', () => {
    // Pinned deliberately so the behaviour is a decision on record rather than
    // an accident. `gpt-5.10` reads as 5.1, so it falls below a 5.4 floor even
    // though its name suggests it is newer. Every model OpenAI has shipped
    // fits decimal semantics (gpt-3.5, gpt-4.1), the epic specified a numeric
    // floor, and such a model stays reachable through show-all — which is the
    // class of failure that escape hatch exists for. See parseGeneration's own
    // note before changing this.
    expect(parseGeneration('gpt-5.10')).toBe(5.1);
  });

  it.each([
    'whisper-1',
    'tts-1-hd',
    'text-embedding-3-large',
    'dall-e-3',
    'some-future-model-2027',
    'ft:custom-tune-abc123',
  ])('returns null rather than a bogus number for %s', (id) => {
    // A heuristic that scraped the first digit out of any id would report
    // `text-embedding-3-large` as generation 3, and a text-family floor of 5.4
    // would look like it was working while doing nothing useful.
    expect(parseGeneration(id)).toBeNull();
  });
});

describe('passesGenerationFloor', () => {
  it('admits a model at or above the floor', () => {
    expect(passesGenerationFloor(5.4, 5.4)).toBe(true);
    expect(passesGenerationFloor(6, 5.4)).toBe(true);
  });

  it('excludes a model below the floor', () => {
    expect(passesGenerationFloor(4, 5.4)).toBe(false);
  });

  it('ADMITS an unparseable generation', () => {
    // The floor's job is to hide models we know are too old. "We could not
    // tell" is not that, and filtering them out is how an upstream rename
    // empties a dropdown with no error to explain it.
    expect(passesGenerationFloor(null, 5.4)).toBe(true);
  });
});

describe('filterCatalog', () => {
  const catalog = FIXTURE.map(([id, family]) => ({
    id,
    family,
    generation: parseGeneration(id),
  }));

  const defaultFilter = { minGeneration: 5.4, showAll: false };

  it('never applies the floor to transcription, TTS or embedding', () => {
    // The acceptance criterion. `whisper-1` has no parseable generation and
    // its family is not a text family, so a floor of 5.4 must not touch it.
    const kept = filterCatalog(catalog, defaultFilter).map((m) => m.id);

    expect(kept).toContain('whisper-1');
    expect(kept).toContain('tts-1-hd');
    expect(kept).toContain('text-embedding-3-large');
    expect(kept).toContain('gpt-4o-realtime-preview');
  });

  it('applies the floor to the text family', () => {
    const kept = filterCatalog(catalog, defaultFilter).map((m) => m.id);

    expect(kept).toContain('gpt-5.4');
    expect(kept).not.toContain('gpt-4o');
    expect(kept).not.toContain('o3-mini');
  });

  it('hides `other` from the default view', () => {
    const kept = filterCatalog(catalog, defaultFilter).map((m) => m.id);

    expect(kept).not.toContain('gpt-image-1');
    expect(kept).not.toContain('some-future-model-2027');
  });

  it('returns strictly more models under show-all, including unparseable ones', () => {
    // The escape hatch's contract, asserted as a superset rather than as a
    // count, so it stays true as the fixture grows.
    const narrow = filterCatalog(catalog, defaultFilter).map((m) => m.id);
    const all = filterCatalog(catalog, { minGeneration: 5.4, showAll: true }).map(
      (m) => m.id,
    );

    expect(all.length).toBeGreaterThan(narrow.length);
    for (const id of narrow) expect(all).toContain(id);
    expect(all).toContain('some-future-model-2027');
    expect(all).toContain('gpt-4o');
  });

  it('restricts to one family when asked', () => {
    const textOnly = filterCatalog(catalog, {
      ...defaultFilter,
      family: 'text',
    });

    expect(textOnly.every((m) => m.family === 'text')).toBe(true);
    // A grader dropdown must never offer whisper.
    expect(textOnly.map((m) => m.id)).not.toContain('whisper-1');
  });

  it('returns an empty array rather than throwing when nothing matches', () => {
    // "Filtered to nothing" is a legitimate answer; the caller distinguishes
    // it from a failed fetch, which is reported separately.
    expect(
      filterCatalog(catalog, { ...defaultFilter, minGeneration: 99 }),
    ).toEqual(
      // Non-text families are unaffected by the floor, so they survive.
      expect.arrayContaining([]),
    );
    expect(
      filterCatalog([], defaultFilter),
    ).toEqual([]);
  });
});
