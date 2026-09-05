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
import {
  assertEnglishTrustedForLoad,
  loadEnglishContent,
  TRUSTED_SENTENCES_STATUSES,
  TRUSTED_VOCABULARY_STATUSES,
  UnverifiedEnglishContentError,
} from '../prisma/content/load-english-content';
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

// -----------------------------------------------------------------------------
// The unverified-content gate (issue #261).
//
// Mirrors civics-content-loader.spec.ts's `assertTrustedForLoad` block: the
// gate is a decision function over (status x trusted set x NODE_ENV x
// ENGLISH_ALLOW_UNVERIFIED_CONTENT), so its matrix is asserted directly here
// and its WIRING (the three call sites, and that a refusal happens before the
// transaction opens) is asserted against the loader in the block after this.
//
// Every case passes `env` explicitly rather than mutating `process.env` —
// that injectable option exists precisely so a test can state the environment
// it is deciding about without leaking it into the rest of the suite.
// -----------------------------------------------------------------------------

describe('assertEnglishTrustedForLoad — the unverified-content gate (issue #261)', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    // The allow-flag path deliberately warns; spying both silences the noise
    // and makes "it warned" assertable.
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  describe('the two trusted-status sets differ, deliberately', () => {
    // These four cases exist to prevent one specific future "simplification":
    // collapsing TRUSTED_VOCABULARY_STATUSES and TRUSTED_SENTENCES_STATUSES
    // into a single shared list. They are asymmetric on purpose (see
    // load-english-content.ts's header, difference 2): a vocabulary file is a
    // TRANSCRIPTION of an official USCIS list, so the only honest claim about
    // it is that a human checked it against that list — HUMAN_VERIFIED. A
    // sentence file records a COMPOSITION decision, for which this repository
    // has two honest answers. Merging the sets would make
    // HUMAN_COMPOSED_AND_REVIEWED a valid claim about a transcription, which
    // is a claim nobody can make: there is nothing to compose.

    it('accepts HUMAN_VERIFIED for a vocabulary file (the transcription token)', () => {
      expect(() =>
        assertEnglishTrustedForLoad('vocab.json', 'HUMAN_VERIFIED', TRUSTED_VOCABULARY_STATUSES, {}),
      ).not.toThrow();
    });

    it('accepts HUMAN_VERIFIED for the sentences file too — both sets contain it', () => {
      expect(() =>
        assertEnglishTrustedForLoad('sentences.json', 'HUMAN_VERIFIED', TRUSTED_SENTENCES_STATUSES, {}),
      ).not.toThrow();
    });

    it('accepts HUMAN_COMPOSED_AND_REVIEWED for the sentences file', () => {
      expect(() =>
        assertEnglishTrustedForLoad(
          'sentences.json',
          'HUMAN_COMPOSED_AND_REVIEWED',
          TRUSTED_SENTENCES_STATUSES,
          {},
        ),
      ).not.toThrow();
    });

    it('REFUSES HUMAN_COMPOSED_AND_REVIEWED for a vocabulary file — the asymmetry is the point', () => {
      expect(() =>
        assertEnglishTrustedForLoad(
          'vocab.json',
          'HUMAN_COMPOSED_AND_REVIEWED',
          TRUSTED_VOCABULARY_STATUSES,
          {},
        ),
      ).toThrow(UnverifiedEnglishContentError);
    });

    it('the two exported sets are not the same list (a shared constant would defeat every case above)', () => {
      expect([...TRUSTED_VOCABULARY_STATUSES]).toEqual(['HUMAN_VERIFIED']);
      expect([...TRUSTED_SENTENCES_STATUSES]).toEqual(['HUMAN_VERIFIED', 'HUMAN_COMPOSED_AND_REVIEWED']);
    });
  });

  describe('the allow-flag, outside production', () => {
    it('refuses an untrusted status when the allow-flag is absent', () => {
      expect(() =>
        assertEnglishTrustedForLoad('sentences.json', 'UNVERIFIED_MODEL_DRAFT', TRUSTED_SENTENCES_STATUSES, {}),
      ).toThrow(/ENGLISH_ALLOW_UNVERIFIED_CONTENT/);
    });

    it('refuses an empty status — a field somebody forgot to fill in is not a sign-off', () => {
      expect(() =>
        assertEnglishTrustedForLoad('sentences.json', '', TRUSTED_SENTENCES_STATUSES, {}),
      ).toThrow(UnverifiedEnglishContentError);
    });

    it('allows an untrusted status when ENGLISH_ALLOW_UNVERIFIED_CONTENT=true, and warns', () => {
      expect(() =>
        assertEnglishTrustedForLoad('sentences.json', 'UNVERIFIED_MODEL_DRAFT', TRUSTED_SENTENCES_STATUSES, {
          ENGLISH_ALLOW_UNVERIFIED_CONTENT: 'true',
        }),
      ).not.toThrow();

      // Proceeding silently would be the same failure #261 exists to fix, one
      // level down: an unverified load that leaves no trace it happened.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(/sentences\.json is not verified \(status=UNVERIFIED_MODEL_DRAFT\)/);
    });

    it('does NOT accept the flag as anything other than the exact string "true"', () => {
      for (const value of ['1', 'TRUE', 'yes', '']) {
        expect(() =>
          assertEnglishTrustedForLoad('sentences.json', 'UNVERIFIED_MODEL_DRAFT', TRUSTED_SENTENCES_STATUSES, {
            ENGLISH_ALLOW_UNVERIFIED_CONTENT: value,
          }),
        ).toThrow(/ENGLISH_ALLOW_UNVERIFIED_CONTENT/);
      }
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('production', () => {
    // The production branch is matched on the sentence "NODE_ENV=production
    // never loads", NOT on the bare word "production" — the DEV message also
    // contains that word (".. never set this in production"), so a bare
    // /production/ assertion would pass against the dev branch and prove
    // nothing about which branch ran.
    const PRODUCTION_ONLY = /NODE_ENV=production never loads unverified English content/;

    it('refuses regardless of the allow-flag', () => {
      expect(() =>
        assertEnglishTrustedForLoad('sentences.json', 'UNVERIFIED_MODEL_DRAFT', TRUSTED_SENTENCES_STATUSES, {
          NODE_ENV: 'production',
          ENGLISH_ALLOW_UNVERIFIED_CONTENT: 'true',
        }),
      ).toThrow(PRODUCTION_ONLY);
      expect(warn).not.toHaveBeenCalled();
    });

    it('refuses with no allow-flag at all (belt and suspenders)', () => {
      expect(() =>
        assertEnglishTrustedForLoad('sentences.json', 'UNVERIFIED_MODEL_DRAFT', TRUSTED_SENTENCES_STATUSES, {
          NODE_ENV: 'production',
        }),
      ).toThrow(PRODUCTION_ONLY);
    });

    it('says something different, and stronger, than the dev refusal does', () => {
      const dev = captureRefusal({});
      const prod = captureRefusal({ NODE_ENV: 'production', ENGLISH_ALLOW_UNVERIFIED_CONTENT: 'true' });

      expect(prod.message).not.toBe(dev.message);
      // Dev tells the operator how to proceed anyway; production tells them
      // there is no such escape hatch. Offering the dev instruction in
      // production would be actively wrong advice.
      expect(dev.message).toMatch(/Set ENGLISH_ALLOW_UNVERIFIED_CONTENT=true to load unverified content/);
      expect(prod.message).toMatch(PRODUCTION_ONLY);
      expect(prod.message).not.toMatch(/Set ENGLISH_ALLOW_UNVERIFIED_CONTENT=true to load/);
    });

    function captureRefusal(env: NodeJS.ProcessEnv): UnverifiedEnglishContentError {
      try {
        assertEnglishTrustedForLoad('sentences.json', 'UNVERIFIED_MODEL_DRAFT', TRUSTED_SENTENCES_STATUSES, env);
      } catch (error) {
        return error as UnverifiedEnglishContentError;
      }
      throw new Error('expected assertEnglishTrustedForLoad to refuse, but it returned');
    }
  });

  describe('the refusal names the offending file', () => {
    // A gate that refuses without saying WHICH of the three files was bad
    // sends the operator to read all three.
    it('carries the file label in the message and on the error object', () => {
      let caught: UnverifiedEnglishContentError | undefined;
      try {
        assertEnglishTrustedForLoad(
          'english-vocabulary-writing.json',
          'UNVERIFIED_MODEL_DRAFT',
          TRUSTED_VOCABULARY_STATUSES,
          {},
        );
      } catch (error) {
        caught = error as UnverifiedEnglishContentError;
      }

      expect(caught).toBeInstanceOf(UnverifiedEnglishContentError);
      expect(caught!.name).toBe('UnverifiedEnglishContentError');
      expect(caught!.message).toContain('english-vocabulary-writing.json');
      expect(caught!.fileLabel).toBe('english-vocabulary-writing.json');
      expect(caught!.status).toBe('UNVERIFIED_MODEL_DRAFT');
      // The expected set is named too, so the operator learns what a correct
      // status would have been without opening the loader.
      expect(caught!.message).toContain('HUMAN_VERIFIED');
    });

    it('names both accepted tokens when the sentences file is the one refused', () => {
      expect(() =>
        assertEnglishTrustedForLoad('english-sentences.json', 'AWAITING_REVIEW', TRUSTED_SENTENCES_STATUSES, {}),
      ).toThrow(/HUMAN_VERIFIED or HUMAN_COMPOSED_AND_REVIEWED/);
    });
  });
});

// -----------------------------------------------------------------------------
// The gate's WIRING into loadEnglishContent (issue #261) — all three call
// sites, and the ordering that makes the refusal worth anything.
//
// The ordering claim ("refuses BEFORE any database write") is proved with a
// TRIPWIRE Prisma rather than by asserting the throw and hoping: every method
// the loader could reach — `$transaction` included — throws a sentinel, so if
// the gate ever moved to after the transaction opened, these tests would fail
// with the sentinel instead of passing on a refusal that arrived too late.
// Asserting only `rejects.toThrow(UnverifiedEnglishContentError)` would not
// distinguish those two worlds.
// -----------------------------------------------------------------------------

describe('loadEnglishContent — the unverified-content gate (issue #261)', () => {
  const DB_TRIPWIRE = 'DB TRIPWIRE: loadEnglishContent reached the database';

  let warn: jest.SpyInstance;
  let log: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
    log.mockRestore();
  });

  /**
   * A Prisma whose every reachable method throws — so "the loader never
   * touched the database" is a visible failure rather than an absence a test
   * has to remember to assert.
   */
  function tripwirePrisma(): MockPrismaService {
    const prisma = createMockPrismaService();
    const trip = () => {
      throw new Error(DB_TRIPWIRE);
    };
    (prisma.$transaction as jest.Mock).mockImplementation(trip);
    (prisma.englishSentence.findUnique as jest.Mock).mockImplementation(trip);
    (prisma.englishSentence.create as jest.Mock).mockImplementation(trip);
    (prisma.englishSentence.update as jest.Mock).mockImplementation(trip);
    return prisma;
  }

  function vocabularyWithStatus(file: VocabularyFile, status: string): VocabularyFile {
    return {
      ...file,
      provenance: {
        ...file.provenance,
        transcription: { ...file.provenance.transcription, status },
      },
    };
  }

  function sentencesWithStatus(status: string): EnglishSentencesFile {
    const file = sentencesFixture();
    return { ...file, composition: { ...file.composition, status } };
  }

  /** Runs the loader expecting a refusal, and asserts nothing reached the database. */
  async function expectRefusal(
    prisma: MockPrismaService,
    dir: string,
    env: NodeJS.ProcessEnv,
  ): Promise<UnverifiedEnglishContentError> {
    let caught: unknown;
    try {
      await loadEnglishContent(prisma as any, { contentDir: dir, env });
    } catch (error) {
      caught = error;
    }

    // If the gate had moved after the transaction, `caught` would be the
    // tripwire's Error and this line is where that regression surfaces.
    expect(caught).toBeInstanceOf(UnverifiedEnglishContentError);
    expect((caught as Error).message).not.toContain(DB_TRIPWIRE);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.englishSentence.findUnique).not.toHaveBeenCalled();
    expect(prisma.englishSentence.create).not.toHaveBeenCalled();
    expect(prisma.englishSentence.update).not.toHaveBeenCalled();
    return caught as UnverifiedEnglishContentError;
  }

  describe('refusal in dev with no flag, before any database write', () => {
    it('refuses an unverified SENTENCES file and names it', async () => {
      const dir = writeContentDir({ sentences: sentencesWithStatus('UNVERIFIED_MODEL_DRAFT') });
      const prisma = tripwirePrisma();

      const error = await expectRefusal(prisma, dir, {});

      expect(error.fileLabel).toBe('english-sentences.json');
      expect(error.status).toBe('UNVERIFIED_MODEL_DRAFT');
      expect(error.message).toContain('english-sentences.json');
    });

    it('refuses an unverified READING vocabulary file and names it', async () => {
      const dir = writeContentDir({
        reading: vocabularyWithStatus(readingVocabularyFixture(), 'UNVERIFIED_MODEL_DRAFT'),
      });
      const prisma = tripwirePrisma();

      const error = await expectRefusal(prisma, dir, {});

      // A verified sentence list composed against an unverified word list is
      // not verified content — hence all three files are gated, not just the
      // one a learner reads.
      expect(error.fileLabel).toBe('english-vocabulary-reading.json');
      expect(error.message).toContain('english-vocabulary-reading.json');
    });

    it('refuses an unverified WRITING vocabulary file and names it', async () => {
      const dir = writeContentDir({
        writing: vocabularyWithStatus(writingVocabularyFixture(), 'UNVERIFIED_MODEL_DRAFT'),
      });
      const prisma = tripwirePrisma();

      const error = await expectRefusal(prisma, dir, {});

      expect(error.fileLabel).toBe('english-vocabulary-writing.json');
      expect(error.message).toContain('english-vocabulary-writing.json');
    });

    it('falls back to process.env when no env option is passed (NODE_ENV=test, no flag)', async () => {
      // The option defaults to `process.env`; the suite runs with NODE_ENV=test
      // and no allow-flag, so the real environment must produce the same dev
      // refusal. This covers the `options.env ?? process.env` line itself.
      const dir = writeContentDir({ sentences: sentencesWithStatus('UNVERIFIED_MODEL_DRAFT') });
      const prisma = tripwirePrisma();

      await expect(loadEnglishContent(prisma as any, { contentDir: dir })).rejects.toBeInstanceOf(
        UnverifiedEnglishContentError,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('the asymmetric trusted sets, end to end', () => {
    // The control-and-case pair that a single shared status list would
    // silently break: the SAME token is accepted on the sentences file and
    // refused on a vocabulary file, through the real loader, at the real call
    // sites. If someone "simplifies" the two sets into one, exactly one of
    // these two tests fails — whichever direction they collapsed it.

    it('accepts HUMAN_COMPOSED_AND_REVIEWED on the sentences file (the shipped fixture default)', async () => {
      const dir = writeContentDir({ sentences: sentencesWithStatus('HUMAN_COMPOSED_AND_REVIEWED') });
      const prisma = freshPrisma();

      const summary = await loadEnglishContent(prisma as any, { contentDir: dir, env: {} });

      expect(summary).toEqual({ sentencesWritten: 2, sentencesUnchanged: 0 });
      expect(warn).not.toHaveBeenCalled();
    });

    it('accepts HUMAN_VERIFIED on the sentences file too — the other honest answer', async () => {
      const dir = writeContentDir({ sentences: sentencesWithStatus('HUMAN_VERIFIED') });
      const prisma = freshPrisma();

      const summary = await loadEnglishContent(prisma as any, { contentDir: dir, env: {} });

      expect(summary).toEqual({ sentencesWritten: 2, sentencesUnchanged: 0 });
      expect(warn).not.toHaveBeenCalled();
    });

    it('REFUSES HUMAN_COMPOSED_AND_REVIEWED on a vocabulary file — a transcription cannot be composed', async () => {
      const dir = writeContentDir({
        reading: vocabularyWithStatus(readingVocabularyFixture(), 'HUMAN_COMPOSED_AND_REVIEWED'),
      });
      const prisma = tripwirePrisma();

      const error = await expectRefusal(prisma, dir, {});

      expect(error.fileLabel).toBe('english-vocabulary-reading.json');
      expect(error.status).toBe('HUMAN_COMPOSED_AND_REVIEWED');
      // The message must name the single token this file could have carried,
      // not the sentence file's pair.
      expect(error.message).toContain('not HUMAN_VERIFIED');
      expect(error.message).not.toContain('HUMAN_VERIFIED or HUMAN_COMPOSED_AND_REVIEWED');
    });
  });

  describe('ENGLISH_ALLOW_UNVERIFIED_CONTENT=true in dev', () => {
    // This is the control that makes the refusal cases above meaningful:
    // without it, they could be passing because the fixture is broken in some
    // unrelated way rather than because the gate refused.

    it('warns and proceeds — the same unverified content now loads', async () => {
      const dir = writeContentDir({ sentences: sentencesWithStatus('UNVERIFIED_MODEL_DRAFT') });
      const prisma = freshPrisma();

      const summary = await loadEnglishContent(prisma as any, {
        contentDir: dir,
        env: { ENGLISH_ALLOW_UNVERIFIED_CONTENT: 'true' },
      });

      expect(summary).toEqual({ sentencesWritten: 2, sentencesUnchanged: 0 });
      expect(prisma.englishSentence.create).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(/english-sentences\.json is not verified/);
    });

    it('warns once per offending file when all three are unverified, and still loads', async () => {
      const dir = writeContentDir({
        reading: vocabularyWithStatus(readingVocabularyFixture(), 'UNVERIFIED_MODEL_DRAFT'),
        writing: vocabularyWithStatus(writingVocabularyFixture(), 'UNVERIFIED_MODEL_DRAFT'),
        sentences: sentencesWithStatus('UNVERIFIED_MODEL_DRAFT'),
      });
      const prisma = freshPrisma();

      const summary = await loadEnglishContent(prisma as any, {
        contentDir: dir,
        env: { ENGLISH_ALLOW_UNVERIFIED_CONTENT: 'true' },
      });

      expect(summary).toEqual({ sentencesWritten: 2, sentencesUnchanged: 0 });
      expect(warn).toHaveBeenCalledTimes(3);
      const warned = warn.mock.calls.map((call) => String(call[0]));
      expect(warned.some((m) => m.includes('english-vocabulary-reading.json'))).toBe(true);
      expect(warned.some((m) => m.includes('english-vocabulary-writing.json'))).toBe(true);
      expect(warned.some((m) => m.includes('english-sentences.json'))).toBe(true);
    });
  });

  describe('NODE_ENV=production', () => {
    it('refuses regardless of the allow-flag, before any database write', async () => {
      const dir = writeContentDir({ sentences: sentencesWithStatus('UNVERIFIED_MODEL_DRAFT') });
      const prisma = tripwirePrisma();

      const error = await expectRefusal(prisma, dir, {
        NODE_ENV: 'production',
        ENGLISH_ALLOW_UNVERIFIED_CONTENT: 'true',
      });

      // An inherited or copied .env carrying the dev flag must not put
      // unreviewed sentences in front of a learner.
      expect(error.message).toMatch(/NODE_ENV=production never loads unverified English content/);
      expect(warn).not.toHaveBeenCalled();
    });

    it('its refusal message differs from the dev refusal for the same file and status', async () => {
      // One content directory, two environments — so the ONLY difference
      // between the two messages is the branch the gate took.
      const dir = writeContentDir({ sentences: sentencesWithStatus('UNVERIFIED_MODEL_DRAFT') });

      const devError = await expectRefusal(tripwirePrisma(), dir, {});
      const prodError = await expectRefusal(tripwirePrisma(), dir, { NODE_ENV: 'production' });

      expect(prodError.message).not.toBe(devError.message);
      expect(devError.message).toMatch(/Set ENGLISH_ALLOW_UNVERIFIED_CONTENT=true to load unverified content/);
      expect(prodError.message).not.toMatch(/Set ENGLISH_ALLOW_UNVERIFIED_CONTENT=true to load/);
    });

    it('still loads TRUSTED content in production, with no flag — the gate is not a production block', async () => {
      const dir = writeContentDir({});
      const prisma = freshPrisma();

      const summary = await loadEnglishContent(prisma as any, {
        contentDir: dir,
        env: { NODE_ENV: 'production' },
      });

      expect(summary).toEqual({ sentencesWritten: 2, sentencesUnchanged: 0 });
      expect(warn).not.toHaveBeenCalled();
    });
  });

  it('reports the STRUCTURAL problem first when content is both invalid and unverified', async () => {
    // The gate runs after validation, deliberately (see loadEnglishContent's
    // own comment): a file that is both broken and unverified should report
    // the broken-ness, which is the more actionable of the two. Both refusals
    // leave the database untouched, so the ordering is purely about which
    // message the operator gets.
    const invalidAndUnverified = sentencesWithStatus('UNVERIFIED_MODEL_DRAFT');
    invalidAndUnverified.sentences = [
      { kind: 'reading', ordinal: 1, text: 'We pay taxes.', provenance: PROVENANCE },
    ];
    const dir = writeContentDir({ sentences: invalidAndUnverified });
    const prisma = tripwirePrisma();

    let caught: unknown;
    try {
      await loadEnglishContent(prisma as any, { contentDir: dir, env: {} });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(UnverifiedEnglishContentError);
    expect((caught as Error).message).toMatch(/sentence\.offVocabularyToken/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
