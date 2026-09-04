// Tests for the civics content loader's pure logic (issue #106, epic #51).
//
// Per docs/TESTING.md, no test in apps/api/test may touch a database — these
// cover only the two decision functions that don't need one:
//   - computeContentHash: deterministic, order-independent canonicalization.
//   - assertTrustedForLoad: the unverified-content gate's decision matrix
//     (status × NODE_ENV × CIVICS_ALLOW_UNVERIFIED_CONTENT).
// Every other behaviour of the loader (the close-then-open answer lifecycle,
// the per-version transaction, convergence after an interrupted load) was
// proved against a live Postgres instead, per that same doc, and is recorded
// on the PR rather than asserted here against a mock that would only prove
// the mock does what the test told it to do.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentFile } from '../prisma/content/validate-content';
import { assertTrustedForLoad, computeContentHash, loadAllCivicsContent } from '../prisma/content/load-content';
import { Clock } from '../src/common/clock/clock';
import { createMockPrismaService, type MockPrismaService } from './mocks/prisma.mock';

const FIXTURES_DIR = join(__dirname, '..', 'prisma', 'content', '__fixtures__');

function loadFixture(name: string): ContentFile {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, `${name}.json`), 'utf8')) as ContentFile;
}

describe('computeContentHash', () => {
  it('is deterministic for the same content', () => {
    const file = loadFixture('valid-minimal');
    expect(computeContentHash(file)).toBe(computeContentHash(JSON.parse(JSON.stringify(file))));
  });

  it('is independent of key order (canonicalized before hashing)', () => {
    const file = loadFixture('valid-minimal');
    const reordered: ContentFile = {
      label: file.label,
      testVersionCode: file.testVersionCode,
      questions: file.questions,
      categories: file.categories,
      provenance: {
        transcription: file.provenance.transcription,
        sha256: file.provenance.sha256,
        retrievedAt: file.provenance.retrievedAt,
        sourceUrl: file.provenance.sourceUrl,
      },
      expected: {
        seniorEligibleCount: file.expected.seniorEligibleCount,
        questionCount: file.expected.questionCount,
      },
    };
    expect(computeContentHash(reordered)).toBe(computeContentHash(file));
  });

  it('changes when any real content changes', () => {
    const file = loadFixture('valid-minimal');
    const edited: ContentFile = JSON.parse(JSON.stringify(file));
    edited.questions[0].answers[0].text = 'A different answer';
    expect(computeContentHash(edited)).not.toBe(computeContentHash(file));
  });

  it('does not change for two structurally distinct but content-identical files', () => {
    // Two separately-parsed copies of literally the same file — the
    // canonicalization must not be sensitive to object identity or the
    // parser's own key insertion order.
    const a = loadFixture('valid-minimal');
    const b = loadFixture('valid-minimal');
    expect(computeContentHash(a)).toBe(computeContentHash(b));
  });
});

