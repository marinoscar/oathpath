import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { AiDispatchService } from '../ai/ai-dispatch.service';
import { Clock } from '../common/clock/clock';
import { PrismaService } from '../prisma/prisma.service';
import { ReadinessService } from './readiness.service';

// =============================================================================
// ReadinessService — tests (issue #134, epic #55 / E6; issue #141, epic #59 /
// E10)
// =============================================================================
//
// The Progress Guide's own decisions, not the plumbing `readiness-engine
// .spec.ts` and the E6 integration suite already cover: the three
// `AiDispatchService.run` outcomes and what each one does — and does not do —
// to a `readiness_snapshots` row. Mocked the same way `practice.service
// .spec.ts` mocks `AiDispatchService` for the grading ladder's second rung: a
// small hand-built double, not `jest-mock-extended`.
// =============================================================================

const USER_A = '11111111-1111-4111-8111-111111111111';
const SNAPSHOT_ID = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-06-01T12:00:00Z');

/** A `readiness_snapshots` row, exactly as `ensureNarrative` reads/writes it. */
function snapshotRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SNAPSHOT_ID,
    userId: USER_A,
    computedAt: NOW,
    score: 59,
    stage: 'practicing',
    components: {
      coverage: { value: 0.55, weight: 0.15, contribution: 0.0825 },
      recall: { value: 0.95, weight: 0.2, contribution: 0.19 },
      retention: { value: 0.436364, weight: 0.2, contribution: 0.0872727 },
      consistency: { value: 1.0, weight: 0.1, contribution: 0.1 },
      remediation: { value: 0.8, weight: 0.1, contribution: 0.08 },
      english: { value: 0, weight: 0.05, contribution: 0 },
      spoken: { value: 0, weight: 0.1, contribution: 0 },
      interview: { value: 0.5, weight: 0.1, contribution: 0.05 },
    },
    evidenceCounts: {
      coverage: { distinctQuestionsAttempted: 55, totalQuestionsInVersion: 100 },
      recall: { qualifyingAttempts: 20, correctCount: 19, partialCount: 0, incorrectCount: 1, skippedCount: 0 },
      retention: { masteredCount: 12, reviewCount: 20, totalAttemptedQuestions: 55 },
      consistency: { distinctPracticeDaysInLast14: 7 },
      remediation: { everWeakCount: 5, remediatedCount: 4 },
      english: { readingSentences: 0, writingSentences: 0, readingCredit: 0, writingCredit: 0 },
      spoken: { attempts: 0 },
      interview: { attempts: 1 },
    },
    capReason: null,
    topRecommendation: { componentKey: 'retention', title: 't', reason: 'r', path: '/practice' },
    narrative: null,
    narrativeGeneratedAt: null,
    createdAt: NOW,
    ...overrides,
  };
}

