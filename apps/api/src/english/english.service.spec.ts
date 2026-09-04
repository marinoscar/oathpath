import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { ASR_CONFIDENCE_THRESHOLD } from '../ai/ai.types';
import { Clock } from '../common/clock/clock';
import { PrismaService } from '../prisma/prisma.service';
import {
  EnglishService,
  isMisheardReading,
  summarizeEnglishProgress,
  type ProgressAttemptRow,
} from './english.service';

// =============================================================================
// EnglishService — tests (issue #136, epic #59 / E10)
// =============================================================================
//
// The decisions, not the plumbing — the posture `practice.service.spec.ts`
// takes, applied to the one gate this service owns: §3's misheard rule, whose
// whole content is WHETHER A ROW IS WRITTEN. So most assertions here are about
// `create` having been called, or not, which is the only observable difference
// between "recorded as a failure" and "not recorded at all".
//
// Prisma is mocked with a small hand-built stub rather than
// `jest-mock-extended`'s `mockDeep`: this service reads and writes exactly two
// models, and a plain object keeps every mock's shape visible in this file. No
// test in this repository touches a database (docs/TESTING.md).
// =============================================================================

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

const READING_ID = 'aaaaaaa1-1111-4111-8111-111111111111';
const WRITING_ID = 'aaaaaaa2-2222-4222-8222-222222222222';

const NOW = new Date('2026-09-04T12:00:00Z');

const READING = {
  id: READING_ID,
  kind: 'reading' as const,
  version: 'v1',
  ordinal: 1,
  text: 'Who was the first President?',
  vocabTags: ['PEOPLE', 'QUESTION WORDS'],
};

const WRITING = {
  id: WRITING_ID,
  kind: 'writing' as const,
  version: 'v1',
  ordinal: 1,
  text: 'We pay taxes.',
  vocabTags: ['CIVICS'],
};

/** A confidence the recogniser is NOT sure about — strictly below the threshold. */
const LOW_CONFIDENCE = ASR_CONFIDENCE_THRESHOLD - 0.1;