describe('assertTrustedForLoad — the unverified-content gate', () => {
  function fileWithStatus(status: ContentFile['provenance']['transcription']['status']): ContentFile {
    const file = loadFixture('valid-minimal');
    file.provenance.transcription.status = status;
    return file;
  }

  it('allows a HUMAN_VERIFIED file unconditionally (no env vars needed)', () => {
    const file = fileWithStatus('HUMAN_VERIFIED');
    expect(() => assertTrustedForLoad(file, 'f.json', {})).not.toThrow();
  });

  it('refuses an UNVERIFIED_MODEL_DRAFT file when the allow-flag is absent', () => {
    const file = fileWithStatus('UNVERIFIED_MODEL_DRAFT');
    expect(() => assertTrustedForLoad(file, 'f.json', {})).toThrow(/CIVICS_ALLOW_UNVERIFIED_CONTENT/);
  });

  it('refuses an AWAITING_SOURCE (non-empty) file when the allow-flag is absent', () => {
    const file = fileWithStatus('AWAITING_SOURCE');
    expect(() => assertTrustedForLoad(file, 'f.json', {})).toThrow(/CIVICS_ALLOW_UNVERIFIED_CONTENT/);
  });

  it('allows an unverified file when CIVICS_ALLOW_UNVERIFIED_CONTENT=true outside production', () => {
    const file = fileWithStatus('UNVERIFIED_MODEL_DRAFT');
    expect(() =>
      assertTrustedForLoad(file, 'f.json', { CIVICS_ALLOW_UNVERIFIED_CONTENT: 'true' }),
    ).not.toThrow();
  });

  it('does NOT allow the flag to be anything other than the exact string "true"', () => {
    const file = fileWithStatus('UNVERIFIED_MODEL_DRAFT');
    expect(() =>
      assertTrustedForLoad(file, 'f.json', { CIVICS_ALLOW_UNVERIFIED_CONTENT: '1' }),
    ).toThrow(/CIVICS_ALLOW_UNVERIFIED_CONTENT/);
  });

  // The production branch is matched on its own distinguishing sentence, NOT
  // on the bare word "production". Do not loosen this back to /production/:
  // the DEV refusal message also contains that word ("... never set this in
  // production"), so a bare match cannot tell the two branches apart. The
  // "no allow-flag" case below is where that mattered — with the production
  // branch deleted it falls through to the dev branch, which throws a message
  // containing "production", so /production/ passed while proving nothing
  // about the branch the test is named for.
  const PRODUCTION_ONLY = /NODE_ENV=production never loads unverified civics content/;

  it('refuses unconditionally when NODE_ENV=production, even with the allow-flag set', () => {
    const file = fileWithStatus('UNVERIFIED_MODEL_DRAFT');
    expect(() =>
      assertTrustedForLoad(file, 'f.json', {
        NODE_ENV: 'production',
        CIVICS_ALLOW_UNVERIFIED_CONTENT: 'true',
      }),
    ).toThrow(PRODUCTION_ONLY);
  });

  it('refuses in production even with no allow-flag at all (belt and suspenders)', () => {
    const file = fileWithStatus('UNVERIFIED_MODEL_DRAFT');
    expect(() => assertTrustedForLoad(file, 'f.json', { NODE_ENV: 'production' })).toThrow(PRODUCTION_ONLY);
  });
});

// -----------------------------------------------------------------------------
// loadAllCivicsContent — issue #216 regression.
//
// Before the fix, loadAllCivicsContent had no per-file error handling: the
// FIRST file that failed assertTrustedForLoad aborted the whole run. Files
// are discovered alphabetically (readdirSync().sort()), and
// "civics-2008.json" (UNVERIFIED_MODEL_DRAFT) sorts before "civics-2025.json"
// (HUMAN_VERIFIED) — so a directory with an unverified file sorting first is
// exactly the shape that shipped nothing to production. Every test here uses
// a real temp directory (via the injectable `contentDir` option) with
// synthetic fixture files, never the shipped apps/api/prisma/content/*.json,
// so these stay valid however that real content changes.
//
// Per docs/TESTING.md ("API tests never touch a database"), Prisma is fully
// mocked (jest-mock-extended, via test/mocks/prisma.mock's
// createMockPrismaService) — a fresh instance per test, matching the pattern
// NotificationStoreService's spec already uses for the same reason.
// -----------------------------------------------------------------------------

