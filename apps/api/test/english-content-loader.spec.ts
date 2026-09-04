// Tests for the English content loader (E10, epic #59 / issue #130) —
// docs/specs/english-test.md §1.3.
//
// Per docs/TESTING.md ("API tests never touch a database"), Prisma is fully
// mocked (jest-mock-extended, via test/mocks/prisma.mock's
// createMockPrismaService) — mirroring civics-content-loader.spec.ts's own
// approach: a fresh mock per test, with `englishSentence.findUnique`/
// `.create`/`.update` backed by a small in-memory store so idempotency (a
// second load over unchanged content writes nothing) is provable across two
// real calls to `loadEnglishContent` against the SAME mock, not merely
// asserted about its internals.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnglishContent } from '../prisma/content/load-english-content';
import type { EnglishSentencesFile, VocabularyFile } from '../prisma/content/english-vocabulary';
import { createMockPrismaService, type MockPrismaService } from './mocks/prisma.mock';

// -----------------------------------------------------------------------------
// A small, self-contained, deliberately-valid fixture set — not the real
// shipped content files. Keeping this fixture independent of the real
// content (which `english-content-validator.spec.ts` already exercises
// directly) means this suite stays correct even as real sentences are
// added, reviewed, and changed.
// -----------------------------------------------------------------------------

const PROVENANCE = {
  sourceUrl: 'https://example.test/vocab.pdf',
  retrievedAt: '2026-01-01',
  sha256: 'a'.repeat(64),
};

function readingVocabularyFixture(): VocabularyFile {
  return {
    kind: 'reading',
    version: 'test-v1',
    label: 'Test Reading Vocabulary',
    provenance: {
      ...PROVENANCE,
      transcription: { status: 'HUMAN_VERIFIED', warning: 'Synthetic test fixture, not real USCIS content.' },
    },
    categories: [
      { tag: 'PEOPLE', words: ['George Washington'] },
      { tag: 'VERBS', words: ['is/are/was/be'] },
      { tag: 'OTHER_FUNCTION', words: ['the', 'a'] },
      { tag: 'QUESTION_WORDS', words: ['Who'] },
    ],
  };
}

function writingVocabularyFixture(): VocabularyFile {
  return {
    kind: 'writing',
    version: 'test-v1',
    label: 'Test Writing Vocabulary',
    provenance: {
      ...PROVENANCE,
      transcription: { status: 'HUMAN_VERIFIED', warning: 'Synthetic test fixture, not real USCIS content.' },
    },
    categories: [
      { tag: 'CIVICS', words: ['flag'] },
      { tag: 'OTHER_FUNCTION', words: ['the'] },
      { tag: 'VERBS', words: ['is/was/be'] },
      { tag: 'OTHER_CONTENT', words: ['red'] },
    ],
  };
}

function sentencesFixture(overrides?: Partial<EnglishSentencesFile>): EnglishSentencesFile {
  return {
    version: 'test-v1',
    label: 'Test Sentences',
    composition: {
      status: 'HUMAN_COMPOSED_AND_REVIEWED',
      reviewedBy: '@test-fixture',
      reviewedAt: '2026-01-01',
      note: 'Synthetic test fixture.',
    },
    vocabulary: {
      reading: PROVENANCE,
      writing: PROVENANCE,
    },
    sentences: [
      { kind: 'reading', ordinal: 1, text: 'Who was George Washington?', provenance: PROVENANCE },
      { kind: 'writing', ordinal: 1, text: 'The flag is red.', provenance: PROVENANCE },
    ],
    ...overrides,
  };
}

let contentDir: string | undefined;

function writeContentDir(files: {
  reading?: VocabularyFile;
  writing?: VocabularyFile;
  sentences?: EnglishSentencesFile;
}): string {
  const dir = mkdtempSync(join(tmpdir(), 'english-content-'));
  writeFileSync(
    join(dir, 'english-vocabulary-reading.json'),
    JSON.stringify(files.reading ?? readingVocabularyFixture()),
    'utf8',
  );
  writeFileSync(
    join(dir, 'english-vocabulary-writing.json'),
    JSON.stringify(files.writing ?? writingVocabularyFixture()),
    'utf8',
  );
  writeFileSync(
    join(dir, 'english-sentences.json'),
    JSON.stringify(files.sentences ?? sentencesFixture()),
    'utf8',
  );
  contentDir = dir;
  return dir;
}

afterEach(() => {
  if (contentDir) {
    rmSync(contentDir, { recursive: true, force: true });
    contentDir = undefined;
  }
});

/**
 * A fresh, fully mocked Prisma client whose `englishSentence` methods are
 * backed by a small in-memory store keyed on the loader's own upsert key
 * (kind, version, ordinal) — real enough that calling `loadEnglishContent`
 * twice against the SAME instance actually proves idempotency, rather than
 * asserting it from call counts on a mock that always reports "nothing
 * exists yet".
 */
