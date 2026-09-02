import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { Clock } from '../common/clock/clock';
import { US_STATE_AND_TERRITORY_CODES } from '../common/constants/us-states.constants';
import { PrismaService } from '../prisma/prisma.service';
import { CivicsAdminService } from './civics-admin.service';

// =============================================================================
// CivicsAdminService — tests (issue #117, epic #51)
// =============================================================================
//
// The decisions civics-content.md §4 and §9 fix, not the plumbing:
//
//   * a correction CLOSES the open row and OPENS a new one — never an edit,
//     and never a slot the open row was not already in;
//   * both writes and the audit row happen inside ONE transaction, proved by
//     handing the callback a `tx` that is a different object from `prisma`;
//   * a `none`-scope question is rejected and NOTHING is written;
//   * `verifiedAt` and the `effectiveFrom` fallback come from the INJECTED
//     clock, so a spec can pin them instead of asserting against wall time;
//   * the audit row records the old and the new text in full, because a civics
//     answer is public exam content (the contrast with `journey:profile_update`).
//
// Prisma is mocked throughout — no test in this repository touches a database
// (docs/TESTING.md).
// =============================================================================

const ADMIN = '11111111-1111-4111-8111-111111111111';

const Q_SPEAKER = 'a1111111-1111-4111-8111-111111111111';
const Q_GOVERNOR = 'a2222222-2222-4222-8222-222222222222';
const Q_BRANCH = 'a3333333-3333-4333-8333-333333333333';
const CATEGORY_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const NOW = new Date('2027-06-01T12:00:00Z');

function questionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: Q_SPEAKER,
    testVersionCode: 'v2008',
    number: 47,
    prompt: 'What is the name of the Speaker of the House of Representatives now?',
    categoryId: CATEGORY_ID,
    dynamicScope: 'national',
    ...overrides,
  };
}

function answerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    questionId: Q_SPEAKER,
    text: 'Jane Q. Doe',
    sort: 0,
    stateCode: null,
    verifiedAt: new Date('2026-01-15T00:00:00Z'),
    effectiveFrom: new Date('2023-01-07T00:00:00Z'),
    effectiveTo: null,
    sourceNote: 'history.house.gov, retrieved 2026-01-15',
    createdAt: new Date('2026-01-15T00:00:00Z'),
    updatedAt: new Date('2026-01-15T00:00:00Z'),
    ...overrides,
  };
}

const CORRECTION = {
  questionId: Q_SPEAKER,
  text: 'John R. Roe',
  sourceNote: 'history.house.gov, retrieved 2027-01-04',
  effectiveFrom: '2027-01-03',
};