describe('loadAllCivicsContent — issue #216 regression', () => {
  let contentDir: string | undefined;

  afterEach(() => {
    if (contentDir) {
      rmSync(contentDir, { recursive: true, force: true });
      contentDir = undefined;
    }
  });

  /**
   * Clones the shared `valid-minimal` fixture (already used above for the
   * hash tests) with a distinct `testVersionCode` and transcription status,
   * so each synthetic file is independently identifiable and structurally
   * valid without hand-writing a new fixture per test.
   */
  function fixtureFile(
    testVersionCode: string,
    status: ContentFile['provenance']['transcription']['status'],
  ): ContentFile {
    const file: ContentFile = JSON.parse(JSON.stringify(loadFixture('valid-minimal')));
    file.testVersionCode = testVersionCode;
    file.provenance.transcription.status = status;
    return file;
  }

  /** Writes each `{ filename: ContentFile }` entry into a fresh temp dir and returns its path. */
  function writeContentDir(files: Record<string, ContentFile>): string {
    const dir = mkdtempSync(join(tmpdir(), 'civics-content-216-'));
    for (const [name, file] of Object.entries(files)) {
      writeFileSync(join(dir, name), JSON.stringify(file), 'utf8');
    }
    contentDir = dir;
    return dir;
  }

  /** A fresh, fully mocked Prisma client wired to actually "accept" writes (no existing rows, so every category/question/answer is a fresh insert) and to run `$transaction` callbacks against itself, matching `prisma.mock.ts`'s `mockPrismaTransaction` helper but per-instance rather than on the shared singleton. */
  function freshPrisma(): MockPrismaService {
    const prisma = createMockPrismaService();

    (prisma.$transaction as jest.Mock).mockImplementation(async (arg: unknown) => {
      if (typeof arg === 'function') {
        return (arg as (tx: MockPrismaService) => unknown)(prisma);
      }
      if (Array.isArray(arg)) {
        return Promise.all(arg);
      }
      return arg;
    });

    (prisma.civicsCategory.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.civicsCategory.create as jest.Mock).mockImplementation(async ({ data }: any) => ({
      id: `cat-${data.testVersionCode}-${data.code}`,
      ...data,
    }));

    (prisma.civicsQuestion.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.civicsQuestion.create as jest.Mock).mockImplementation(async ({ data }: any) => ({
      id: `q-${data.testVersionCode}-${data.number}`,
      ...data,
    }));

    (prisma.civicsAnswer.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.civicsAnswer.create as jest.Mock).mockImplementation(async ({ data }: any) => ({
      id: `a-${Math.random()}`,
      ...data,
    }));

    (prisma.civicsTestVersion.findUnique as jest.Mock).mockImplementation(async ({ where }: any) => ({
      code: where.code,
      contentHash: 'stale-hash-from-before-this-load',
    }));
    (prisma.civicsTestVersion.update as jest.Mock).mockResolvedValue({});

    return prisma;
  }

  it('#216 regression: an UNVERIFIED file sorting before a HUMAN_VERIFIED file must not stop the verified file from loading (production, no allow-flag)', async () => {
    const dir = writeContentDir({
      'a-unverified.json': fixtureFile('vunverified', 'UNVERIFIED_MODEL_DRAFT'),
      'b-verified.json': fixtureFile('vverified', 'HUMAN_VERIFIED'),
    });
    const prisma = freshPrisma();

    const summaries = await loadAllCivicsContent(prisma as any, {
      contentDir: dir,
      clock: new Clock(),
      env: { NODE_ENV: 'production' },
    });

    expect(summaries).toHaveLength(2);
    const [unverified, verified] = summaries;

    // This is the exact shape of #216: the alphabetically-first file is the
    // unverified one, and it must be SKIPPED, not fatal.
    expect(unverified.file).toBe('a-unverified.json');
    expect(unverified.skipped).toBe(true);
    expect(unverified.skipReason).toMatch(/not HUMAN_VERIFIED \(status=UNVERIFIED_MODEL_DRAFT\)/);

    // The verified file, sorting second, must still load — this is what
    // #216 broke (the unverified file throwing aborted the whole run before
    // this file was ever reached).
    expect(verified.file).toBe('b-verified.json');
    expect(verified.skipped).toBe(false);
    expect(verified.testVersionCode).toBe('vverified');
  });

  it('reports zero loaded versions when every file is unverified, which is what drives the CLI to exit non-zero', async () => {
    const dir = writeContentDir({
      'a-unverified.json': fixtureFile('vunverified-a', 'UNVERIFIED_MODEL_DRAFT'),
      'b-unverified.json': fixtureFile('vunverified-b', 'AWAITING_SOURCE'),
    });
    const prisma = freshPrisma();

    const summaries = await loadAllCivicsContent(prisma as any, {
      contentDir: dir,
      clock: new Clock(),
      env: { NODE_ENV: 'production' },
    });

    expect(summaries).toHaveLength(2);
    expect(summaries.every((s) => s.skipped)).toBe(true);
    expect(summaries.filter((s) => !s.skipped)).toHaveLength(0);
  });

  it('never writes a row from the skipped unverified file to the database (mixed directory)', async () => {
    const verifiedFixture = fixtureFile('vverified', 'HUMAN_VERIFIED');
    const dir = writeContentDir({
      'a-unverified.json': fixtureFile('vunverified', 'UNVERIFIED_MODEL_DRAFT'),
      'b-verified.json': verifiedFixture,
    });
    const prisma = freshPrisma();

    await loadAllCivicsContent(prisma as any, {
      contentDir: dir,
      clock: new Clock(),
      env: { NODE_ENV: 'production' },
    });

    const expectedCategoryWrites = verifiedFixture.categories.length;
    const expectedQuestionWrites = verifiedFixture.questions.length;
    const expectedAnswerWrites = verifiedFixture.questions.reduce((n, q) => n + q.answers.length, 0);

    // Every write that DID happen came from the verified file only — if the
    // unverified file's content had also reached the transaction, these
    // counts would be higher (valid-minimal has its own category/question/
    // answer counts on both clones).
    expect(prisma.civicsCategory.create).toHaveBeenCalledTimes(expectedCategoryWrites);
    expect(prisma.civicsQuestion.create).toHaveBeenCalledTimes(expectedQuestionWrites);
    expect(prisma.civicsAnswer.create).toHaveBeenCalledTimes(expectedAnswerWrites);

    for (const call of (prisma.civicsCategory.create as jest.Mock).mock.calls) {
      expect(call[0].data.testVersionCode).toBe('vverified');
    }
    for (const call of (prisma.civicsQuestion.create as jest.Mock).mock.calls) {
      expect(call[0].data.testVersionCode).toBe('vverified');
    }
  });

  it('does NOT swallow a non-refusal error — a real database failure still aborts the whole run', async () => {
    const dir = writeContentDir({
      'a-verified.json': fixtureFile('vverified', 'HUMAN_VERIFIED'),
    });
    const prisma = freshPrisma();
    // Simulate a genuine DB failure unrelated to the trust gate — the narrow
    // `instanceof UnverifiedContentError` catch in loadAllCivicsContent must
    // NOT treat this as a skippable per-file refusal.
    (prisma.civicsCategory.create as jest.Mock).mockRejectedValue(new Error('connection reset by peer'));

    await expect(
      loadAllCivicsContent(prisma as any, {
        contentDir: dir,
        clock: new Clock(),
        env: { NODE_ENV: 'production' },
      }),
    ).rejects.toThrow('connection reset by peer');
  });

  it('dev mode with CIVICS_ALLOW_UNVERIFIED_CONTENT=true loads both files, unchanged from before #216', async () => {
    const dir = writeContentDir({
      'a-unverified.json': fixtureFile('vunverified', 'UNVERIFIED_MODEL_DRAFT'),
      'b-verified.json': fixtureFile('vverified', 'HUMAN_VERIFIED'),
    });
    const prisma = freshPrisma();

    const summaries = await loadAllCivicsContent(prisma as any, {
      contentDir: dir,
      clock: new Clock(),
      env: { NODE_ENV: 'development', CIVICS_ALLOW_UNVERIFIED_CONTENT: 'true' },
    });

    expect(summaries).toHaveLength(2);
    expect(summaries.every((s) => !s.skipped)).toBe(true);
    expect(summaries.map((s) => s.testVersionCode)).toEqual(['vunverified', 'vverified']);
  });
});