describe('ReadinessService', () => {
  let service: ReadinessService;
  let prisma: any;
  let clock: { now: jest.Mock; calendarDateIn: jest.Mock };
  let dispatch: { run: jest.Mock };

  beforeEach(async () => {
    prisma = {
      readinessSnapshot: {
        update: jest.fn(),
      },
      englishAttempt: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };

    clock = {
      now: jest.fn().mockReturnValue(NOW),
      calendarDateIn: jest.fn(),
    };

    dispatch = {
      run: jest.fn(),
    };

    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReadinessService,
        { provide: PrismaService, useValue: prisma },
        { provide: Clock, useValue: clock },
        { provide: AiDispatchService, useValue: dispatch },
      ],
    }).compile();

    service = module.get(ReadinessService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Already has a narrative — a pure no-op, no AI call at all
  // ---------------------------------------------------------------------------

  it('does not call the dispatcher at all when the snapshot already has a narrative', async () => {
    const snapshot = snapshotRow({
      narrative: 'Already generated.',
      narrativeGeneratedAt: NOW,
    });

    const result = await service.ensureNarrative(snapshot as any);

    expect(result).toBe(snapshot);
    expect(dispatch.run).not.toHaveBeenCalled();
    expect(prisma.readinessSnapshot.update).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // 'ok' — writes narrative + narrativeGeneratedAt back onto the row
  // ---------------------------------------------------------------------------

  describe('when the dispatcher returns ok', () => {
    it('writes narrative and narrativeGeneratedAt (Clock.now()), and returns the updated row', async () => {
      const snapshot = snapshotRow();
      dispatch.run.mockResolvedValue({
        status: 'ok',
        text: 'You are making steady progress on recall.',
        usage: { promptTokens: 100, completionTokens: 40, totalTokens: 140 },
        usageEventId: 'usage-1',
        modelId: 'gpt-test',
      });
      const updated = {
        ...snapshot,
        narrative: 'You are making steady progress on recall.',
        narrativeGeneratedAt: NOW,
      };
      prisma.readinessSnapshot.update.mockResolvedValue(updated);

      const result = await service.ensureNarrative(snapshot as any);

      // Called on the SNAPSHOT'S OWN userId, on the `tutor` role.
      expect(dispatch.run).toHaveBeenCalledWith(
        USER_A,
        'tutor',
        expect.objectContaining({ messages: expect.any(Array), maxTokens: expect.any(Number) }),
      );

      expect(prisma.readinessSnapshot.update).toHaveBeenCalledWith({
        where: { id: SNAPSHOT_ID },
        data: {
          narrative: 'You are making steady progress on recall.',
          narrativeGeneratedAt: NOW,
        },
      });

      expect(result).toBe(updated);
    });
  });

  // ---------------------------------------------------------------------------
  // 'unavailable' — leaves the snapshot unchanged, no error logged
  // ---------------------------------------------------------------------------

  describe('when the dispatcher returns unavailable', () => {
    it('leaves the snapshot unchanged, with no error/warn logged', async () => {
      const snapshot = snapshotRow();
      dispatch.run.mockResolvedValue({ status: 'unavailable', cause: 'no_user_key' });

      const result = await service.ensureNarrative(snapshot as any);

      expect(result).toBe(snapshot);
      expect(result.narrative).toBeNull();
      expect(prisma.readinessSnapshot.update).not.toHaveBeenCalled();
      // `unavailable` is an expected, common state — never logged as a
      // warning or an error (§9; unlike `failed`, below).
      expect(Logger.prototype.warn).not.toHaveBeenCalled();
      expect(Logger.prototype.error).not.toHaveBeenCalled();
    });

    it.each(['ai_disabled', 'role_unbound', 'capability_unsupported', 'no_user_key'] as const)(
      'leaves the snapshot unchanged for cause %s',
      async (cause) => {
        const snapshot = snapshotRow();
        dispatch.run.mockResolvedValue({ status: 'unavailable', cause });

        const result = await service.ensureNarrative(snapshot as any);

        expect(result.narrative).toBeNull();
        expect(prisma.readinessSnapshot.update).not.toHaveBeenCalled();
      },
    );
  });

  // ---------------------------------------------------------------------------
  // 'failed' — leaves the snapshot unchanged, but logs a warning with the code
  // ---------------------------------------------------------------------------

  describe('when the dispatcher returns failed', () => {
    it('leaves the snapshot unchanged and logs a warning naming the errorCode', async () => {
      const snapshot = snapshotRow();
      dispatch.run.mockResolvedValue({
        status: 'failed',
        errorCode: 'empty_completion',
        error: 'The model returned no content.',
        usageEventId: null,
        modelId: 'gpt-test',
      });

      const result = await service.ensureNarrative(snapshot as any);

      expect(result).toBe(snapshot);
      expect(result.narrative).toBeNull();
      expect(prisma.readinessSnapshot.update).not.toHaveBeenCalled();
      expect(Logger.prototype.warn).toHaveBeenCalledWith(
        expect.objectContaining({ errorCode: 'empty_completion' }),
        expect.any(String),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Defensive: an unexpected throw from the dispatch plumbing never escapes
  // ---------------------------------------------------------------------------

  describe('when the dispatcher throws unexpectedly', () => {
    it('never throws itself — returns the snapshot unchanged and logs a warning', async () => {
      const snapshot = snapshotRow();
      dispatch.run.mockRejectedValue(new Error('boom'));

      const result = await service.ensureNarrative(snapshot as any);

      expect(result).toBe(snapshot);
      expect(result.narrative).toBeNull();
      expect(prisma.readinessSnapshot.update).not.toHaveBeenCalled();
      expect(Logger.prototype.warn).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // english evidence: the window and the best-of reduction (issue #141,
  // epic #59 / E10 — `docs/specs/english-test.md` §6.1-§6.2)
  // ---------------------------------------------------------------------------
  //
  // The half of the `english` component that is NOT in the pure engine. The
  // engine owns the credit table and the two denominators (covered without a
  // database in `readiness-engine.spec.ts`); this owns the 30-day boundary and
  // the "one entry per distinct sentence, at its best in-window outcome" rule,
  // and both halves have to be right for the component to be.

  describe('english evidence assembly', () => {
    const SENTENCE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const SENTENCE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

    /** The private assembler, reached the way a unit test reaches one. */
    function collect(): Promise<Array<{ kind: string; outcome: string }>> {
      return (service as any).collectEnglishBestOutcomesInWindow(USER_A);
    }

    it('bounds the query at 30 days before the injected clock, never a wall-clock read', async () => {
      await collect();

      expect(clock.now).toHaveBeenCalled();
      const where = prisma.englishAttempt.findMany.mock.calls[0][0].where;
      expect(where.userId).toBe(USER_A);
      expect(where.answeredAt.gte).toEqual(new Date('2026-05-02T12:00:00Z'));
    });

    it('uses only positive filters — no negative filter on any column', async () => {
      await collect();

      // `english_attempts.asrConfidence` is the table's one nullable column,
      // and a `{ not: ... }` on a nullable column silently drops every null
      // row (SQL's `NULL <> x` is UNKNOWN). This query neither selects nor
      // filters on it, and every clause it does carry is a positive one — the
      // structural reason the trap cannot be sprung here.
      const serialized = JSON.stringify(prisma.englishAttempt.findMany.mock.calls[0][0]);
      expect(serialized).not.toContain('not');
      expect(serialized).not.toContain('asrConfidence');
    });

    it('credits a sentence once, at its best in-window outcome', async () => {
      // §6.2's own worked case: twice incorrect and once correct counts ONCE,
      // as correct — a learner is neither inflated by re-attempting a sentence
      // they already passed, nor held down by the misses that preceded it.
      prisma.englishAttempt.findMany.mockResolvedValue([
        { sentenceId: SENTENCE_A, kind: 'reading', outcome: 'incorrect' },
        { sentenceId: SENTENCE_A, kind: 'reading', outcome: 'correct' },
        { sentenceId: SENTENCE_A, kind: 'reading', outcome: 'incorrect' },
      ]);

      await expect(collect()).resolves.toEqual([{ kind: 'reading', outcome: 'correct' }]);
    });

    it('ranks correct over partial over incorrect regardless of arrival order', async () => {
      prisma.englishAttempt.findMany.mockResolvedValue([
        { sentenceId: SENTENCE_A, kind: 'writing', outcome: 'correct' },
        { sentenceId: SENTENCE_A, kind: 'writing', outcome: 'partial' },
        { sentenceId: SENTENCE_B, kind: 'writing', outcome: 'incorrect' },
        { sentenceId: SENTENCE_B, kind: 'writing', outcome: 'partial' },
      ]);

      await expect(collect()).resolves.toEqual([
        { kind: 'writing', outcome: 'correct' },
        { kind: 'writing', outcome: 'partial' },
      ]);
    });

    it('keeps the two segments apart', async () => {
      prisma.englishAttempt.findMany.mockResolvedValue([
        { sentenceId: SENTENCE_A, kind: 'reading', outcome: 'correct' },
        { sentenceId: SENTENCE_B, kind: 'writing', outcome: 'partial' },
      ]);

      await expect(collect()).resolves.toEqual([
        { kind: 'reading', outcome: 'correct' },
        { kind: 'writing', outcome: 'partial' },
      ]);
    });

    it('is an empty array, never a null or a thrown error, with no rows at all', async () => {
      prisma.englishAttempt.findMany.mockResolvedValue([]);
      await expect(collect()).resolves.toEqual([]);
    });
  });
});
