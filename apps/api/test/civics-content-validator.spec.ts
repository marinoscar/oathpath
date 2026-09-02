// Tests for the civics content validator (issue #101, epic #51).
//
// These fixtures each prove exactly one structural failure mode named in
// the issue's acceptance criteria: a miscount, a missing answer, an unknown
// category, an incomplete provenance block, a state-scope question missing
// states, and a national-scope question with two slots. None of this
// touches a database — the validator only ever reads JSON files.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ContentFile,
  loadContentFile,
  validateContent,
} from '../prisma/content/validate-content';

const FIXTURES_DIR = join(__dirname, '..', 'prisma', 'content', '__fixtures__');
const CONTENT_DIR = join(__dirname, '..', 'prisma', 'content');

function loadFixture(name: string): ContentFile {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, `${name}.json`), 'utf8')) as ContentFile;
}

function errorCodes(report: ReturnType<typeof validateContent>): string[] {
  return report.errors.map((e) => e.code);
}

describe('validateContent — structural rules', () => {
  it('passes a well-formed minimal file with zero errors', () => {
    const report = validateContent(loadFixture('valid-minimal'));
    expect(report.errors).toEqual([]);
    expect(report.structurallyValid).toBe(true);
  });

  it('fails on a miscount: expected count does not match actual question count', () => {
    const report = validateContent(loadFixture('miscount'));
    expect(errorCodes(report)).toContain('count.questionCount');
    expect(report.structurallyValid).toBe(false);
  });

  it('fails on a question with no answers', () => {
    const report = validateContent(loadFixture('missing-answer'));
    expect(errorCodes(report)).toContain('question.noAnswers');
    expect(report.structurallyValid).toBe(false);
  });

  it('fails when a categoryCode does not resolve to a declared category', () => {
    const report = validateContent(loadFixture('unknown-category'));
    expect(errorCodes(report)).toContain('question.unknownCategory');
    expect(report.structurallyValid).toBe(false);
  });

  it('fails on an incomplete provenance block (missing sourceUrl/sha256, invalid status, bad date)', () => {
    const report = validateContent(loadFixture('incomplete-provenance'));
    expect(errorCodes(report)).toEqual(
      expect.arrayContaining([
        'provenance.sourceUrl',
        'provenance.sha256',
        'provenance.retrievedAt',
        'provenance.transcription.status',
      ]),
    );
    expect(report.structurallyValid).toBe(false);
  });

  it('fails when a state-scope question is missing state/territory slots', () => {
    const report = validateContent(loadFixture('state-scope-missing-states'));
    expect(errorCodes(report)).toContain('question.state.missingStates');
    expect(report.structurallyValid).toBe(false);
    const missingIssue = report.errors.find((e) => e.code === 'question.state.missingStates')!;
    // 56 total minus the 3 the fixture declares (CA, TX, NY).
    expect(missingIssue.message).toMatch(/missing 53 state\/territory code\(s\)/);
  });

  it('fails when a national-scope question defines more than one answer slot', () => {
    const report = validateContent(loadFixture('national-two-slots'));
    expect(errorCodes(report)).toContain('question.national.slotCount');
    expect(report.structurallyValid).toBe(false);
  });

  it('flags a duplicate question number', () => {
    const base = loadFixture('valid-minimal');
    const dup: ContentFile = {
      ...base,
      expected: { ...base.expected, questionCount: 2 },
      questions: [base.questions[0], { ...base.questions[0] }],
    };
    const report = validateContent(dup);
    expect(errorCodes(report)).toContain('question.duplicateNumber');
  });

  it('flags an invalid dynamicScope value', () => {
    const base = loadFixture('valid-minimal');
    const bad: ContentFile = {
      ...base,
      questions: [{ ...base.questions[0], dynamicScope: 'planetary' as never }],
      expected: { ...base.expected, questionCount: 1 },
    };
    const report = validateContent(bad);
    expect(errorCodes(report)).toContain('question.invalidDynamicScope');
  });

  it('flags a none-scope question that sets a stateCode on any answer', () => {
    const base = loadFixture('valid-minimal');
    const bad: ContentFile = {
      ...base,
      expected: { ...base.expected, questionCount: 1 },
      questions: [
        {
          ...base.questions[0],
          answers: [{ ...base.questions[0].answers[0], stateCode: 'CA' }],
        },
      ],
    };
    const report = validateContent(bad);
    expect(errorCodes(report)).toContain('question.none.hasStateCode');
  });
});