function freshPrisma(): MockPrismaService {
  const prisma = createMockPrismaService();
  const store = new Map<string, Record<string, unknown>>();
  let nextId = 1;

  (prisma.$transaction as jest.Mock).mockImplementation(async (arg: unknown) => {
    if (typeof arg === 'function') {
      return (arg as (tx: MockPrismaService) => unknown)(prisma);
    }
    if (Array.isArray(arg)) {
      return Promise.all(arg);
    }
    return arg;
  });

  (prisma.englishSentence.findUnique as jest.Mock).mockImplementation(async ({ where }: any) => {
    const { kind, version, ordinal } = where.kind_version_ordinal;
    return store.get(`${kind}:${version}:${ordinal}`) ?? null;
  });

  (prisma.englishSentence.create as jest.Mock).mockImplementation(async ({ data }: any) => {
    const key = `${data.kind}:${data.version}:${data.ordinal}`;
    const row = { id: `sentence-${nextId++}`, ...data };
    store.set(key, row);
    return row;
  });

  (prisma.englishSentence.update as jest.Mock).mockImplementation(async ({ where, data }: any) => {
    for (const [key, row] of store) {
      if (row.id === where.id) {
        const updated = { ...row, ...data };
        store.set(key, updated);
        return updated;
      }
    }
    throw new Error(`englishSentence.update: no row with id ${where.id}`);
  });

  return prisma;
}

describe('loadEnglishContent — writing and idempotency', () => {
  it('a first load creates one row per sentence and reports it in the summary', async () => {
    const dir = writeContentDir({});
    const prisma = freshPrisma();

    const summary = await loadEnglishContent(prisma as any, { contentDir: dir });

    expect(summary).toEqual({ sentencesWritten: 2, sentencesUnchanged: 0 });
    expect(prisma.englishSentence.create).toHaveBeenCalledTimes(2);
  });

  it('derives vocabTags and writes it on the created row', async () => {
    const dir = writeContentDir({});
    const prisma = freshPrisma();

    await loadEnglishContent(prisma as any, { contentDir: dir });

    const calls = (prisma.englishSentence.create as jest.Mock).mock.calls.map((c) => c[0].data);
    const readingRow = calls.find((c) => c.kind === 'reading');
    const writingRow = calls.find((c) => c.kind === 'writing');

    // "Who was George Washington?" -> who:QUESTION_WORDS, was:VERBS,
    // george/washington:PEOPLE.
    expect(readingRow.vocabTags).toEqual(['PEOPLE', 'QUESTION_WORDS', 'VERBS']);
    // "The flag is red." -> the:OTHER_FUNCTION, flag:CIVICS, is:VERBS,
    // red:OTHER_CONTENT.
    expect(writingRow.vocabTags).toEqual(['CIVICS', 'OTHER_CONTENT', 'OTHER_FUNCTION', 'VERBS']);
  });

  it('idempotent: a SECOND run over unchanged content writes nothing', async () => {
    const dir = writeContentDir({});
    const prisma = freshPrisma();

    const first = await loadEnglishContent(prisma as any, { contentDir: dir });
    expect(first).toEqual({ sentencesWritten: 2, sentencesUnchanged: 0 });

    const second = await loadEnglishContent(prisma as any, { contentDir: dir });
    expect(second).toEqual({ sentencesWritten: 0, sentencesUnchanged: 2 });

    // No further create/update calls happened on the second run — the
    // create-call count from the first run is unchanged, and update was
    // never called at all.
    expect(prisma.englishSentence.create).toHaveBeenCalledTimes(2);
    expect(prisma.englishSentence.update).not.toHaveBeenCalled();
  });

  it('a real content edit on the second run updates the changed row only', async () => {
    const dir = writeContentDir({});
    const prisma = freshPrisma();

    await loadEnglishContent(prisma as any, { contentDir: dir });

    // Edit the writing sentence's text in place (still valid against the
    // fixture's own vocabulary: "is" and "the" and "red" are already
    // allowed; "flag" too).
    const edited = sentencesFixture();
    edited.sentences[1] = { ...edited.sentences[1], text: 'The flag is red and the flag is here.' };
    // "here" is not on the fixture's writing vocabulary, so extend it too
    // rather than making this edit invalid.
    const writing = writingVocabularyFixture();
    writing.categories.push({ tag: 'OTHER_FUNCTION', words: ['here', 'and'] });
    writeFileSync(join(dir, 'english-vocabulary-writing.json'), JSON.stringify(writing), 'utf8');
    writeFileSync(join(dir, 'english-sentences.json'), JSON.stringify(edited), 'utf8');

    const second = await loadEnglishContent(prisma as any, { contentDir: dir });

    expect(second).toEqual({ sentencesWritten: 1, sentencesUnchanged: 1 });
    expect(prisma.englishSentence.update).toHaveBeenCalledTimes(1);
  });
});

describe('loadEnglishContent — validation gate', () => {
  it('throws on an off-vocabulary token and writes NOTHING to the database', async () => {
    const dir = writeContentDir({
      sentences: sentencesFixture({
        sentences: [
          // "taxes" is not on this fixture's reading vocabulary at all.
          { kind: 'reading', ordinal: 1, text: 'We pay taxes.', provenance: PROVENANCE },
        ],
      }),
    });
    const prisma = freshPrisma();

    await expect(loadEnglishContent(prisma as any, { contentDir: dir })).rejects.toThrow(
      /sentence\.offVocabularyToken/,
    );

    expect(prisma.englishSentence.create).not.toHaveBeenCalled();
    expect(prisma.englishSentence.update).not.toHaveBeenCalled();
  });

  it('throws on a reading sentence using a writing-only word, never silently merging the two lists', async () => {
    const dir = writeContentDir({
      sentences: sentencesFixture({
        sentences: [
          // "flag" is on the WRITING fixture only, not the reading one.
          { kind: 'reading', ordinal: 1, text: 'Who was the flag?', provenance: PROVENANCE },
        ],
      }),
    });
    const prisma = freshPrisma();

    await expect(loadEnglishContent(prisma as any, { contentDir: dir })).rejects.toThrow(/offVocabularyToken/);
    expect(prisma.englishSentence.create).not.toHaveBeenCalled();
  });
});