describe('EnglishService', () => {
  let service: EnglishService;
  let prisma: {
    englishSentence: { findMany: jest.Mock; findUnique: jest.Mock };
    englishAttempt: { findMany: jest.Mock; create: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      englishSentence: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
      },
      englishAttempt: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockImplementation(async ({ data }: any) => ({
          id: '99999999-9999-4999-8999-999999999999',
          answeredAt: data.answeredAt,
          asrConfidence: data.asrConfidence,
          replayCount: data.replayCount,
        })),
      },
    };

    const clock = { now: () => new Date(NOW) } as unknown as Clock;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EnglishService,
        { provide: PrismaService, useValue: prisma },
        { provide: Clock, useValue: clock },
      ],
    }).compile();

    service = module.get(EnglishService);
  });

  // ---------------------------------------------------------------------------
  // GET /english/next
  // ---------------------------------------------------------------------------

  describe('getNext', () => {
    it('scopes both queries to the caller and the requested kind', async () => {
      prisma.englishSentence.findMany.mockResolvedValue([READING]);

      await service.getNext(USER_A, 'reading');

      expect(prisma.englishSentence.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { kind: 'reading' } }),
      );
      // BOTH keys in the `where`, not one filtered and one checked after: this
      // is what makes another learner's history structurally unreachable
      // rather than merely unread.
      expect(prisma.englishAttempt.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: USER_A, kind: 'reading' } }),
      );
    });

    it('returns the sentence with the SCORER’s word count, not a space split', async () => {
      prisma.englishSentence.findMany.mockResolvedValue([READING]);

      const { sentence } = await service.getNext(USER_A, 'reading');

      expect(sentence).toEqual({
        id: READING_ID,
        kind: 'reading',
        version: 'v1',
        ordinal: 1,
        text: 'Who was the first President?',
        vocabTags: ['PEOPLE', 'QUESTION WORDS'],
        // "Who was the first President?" normalises to
        // `who was the 1 president` — five tokens, not the five-word raw split
        // that only coincidentally agrees here. `english-scoring.spec.ts`
        // pins the normalisation itself.
        wordCount: 5,
      });
    });

    it('returns the writing sentence’s text too — the client needs it to speak it', async () => {
      // §4: dictation defaults to the browser's own `speechSynthesis`, which
      // takes a STRING. Withholding `text` would make the free default
      // impossible and leave server-side synthesis as the only way to hear a
      // writing sentence, which §4 forbids as the ONLY way.
      prisma.englishSentence.findMany.mockResolvedValue([WRITING]);

      const { sentence } = await service.getNext(USER_A, 'writing');

      expect(sentence?.text).toBe('We pay taxes.');
    });

    it('returns { sentence: null } for an empty bank rather than throwing', async () => {
      prisma.englishSentence.findMany.mockResolvedValue([]);

      await expect(service.getNext(USER_A, 'writing')).resolves.toEqual({
        sentence: null,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // POST /english/attempts — the misheard gate (§3)
  // ---------------------------------------------------------------------------

  describe('recordAttempt — the misheard gate', () => {
    beforeEach(() => {
      prisma.englishSentence.findUnique.mockResolvedValue(READING);
    });

    it('WRITES NO ROW for a low-confidence reading attempt that did not score correct', async () => {
      const result = await service.recordAttempt(USER_A, {
        sentenceId: READING_ID,
        responseText: 'who was the worst president ever',
        asrConfidence: LOW_CONFIDENCE,
        replayCount: 0,
      });

      // THE assertion of this whole section. `misheard` is the ABSENCE of a
      // recorded failure (§3) — not an `incorrect` row, not a flagged row, not
      // a row at all.
      expect(prisma.englishAttempt.create).not.toHaveBeenCalled();

      expect(result.status).toBe('misheard');
      expect(result).not.toHaveProperty('attemptId');
      expect(result).not.toHaveProperty('outcome');
    });

    it('still returns the diff and the wer, so the retry screen can show what was heard', async () => {
      const result = await service.recordAttempt(USER_A, {
        sentenceId: READING_ID,
        responseText: 'hoo woz the ferst prezident',
        asrConfidence: LOW_CONFIDENCE,
        replayCount: 0,
      });

      expect(result.status).toBe('misheard');
      expect(result.wer).toBeGreaterThan(0);
      expect(result.diff.length).toBeGreaterThan(0);
      // The sentence itself, so the learner can compare it against what was
      // heard rather than being told only that something went wrong.
      expect(result.text).toBe(READING.text);
      if (result.status === 'misheard') {
        expect(result.asrConfidence).toBe(LOW_CONFIDENCE);
        expect(result.confidenceThreshold).toBe(ASR_CONFIDENCE_THRESHOLD);
      }
    });

    it('WRITES a row when a low-confidence transcript scored correct anyway', async () => {
      // Whatever the recogniser's misgivings, the words it produced were the
      // sentence. Discarding this would throw away a pass the learner earned.
      const result = await service.recordAttempt(USER_A, {
        sentenceId: READING_ID,
        responseText: 'Who was the first President?',
        asrConfidence: LOW_CONFIDENCE,
        replayCount: 0,
      });

      expect(prisma.englishAttempt.create).toHaveBeenCalledTimes(1);
      expect(result.status).toBe('scored');
      if (result.status === 'scored') expect(result.outcome).toBe('correct');
    });

    it('WRITES a row when no confidence was reported — unknown is not low', async () => {
      // A transcript from a model that reports no confidence at all (the
      // `gpt-4o-transcribe` family) is scored and recorded normally. The
      // failure this guards against is silent: a learner on such a model would
      // simply stop accumulating evidence, with nothing to say why.
      const result = await service.recordAttempt(USER_A, {
        sentenceId: READING_ID,
        responseText: 'nothing like the sentence at all',
        replayCount: 0,
      });

      expect(prisma.englishAttempt.create).toHaveBeenCalledTimes(1);
      expect(result.status).toBe('scored');
      expect(
        prisma.englishAttempt.create.mock.calls[0][0].data.asrConfidence,
      ).toBeNull();
    });

    it('WRITES a row at exactly the threshold — 0.6 is trusted', async () => {
      // Strictly below, never at-or-below: the boundary has to fall on one
      // side, and trusting the transcript is the side that cannot invent a
      // mishearing that did not happen (`ASR_CONFIDENCE_THRESHOLD`'s own doc).
      await service.recordAttempt(USER_A, {
        sentenceId: READING_ID,
        responseText: 'not the sentence',
        asrConfidence: ASR_CONFIDENCE_THRESHOLD,
        replayCount: 0,
      });

      expect(prisma.englishAttempt.create).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // POST /english/attempts — writing
  // ---------------------------------------------------------------------------

  describe('recordAttempt — writing', () => {
    beforeEach(() => {
      prisma.englishSentence.findUnique.mockResolvedValue(WRITING);
    });

    it('rejects asrConfidence on a writing attempt — a typed answer was not transcribed', async () => {
      await expect(
        service.recordAttempt(USER_A, {
          sentenceId: WRITING_ID,
          responseText: 'We pay taxes.',
          asrConfidence: 0.9,
          replayCount: 0,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.englishAttempt.create).not.toHaveBeenCalled();
    });

    it('stores a null asrConfidence for a writing attempt', async () => {
      await service.recordAttempt(USER_A, {
        sentenceId: WRITING_ID,
        responseText: 'We pay taxes.',
        replayCount: 3,
      });

      const data = prisma.englishAttempt.create.mock.calls[0][0].data;
      expect(data.asrConfidence).toBeNull();
      expect(data.kind).toBe('writing');
      // Recorded, never gating: the outcome is `correct` despite three replays.
      expect(data.replayCount).toBe(3);
      expect(data.outcome).toBe('correct');
    });

    it('never gates the outcome on replayCount', async () => {
      const many = await service.recordAttempt(USER_A, {
        sentenceId: WRITING_ID,
        responseText: 'We pay taxes.',
        replayCount: 12,
      });

      expect(many.status).toBe('scored');
      if (many.status === 'scored') expect(many.outcome).toBe('correct');
    });

    it('reveals the sentence text — the writing screen never showed it', async () => {
      const result = await service.recordAttempt(USER_A, {
        sentenceId: WRITING_ID,
        responseText: 'we pay tax',
        replayCount: 1,
      });

      expect(result.text).toBe('We pay taxes.');
    });
  });

  // ---------------------------------------------------------------------------
  // POST /english/attempts — the row itself
  // ---------------------------------------------------------------------------

  describe('recordAttempt — the written row', () => {
    it('404s an unknown sentence and writes nothing', async () => {
      prisma.englishSentence.findUnique.mockResolvedValue(null);

      await expect(
        service.recordAttempt(USER_A, {
          sentenceId: READING_ID,
          responseText: 'anything',
          replayCount: 0,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(prisma.englishAttempt.create).not.toHaveBeenCalled();
    });

    it('rejects a non-zero replayCount on a reading attempt', async () => {
      // A reading sentence is on the screen; there is no dictated prompt to
      // replay. `english_attempts.replay_count`'s column comment says "always
      // 0 for a reading row", and this is what makes that structurally true.
      prisma.englishSentence.findUnique.mockResolvedValue(READING);

      await expect(
        service.recordAttempt(USER_A, {
          sentenceId: READING_ID,
          responseText: 'Who was the first President?',
          replayCount: 2,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.englishAttempt.create).not.toHaveBeenCalled();
    });

    it('stamps the caller, the sentence’s own kind, and the injected clock', async () => {
      prisma.englishSentence.findUnique.mockResolvedValue(READING);

      const result = await service.recordAttempt(USER_B, {
        sentenceId: READING_ID,
        responseText: 'Who was the first President?',
        asrConfidence: 0.95,
        replayCount: 0,
      });

      const data = prisma.englishAttempt.create.mock.calls[0][0].data;
      expect(data.userId).toBe(USER_B);
      // From the SENTENCE, never the request — there is no `kind` field on the
      // body at all (see the DTO's compile-time proof).
      expect(data.kind).toBe('reading');
      expect(data.answeredAt).toEqual(NOW);
      expect(data.asrConfidence).toBe(0.95);
      expect(result.status).toBe('scored');
      if (result.status === 'scored') {
        expect(result.answeredAt).toBe(NOW.toISOString());
      }
    });

    it('stores the structured diff, not a summary string', async () => {
      prisma.englishSentence.findUnique.mockResolvedValue(WRITING);

      await service.recordAttempt(USER_A, {
        sentenceId: WRITING_ID,
        responseText: 'we pay',
        replayCount: 0,
      });

      const data = prisma.englishAttempt.create.mock.calls[0][0].data;
      expect(Array.isArray(data.diffOps)).toBe(true);
      expect(data.diffOps[0]).toEqual(
        expect.objectContaining({ kind: expect.any(String), referenceIndex: 0 }),
      );
      expect(typeof data.wer).toBe('number');
    });
  });

  // ---------------------------------------------------------------------------
  // GET /english/progress
  // ---------------------------------------------------------------------------

  describe('getProgress', () => {
    it('reads only the caller’s own attempts', async () => {
      prisma.englishSentence.findMany.mockResolvedValue([READING, WRITING]);

      await service.getProgress(USER_A);

      expect(prisma.englishAttempt.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: USER_A } }),
      );
    });
  });
});

// =============================================================================
// The pure pieces, asserted without a service at all
// =============================================================================

describe('isMisheardReading', () => {
  it.each([
    ['reading', LOW_CONFIDENCE, 'incorrect' as const, true],
    ['reading', LOW_CONFIDENCE, 'partial' as const, true],
    // Condition 4 — a low-confidence transcript that scored correct is not in
    // doubt about the thing being measured.
    ['reading', LOW_CONFIDENCE, 'correct' as const, false],
    // Condition 3 — strictly below.
    ['reading', ASR_CONFIDENCE_THRESHOLD, 'incorrect' as const, false],
    // Condition 1 — a writing attempt has no recognition step to distrust.
    ['writing', LOW_CONFIDENCE, 'incorrect' as const, false],
  ])('kind=%s confidence=%s outcome=%s → %s', (kind, confidence, outcome, expected) => {
    expect(
      isMisheardReading(kind as 'reading' | 'writing', confidence as number, outcome),
    ).toBe(expected);
  });

  it('treats null and undefined confidence as UNKNOWN, never as low', () => {
    // The one comparison in this codebase that must never be written as
    // `(confidence ?? 0) < THRESHOLD`.
    expect(isMisheardReading('reading', null, 'incorrect')).toBe(false);
    expect(isMisheardReading('reading', undefined, 'incorrect')).toBe(false);
  });
});

describe('summarizeEnglishProgress', () => {
  const sentences = [
    { ...READING, vocabTags: ['PEOPLE', 'QUESTION WORDS'] },
    { ...WRITING, vocabTags: ['CIVICS', 'PEOPLE'] },
  ];

  function row(
    sentenceId: string,
    kind: 'reading' | 'writing',
    outcome: 'correct' | 'partial' | 'incorrect',
    wer: number,
    isoDay: string,
  ): ProgressAttemptRow {
    return { sentenceId, kind, outcome, wer, answeredAt: new Date(isoDay) };
  }

  it('lists every sentence in the bank, attempted or not', () => {
    const progress = summarizeEnglishProgress(sentences, []);

    expect(progress.sentences).toHaveLength(2);
    expect(progress.sentences.every((s) => s.attempts === 0)).toBe(true);
    expect(progress.sentences.every((s) => s.bestOutcome === null)).toBe(true);
  });

  it('reports best and latest separately', () => {
    // Passed in the past, slipped most recently. One field cannot say both,
    // which is why there are two.
    const progress = summarizeEnglishProgress(sentences, [
      row(READING_ID, 'reading', 'correct', 0, '2026-03-01T00:00:00Z'),
      row(READING_ID, 'reading', 'partial', 0.4, '2026-09-01T00:00:00Z'),
    ]);

    const reading = progress.sentences.find((s) => s.sentenceId === READING_ID)!;
    expect(reading.attempts).toBe(2);
    expect(reading.bestOutcome).toBe('correct');
    expect(reading.lastOutcome).toBe('partial');
    expect(reading.lastWer).toBe(0.4);
    expect(reading.lastAnsweredAt).toBe('2026-09-01T00:00:00.000Z');
  });

  it('rolls up per vocabulary tag, counting a sentence toward every tag it carries', () => {
    const progress = summarizeEnglishProgress(sentences, [
      row(READING_ID, 'reading', 'correct', 0, '2026-09-01T00:00:00Z'),
      row(WRITING_ID, 'writing', 'incorrect', 1, '2026-09-02T00:00:00Z'),
    ]);

    const byTag = new Map(progress.vocabTags.map((t) => [t.tag, t]));

    // PEOPLE is on both sentences: two total, both attempted, one passed.
    expect(byTag.get('PEOPLE')).toEqual({
      tag: 'PEOPLE',
      sentencesTotal: 2,
      sentencesAttempted: 2,
      sentencesPassed: 1,
      attempts: 2,
    });
    // CIVICS is only on the writing sentence, which was missed.
    expect(byTag.get('CIVICS')).toEqual({
      tag: 'CIVICS',
      sentencesTotal: 1,
      sentencesAttempted: 1,
      sentencesPassed: 0,
      attempts: 1,
    });
    // Alphabetical, so a client never has to sort.
    expect(progress.vocabTags.map((t) => t.tag)).toEqual([
      'CIVICS',
      'PEOPLE',
      'QUESTION WORDS',
    ]);
  });

  it('reports both kinds always, with a null averageWer when there are no attempts', () => {
    const progress = summarizeEnglishProgress(sentences, [
      row(READING_ID, 'reading', 'partial', 0.5, '2026-09-01T00:00:00Z'),
      row(READING_ID, 'reading', 'correct', 0.1, '2026-09-02T00:00:00Z'),
    ]);

    const byKind = new Map(progress.byKind.map((k) => [k.kind, k]));

    expect(byKind.get('reading')).toEqual(
      expect.objectContaining({
        kind: 'reading',
        sentencesTotal: 1,
        sentencesAttempted: 1,
        sentencesPassed: 1,
        attempts: 2,
        version: 'v1',
      }),
    );
    expect(byKind.get('reading')!.averageWer).toBeCloseTo(0.3, 10);
    // `null`, never `0` — a mean of zero is a perfect record, the exact
    // opposite of no record.
    expect(byKind.get('writing')?.averageWer).toBeNull();
    expect(byKind.get('writing')?.attempts).toBe(0);
  });

  it('drops attempts against a superseded revision rather than over-counting the bank', () => {
    const superseded = [
      { ...READING, id: READING_ID, version: 'v1' },
      { ...READING, id: 'aaaaaaa9-9999-4999-8999-999999999999', version: 'v2' },
    ];

    const progress = summarizeEnglishProgress(superseded, [
      row(READING_ID, 'reading', 'correct', 0, '2026-09-01T00:00:00Z'),
    ]);

    // Only v2 is the bank now, so `sentencesAttempted` can never exceed
    // `sentencesTotal`.
    expect(progress.sentences).toHaveLength(1);
    expect(progress.byKind[0]).toEqual(
      expect.objectContaining({
        sentencesTotal: 1,
        sentencesAttempted: 0,
        attempts: 0,
        version: 'v2',
      }),
    );
  });
});