describe('CivicsAdminService', () => {
  let service: CivicsAdminService;
  let prisma: any;
  /** The transaction client. A DIFFERENT object from `prisma`, deliberately. */
  let tx: any;
  let clock: { now: jest.Mock; calendarDateIn: jest.Mock };

  beforeEach(async () => {
    tx = {
      civicsAnswer: {
        findFirst: jest.fn().mockResolvedValue(answerRow()),
        update: jest
          .fn()
          .mockImplementation(async ({ where, data }: any) => ({
            ...answerRow({ id: where.id }),
            ...data,
          })),
        create: jest
          .fn()
          .mockImplementation(async ({ data }: any) => ({
            id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            createdAt: NOW,
            updatedAt: NOW,
            ...data,
          })),
      },
      auditEvent: { create: jest.fn().mockResolvedValue({}) },
    };

    prisma = {
      civicsQuestion: {
        findMany: jest.fn().mockResolvedValue([questionRow()]),
        findUnique: jest.fn().mockResolvedValue(questionRow()),
        count: jest.fn().mockResolvedValue(1),
      },
      civicsAnswer: { findMany: jest.fn().mockResolvedValue([answerRow()]) },
      auditEvent: { create: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn().mockImplementation(async (cb: any) => cb(tx)),
    };

    clock = {
      now: jest.fn().mockReturnValue(NOW),
      calendarDateIn: jest.fn().mockReturnValue('2027-06-01'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CivicsAdminService,
        { provide: PrismaService, useValue: prisma },
        { provide: Clock, useValue: clock },
      ],
    }).compile();

    service = module.get(CivicsAdminService);
  });

  const query = { page: 1, pageSize: 20 } as const;

  // ---------------------------------------------------------------------------
  // GET
  // ---------------------------------------------------------------------------

  describe('listDynamicAnswers', () => {
    it('asks only for national and state questions, never for static ones', async () => {
      // The filter is on the QUERY, not applied to the results, so `total`
      // counts what this surface administers and a page is never short.
      await service.listDynamicAnswers({ ...query });

      expect(prisma.civicsQuestion.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { dynamicScope: { in: ['national', 'state'] } },
        }),
      );
      expect(prisma.civicsQuestion.count).toHaveBeenCalledWith({
        where: { dynamicScope: { in: ['national', 'state'] } },
      });
    });

    it('narrows to one scope when the caller asks for one', async () => {
      await service.listDynamicAnswers({ ...query, dynamicScope: 'state' });

      expect(prisma.civicsQuestion.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { dynamicScope: 'state' } }),
      );
    });

    it('lists the OPEN row rather than the row a learner is served right now', async () => {
      // Open is `effective_to IS NULL` — the row a correction will close. That
      // is not the clock-relative predicate the learner-facing read uses, and
      // the difference is real: a correction entered ahead of time opens a row
      // that is not yet current.
      await service.listDynamicAnswers({ ...query });

      expect(prisma.civicsAnswer.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ effectiveTo: null }),
        }),
      );
    });

    it('serves both effective dates, because the lifecycle is expressed in them', async () => {
      const result = await service.listDynamicAnswers({ ...query });

      expect(result.items[0].answers[0]).toMatchObject({
        text: 'Jane Q. Doe',
        effectiveFrom: '2023-01-07T00:00:00.000Z',
        effectiveTo: null,
        verifiedAt: '2026-01-15T00:00:00.000Z',
        sourceNote: 'history.house.gov, retrieved 2026-01-15',
      });
    });

    it('reports no missing states for a national question', async () => {
      const result = await service.listDynamicAnswers({ ...query });

      expect(result.items[0].missingStateCodes).toEqual([]);
    });

    it('names every state with no open answer, so an unanswerable question is visible', async () => {
      // A learner in a state with no row sees a question nobody can answer and
      // has no way to report it. This list is how the admin finds out first.
      prisma.civicsQuestion.findMany.mockResolvedValue([
        questionRow({ id: Q_GOVERNOR, dynamicScope: 'state', number: 43 }),
      ]);
      prisma.civicsAnswer.findMany.mockResolvedValue([
        answerRow({ questionId: Q_GOVERNOR, stateCode: 'TX', text: 'The Governor of Texas' }),
        answerRow({ questionId: Q_GOVERNOR, stateCode: 'OH', text: 'The Governor of Ohio' }),
      ]);

      const result = await service.listDynamicAnswers({ ...query });

      expect(result.items[0].missingStateCodes).toHaveLength(
        US_STATE_AND_TERRITORY_CODES.length - 2,
      );
      expect(result.items[0].missingStateCodes).toContain('WY');
      expect(result.items[0].missingStateCodes).not.toContain('TX');
    });

    it('narrows a state question’s answers, and its gap list, to the requested state', async () => {
      prisma.civicsQuestion.findMany.mockResolvedValue([
        questionRow({ id: Q_GOVERNOR, dynamicScope: 'state', number: 43 }),
      ]);
      prisma.civicsAnswer.findMany.mockResolvedValue([
        answerRow({ questionId: Q_GOVERNOR, stateCode: 'TX', text: 'The Governor of Texas' }),
      ]);

      const result = await service.listDynamicAnswers({ ...query, stateCode: 'TX' });

      expect(result.items[0].answers).toHaveLength(1);
      expect(result.items[0].answers[0].stateCode).toBe('TX');
      expect(result.items[0].missingStateCodes).toEqual([]);
    });

    it('keeps a national question’s answer when a state filter is applied', async () => {
      // A national answer carries `state_code: NULL`; dropping it under a state
      // filter would make the page look broken for a fact that does not vary by
      // state at all.
      const result = await service.listDynamicAnswers({ ...query, stateCode: 'TX' });

      expect(prisma.civicsAnswer.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: [{ stateCode: 'TX' }, { stateCode: null }],
          }),
        }),
      );
      expect(result.items[0].answers).toHaveLength(1);
      expect(result.items[0].answers[0].stateCode).toBeNull();
    });

    it('does not query answers at all when the page is empty', async () => {
      prisma.civicsQuestion.findMany.mockResolvedValue([]);
      prisma.civicsQuestion.count.mockResolvedValue(0);

      const result = await service.listDynamicAnswers({ ...query, page: 9 });

      expect(prisma.civicsAnswer.findMany).not.toHaveBeenCalled();
      expect(result.items).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // PUT — the lifecycle
  // ---------------------------------------------------------------------------

  describe('updateDynamicAnswer', () => {
    it('closes the open row at the correction’s effectiveFrom and opens a new one', async () => {
      // civics-content.md §4.1: the two rows meet exactly at the real-world
      // instant of the change — no gap, no overlap.
      const result = await service.updateDynamicAnswer(ADMIN, { ...CORRECTION });

      expect(tx.civicsAnswer.update).toHaveBeenCalledWith({
        where: { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
        data: { effectiveTo: new Date('2027-01-03T00:00:00.000Z') },
      });
      expect(tx.civicsAnswer.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          questionId: Q_SPEAKER,
          text: 'John R. Roe',
          stateCode: null,
          effectiveFrom: new Date('2027-01-03T00:00:00.000Z'),
          effectiveTo: null,
          sourceNote: 'history.house.gov, retrieved 2027-01-04',
        }),
      });
      expect(result.previous?.text).toBe('Jane Q. Doe');
      expect(result.previous?.effectiveTo).toBe('2027-01-03T00:00:00.000Z');
      expect(result.current.text).toBe('John R. Roe');
      expect(result.current.effectiveTo).toBeNull();
    });

    it('never edits the existing row’s text', async () => {
      // The single most important property of the whole surface: a row a
      // learner may already have been graded against keeps its own text.
      await service.updateDynamicAnswer(ADMIN, { ...CORRECTION });

      expect(tx.civicsAnswer.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { effectiveTo: expect.any(Date) } }),
      );
    });

    it('performs the close, the open and the audit inside one transaction', async () => {
      // `tx` is a different object from `prisma`. Anything written through
      // `prisma` here would be a write outside the transaction, which is what
      // a reader observing zero or two open rows would be looking at.
      await service.updateDynamicAnswer(ADMIN, { ...CORRECTION });

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(tx.civicsAnswer.update).toHaveBeenCalledTimes(1);
      expect(tx.civicsAnswer.create).toHaveBeenCalledTimes(1);
      expect(tx.auditEvent.create).toHaveBeenCalledTimes(1);
      expect(prisma.auditEvent.create).not.toHaveBeenCalled();
    });

    it('re-reads the open row inside the transaction rather than trusting an earlier read', async () => {
      await service.updateDynamicAnswer(ADMIN, { ...CORRECTION });

      expect(tx.civicsAnswer.findFirst).toHaveBeenCalledWith({
        where: { questionId: Q_SPEAKER, stateCode: null, effectiveTo: null },
        orderBy: { sort: 'asc' },
      });
    });

    it('writes into the slot the open row already occupies, not slot 0', async () => {
      // §3.3: the database cannot enforce that a dynamic question uses only
      // slot 0, so a mis-loaded row at sort 1 is possible. Writing to slot 0
      // while slot 1 stayed open would create the second simultaneously
      // current answer this design exists to prevent.
      tx.civicsAnswer.findFirst.mockResolvedValue(answerRow({ sort: 1 }));

      await service.updateDynamicAnswer(ADMIN, { ...CORRECTION });

      expect(tx.civicsAnswer.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ sort: 1 }),
      });
    });

    it('opens at slot 0 with a null previous when the slot has never had an answer', async () => {
      tx.civicsAnswer.findFirst.mockResolvedValue(null);

      const result = await service.updateDynamicAnswer(ADMIN, { ...CORRECTION });

      expect(tx.civicsAnswer.update).not.toHaveBeenCalled();
      expect(tx.civicsAnswer.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ sort: 0 }),
      });
      expect(result.previous).toBeNull();
    });

    it('writes a state answer under its own state code', async () => {
      prisma.civicsQuestion.findUnique.mockResolvedValue(
        questionRow({ id: Q_GOVERNOR, dynamicScope: 'state', number: 43 }),
      );
      tx.civicsAnswer.findFirst.mockResolvedValue(
        answerRow({ questionId: Q_GOVERNOR, stateCode: 'TX' }),
      );

      const result = await service.updateDynamicAnswer(ADMIN, {
        ...CORRECTION,
        questionId: Q_GOVERNOR,
        stateCode: 'TX',
      });

      expect(tx.civicsAnswer.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ stateCode: 'TX' }),
        }),
      );
      expect(tx.civicsAnswer.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ stateCode: 'TX' }),
      });
      expect(result.stateCode).toBe('TX');
    });
  });

  // ---------------------------------------------------------------------------
  // PUT — the clock
  // ---------------------------------------------------------------------------

  describe('the clock', () => {
    it('stamps verifiedAt from the injected clock, never from the caller', async () => {
      // `verifiedAt` records that a HUMAN confirmed this text, and the human is
      // the caller, now. A client-supplied value would let the freshness a
      // learner reads be asserted rather than earned.
      await service.updateDynamicAnswer(ADMIN, { ...CORRECTION });

      expect(clock.now).toHaveBeenCalled();
      expect(tx.civicsAnswer.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ verifiedAt: NOW }),
      });
    });

    it('falls back to the clock when no real-world date is known', async () => {
      const { effectiveFrom: _omitted, ...withoutDate } = CORRECTION;

      await service.updateDynamicAnswer(ADMIN, withoutDate);

      expect(tx.civicsAnswer.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ effectiveFrom: NOW }),
      });
      expect(tx.civicsAnswer.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { effectiveTo: NOW } }),
      );
    });

    it('accepts a full ISO timestamp as well as a calendar date', async () => {
      await service.updateDynamicAnswer(ADMIN, {
        ...CORRECTION,
        effectiveFrom: '2027-01-03T17:04:00Z',
      });

      expect(tx.civicsAnswer.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          effectiveFrom: new Date('2027-01-03T17:04:00.000Z'),
        }),
      });
    });
  });

  // ---------------------------------------------------------------------------
  // PUT — what is refused
  // ---------------------------------------------------------------------------

  describe('refusals', () => {
    it('rejects a static (none-scope) question and writes nothing', async () => {
      // civics-content.md §9: allowing it would be a second, weaker-reviewed
      // path into the same rows, skipping #101's structural validation and the
      // human review a content PR carries.
      prisma.civicsQuestion.findUnique.mockResolvedValue(
        questionRow({ id: Q_BRANCH, dynamicScope: 'none', number: 13 }),
      );

      await expect(
        service.updateDynamicAnswer(ADMIN, { ...CORRECTION, questionId: Q_BRANCH }),
      ).rejects.toThrow(BadRequestException);

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(tx.civicsAnswer.create).not.toHaveBeenCalled();
      expect(tx.auditEvent.create).not.toHaveBeenCalled();
    });

    it('says in the rejection which path a static answer does change through', async () => {
      prisma.civicsQuestion.findUnique.mockResolvedValue(
        questionRow({ dynamicScope: 'none' }),
      );

      await expect(
        service.updateDynamicAnswer(ADMIN, { ...CORRECTION }),
      ).rejects.toThrow(/reviewed content change/i);
    });

    it('rejects an unknown question as 404 rather than creating an orphan answer', async () => {
      prisma.civicsQuestion.findUnique.mockResolvedValue(null);

      await expect(
        service.updateDynamicAnswer(ADMIN, { ...CORRECTION }),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects a stateCode on a national answer instead of ignoring it', async () => {
      // Ignoring it would let an admin believe they had corrected one state's
      // copy of a national fact.
      await expect(
        service.updateDynamicAnswer(ADMIN, { ...CORRECTION, stateCode: 'TX' }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects a state answer with no stateCode rather than guessing one', async () => {
      prisma.civicsQuestion.findUnique.mockResolvedValue(
        questionRow({ id: Q_GOVERNOR, dynamicScope: 'state' }),
      );

      await expect(
        service.updateDynamicAnswer(ADMIN, { ...CORRECTION, questionId: Q_GOVERNOR }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects an effectiveFrom earlier than the answer it replaces', async () => {
      // It would close the previous row before it opened, and E3 could no
      // longer say which answer applied on a given date.
      await expect(
        service.updateDynamicAnswer(ADMIN, {
          ...CORRECTION,
          effectiveFrom: '2020-01-01',
        }),
      ).rejects.toThrow(BadRequestException);

      expect(tx.civicsAnswer.update).not.toHaveBeenCalled();
      expect(tx.civicsAnswer.create).not.toHaveBeenCalled();
      expect(tx.auditEvent.create).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // PUT — the audit row
  // ---------------------------------------------------------------------------

  describe('the audit row', () => {
    it('records the action, the actor, and the QUESTION as the target', async () => {
      // The question, not the answer row: every correction creates a new answer
      // id, so filing under it would give each audit row a target that appears
      // exactly once and `[targetType, targetId]` could never answer "show me
      // every change to this answer".
      await service.updateDynamicAnswer(ADMIN, { ...CORRECTION });

      expect(tx.auditEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          actorUserId: ADMIN,
          action: 'civics:dynamic_answer_update',
          targetType: 'civics_question',
          targetId: Q_SPEAKER,
        }),
      });
    });

    it('records the old AND the new text in full, unlike journey:profile_update', async () => {
      // A learner's profile is private, so its audit redacts values. A civics
      // answer is public exam content shown to every learner, so the diff
      // itself is what a reviewer needs (civics-content.md §9).
      await service.updateDynamicAnswer(ADMIN, { ...CORRECTION });

      const { meta } = tx.auditEvent.create.mock.calls[0][0].data;

      expect(meta).toMatchObject({
        questionId: Q_SPEAKER,
        testVersionCode: 'v2008',
        questionNumber: 47,
        dynamicScope: 'national',
        stateCode: null,
        previousAnswerId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        previousText: 'Jane Q. Doe',
        previousSourceNote: 'history.house.gov, retrieved 2026-01-15',
        newText: 'John R. Roe',
        newSourceNote: 'history.house.gov, retrieved 2027-01-04',
        effectiveFrom: '2027-01-03T00:00:00.000Z',
        verifiedAt: NOW.toISOString(),
      });
    });

    it('records whether the effective date was sourced or stood in for by the clock', async () => {
      // Without this an auditor cannot tell a cited real-world date from
      // "whenever the button was pressed".
      const { effectiveFrom: _omitted, ...withoutDate } = CORRECTION;

      await service.updateDynamicAnswer(ADMIN, withoutDate);
      expect(tx.auditEvent.create.mock.calls[0][0].data.meta).toMatchObject({
        effectiveFromSource: 'clock',
      });

      tx.auditEvent.create.mockClear();
      await service.updateDynamicAnswer(ADMIN, { ...CORRECTION });
      expect(tx.auditEvent.create.mock.calls[0][0].data.meta).toMatchObject({
        effectiveFromSource: 'submitted',
      });
    });

    it('records a null previous when the slot had no answer to close', async () => {
      tx.civicsAnswer.findFirst.mockResolvedValue(null);

      await service.updateDynamicAnswer(ADMIN, { ...CORRECTION });

      expect(tx.auditEvent.create.mock.calls[0][0].data.meta).toMatchObject({
        previousAnswerId: null,
        previousText: null,
      });
    });
  });
});
