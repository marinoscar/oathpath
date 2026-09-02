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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ContentFile } from '../prisma/content/validate-content';
import { assertTrustedForLoad, computeContentHash } from '../prisma/content/load-content';

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

  it('refuses unconditionally when NODE_ENV=production, even with the allow-flag set', () => {
    const file = fileWithStatus('UNVERIFIED_MODEL_DRAFT');
    expect(() =>
      assertTrustedForLoad(file, 'f.json', {
        NODE_ENV: 'production',
        CIVICS_ALLOW_UNVERIFIED_CONTENT: 'true',
      }),
    ).toThrow(/production/);
  });

  it('refuses in production even with no allow-flag at all (belt and suspenders)', () => {
    const file = fileWithStatus('UNVERIFIED_MODEL_DRAFT');
    expect(() => assertTrustedForLoad(file, 'f.json', { NODE_ENV: 'production' })).toThrow(/production/);
  });
});