describe('validateContent — known-gap vs. failure distinction', () => {
  it('downgrades a count mismatch to a known gap when transcription.status is AWAITING_SOURCE', () => {
    const base = loadFixture('miscount');
    const awaitingSource: ContentFile = {
      ...base,
      provenance: {
        ...base.provenance,
        transcription: { status: 'AWAITING_SOURCE', warning: 'still gathering source material' },
      },
    };
    const report = validateContent(awaitingSource);
    expect(errorCodes(report)).not.toContain('count.questionCount');
    expect(report.knownGaps.map((g) => g.code)).toContain('count.questionCount');
    // A known gap keeps the file out of structural failure...
    expect(report.structurallyValid).toBe(true);
    // ...but it is never "release ready".
    expect(report.releaseReady).toBe(false);
  });

  it('treats any file not HUMAN_VERIFIED as a known gap, never a structural error', () => {
    const report = validateContent(loadFixture('valid-minimal'));
    expect(report.structurallyValid).toBe(true);
    expect(report.knownGaps.map((g) => g.code)).toContain('trust.notHumanVerified');
    expect(report.releaseReady).toBe(false);
  });

  it('is release-ready only once HUMAN_VERIFIED and free of gaps and errors', () => {
    const base = loadFixture('valid-minimal');
    const verified: ContentFile = {
      ...base,
      provenance: {
        ...base.provenance,
        transcription: { status: 'HUMAN_VERIFIED' },
      },
    };
    const report = validateContent(verified);
    expect(report.errors).toEqual([]);
    expect(report.knownGaps).toEqual([]);
    expect(report.releaseReady).toBe(true);
  });
});

describe('validateContent — the real shipped content files', () => {
  it('civics-2008.json has zero structural errors, exactly 100 questions, and 20 senior-eligible questions', () => {
    const file = loadContentFile(join(CONTENT_DIR, 'civics-2008.json'));
    const report = validateContent(file, { fileLabel: 'civics-2008.json' });
    expect(report.errors).toEqual([]);
    expect(report.structurallyValid).toBe(true);
    expect(file.questions).toHaveLength(100);
    expect(file.questions.filter((q) => q.seniorEligible)).toHaveLength(20);
    // Never verified — this file must never be mistaken for trustworthy content.
    expect(file.provenance.transcription.status).toBe('UNVERIFIED_MODEL_DRAFT');
    expect(file.provenance.sha256).toBeNull();
    expect(report.releaseReady).toBe(false);
  });

  it('civics-2025.json has zero structural errors, exactly 128 questions, and 20 senior-eligible questions', () => {
    const file = loadContentFile(join(CONTENT_DIR, 'civics-2025.json'));
    const report = validateContent(file, { fileLabel: 'civics-2025.json' });
    expect(report.errors).toEqual([]);
    expect(report.structurallyValid).toBe(true);
    expect(file.questions).toHaveLength(128);
    expect(file.questions.filter((q) => q.seniorEligible)).toHaveLength(20);
    // Transcribed from the hashed official source, but no human has verified it
    // page-by-page yet — it must still not be mistaken for trustworthy content.
    expect(file.provenance.transcription.status).toBe('UNVERIFIED_MODEL_DRAFT');
    expect(typeof file.provenance.sha256).toBe('string');
    expect(file.provenance.sha256).not.toBeNull();
    // The question-count gap is gone now that the bank is fully transcribed —
    // only the human-verification gap remains, so it must never resurface here.
    expect(report.knownGaps.map((g) => g.code)).not.toContain('count.questionCount');
    expect(report.releaseReady).toBe(false);
  });

  it('every state-scope question in the real files covers all 56 state/territory codes', () => {
    for (const fileName of ['civics-2008.json', 'civics-2025.json']) {
      const file = loadContentFile(join(CONTENT_DIR, fileName));
      const stateScoped = file.questions.filter((q) => q.dynamicScope === 'state');
      expect(stateScoped.length).toBeGreaterThan(0);
      for (const q of stateScoped) {
        expect(q.answers).toHaveLength(56);
        expect(new Set(q.answers.map((a) => a.stateCode)).size).toBe(56);
      }
    }
  });
});
