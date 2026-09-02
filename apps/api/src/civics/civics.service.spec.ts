import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { Clock } from '../common/clock/clock';
import { PrismaService } from '../prisma/prisma.service';
import { CivicsService } from './civics.service';

// =============================================================================
// CivicsService — tests (issue #111, epic #51)
// =============================================================================
//
// The decisions, not the plumbing:
//
//   * the version filter falls back to the CALLER'S OWN profile, and a caller
//     with no resolved version is not silently pinned to one;
//   * a `state`-scope question resolves against the caller's state, and a
//     different learner in a different state gets a different answer;
//   * no state set is an explicit `state_required`, never a guess;
//   * the "is this current" boundary is asked of the INJECTED CLOCK;
//   * an unknown version or question is a 404, not an empty success.
//
// Prisma is mocked throughout — no test in this repository touches a database
// (docs/TESTING.md).
// =============================================================================

const TEXAN = '11111111-1111-4111-8111-111111111111';
const OHIOAN = '22222222-2222-4222-8222-222222222222';
const NOMAD = '33333333-3333-4333-8333-333333333333';

const QUESTION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CATEGORY_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const NOW = new Date('2026-06-01T12:00:00Z');

const CATEGORY = {
  id: CATEGORY_ID,
  testVersionCode: 'v2008',
  section: 'AMERICAN GOVERNMENT',
  code: 'system_of_government',
  name: 'System of Government',
  sortOrder: 2,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

function question(overrides: Record<string, unknown> = {}) {
  return {
    id: QUESTION_ID,
    testVersionCode: 'v2008',
    number: 43,
    categoryId: CATEGORY_ID,
    prompt: 'Who is the Governor of your state now?',
    seniorEligible: true,
    dynamicScope: 'state',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    category: CATEGORY,
    ...overrides,
  };
}

function answerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    questionId: QUESTION_ID,
    text: 'Answers will vary',
    sort: 0,
    stateCode: null,
    verifiedAt: new Date('2026-05-01T00:00:00Z'),
    effectiveFrom: new Date('2023-01-07T00:00:00Z'),
    effectiveTo: null,
    sourceNote: 'usa.gov, retrieved 2026-05-01',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

/** The profiles this suite's three learners have. */
const PROFILES: Record<string, { stateCode: string | null; testVersionCode: string | null }> = {
  [TEXAN]: { stateCode: 'TX', testVersionCode: 'v2008' },
  [OHIOAN]: { stateCode: 'OH', testVersionCode: 'v2008' },
  [NOMAD]: { stateCode: null, testVersionCode: null },
};

describe('CivicsService', () => {
  let service: CivicsService;
  let prisma: {
    learnerProfile: { findUnique: jest.Mock };
    civicsTestVersion: { findMany: jest.Mock; findUnique: jest.Mock };
    civicsCategory: { findMany: jest.Mock };
    civicsQuestion: { findMany: jest.Mock; findUnique: jest.Mock; count: jest.Mock };
    civicsAnswer: { findMany: jest.Mock };
  };
  let clock: { now: jest.Mock; calendarDateIn: jest.Mock };

  beforeEach(async () => {
    prisma = {
      learnerProfile: {
        findUnique: jest
          .fn()
          .mockImplementation(async ({ where }: any) => PROFILES[where.userId] ?? null),
      },
      civicsTestVersion: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue({ code: 'v2008' }),
      },
      civicsCategory: { findMany: jest.fn().mockResolvedValue([CATEGORY]) },
      civicsQuestion: {
        findMany: jest.fn().mockResolvedValue([question()]),
        findUnique: jest.fn().mockResolvedValue(question()),
        count: jest.fn().mockResolvedValue(1),
      },
      civicsAnswer: { findMany: jest.fn().mockResolvedValue([]) },
    };
    clock = {
      now: jest.fn().mockReturnValue(NOW),
      calendarDateIn: jest.fn().mockReturnValue('2026-06-01'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CivicsService,
        { provide: PrismaService, useValue: prisma },
        { provide: Clock, useValue: clock },
      ],
    }).compile();

    service = module.get(CivicsService);
  });

  // ---------------------------------------------------------------------------
  // Versions and categories
  // ---------------------------------------------------------------------------

  describe('listVersions', () => {
    it('serves contentHash so a deploy can be confirmed to have applied its content', () => {
      prisma.civicsTestVersion.findMany.mockResolvedValue([
        {
          code: 'v2008',
          label: '2008 Civics Test',
          questionsAsked: 10,
          passThreshold: 6,
          seniorQuestionsAsked: 10,
          seniorPassThreshold: 6,
          contentHash: 'sha256:abc',
          createdAt: NOW,
          updatedAt: NOW,
        },
      ]);

      return expect(service.listVersions()).resolves.toEqual([
        {
          code: 'v2008',
          label: '2008 Civics Test',
          questionsAsked: 10,
          passThreshold: 6,
          seniorQuestionsAsked: 10,
          seniorPassThreshold: 6,
          contentHash: 'sha256:abc',
        },
      ]);
    });
  });

  describe('listCategories', () => {
    it('reports an unknown version as 404 rather than as an empty list', async () => {
      // "This version does not exist" and "this version has no categories
      // loaded yet" are different facts. An empty array would make a typo in a
      // client indistinguishable from unseeded content.
      prisma.civicsTestVersion.findUnique.mockResolvedValue(null);

      await expect(service.listCategories('v1999')).rejects.toThrow(NotFoundException);
      expect(prisma.civicsCategory.findMany).not.toHaveBeenCalled();
    });

    it('asks for the categories in sortOrder, which is not alphabetical', async () => {
      await service.listCategories('v2008');

      expect(prisma.civicsCategory.findMany).toHaveBeenCalledWith({
        where: { testVersionCode: 'v2008' },
        orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
      });
    });
  });

  // ---------------------------------------------------------------------------
  // The question list
  // ---------------------------------------------------------------------------

  describe('listQuestions', () => {
    const query = { page: 1, pageSize: 20 } as const;

    it('defaults the version filter to the caller’s own resolved test version', async () => {
      await service.listQuestions(TEXAN, { ...query });

      expect(prisma.civicsQuestion.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { testVersionCode: 'v2008' } }),
      );
    });

    it('does not pin a caller who has no resolved version to one', async () => {
      // An un-oriented learner genuinely cannot be narrowed. Picking a version
      // for them would be a claim about which test they are taking that
      // nobody has made yet.
      await service.listQuestions(NOMAD, { ...query });

      expect(prisma.civicsQuestion.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: {} }),
      );
    });

    it('lets an explicit version override the caller’s own', async () => {
      await service.listQuestions(TEXAN, { ...query, testVersionCode: 'v2025' });

      expect(prisma.civicsQuestion.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { testVersionCode: 'v2025' } }),
      );
    });

    it('combines the category and seniorEligible filters with the version', async () => {
      await service.listQuestions(TEXAN, {
        ...query,
        categoryId: CATEGORY_ID,
        seniorEligible: true,
      });

      expect(prisma.civicsQuestion.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            testVersionCode: 'v2008',
            categoryId: CATEGORY_ID,
            seniorEligible: true,
          },
        }),
      );
    });

    it('omits the seniorEligible filter entirely when it was not asked for', async () => {
      // `undefined` in a Prisma `where` is ignored, but an explicit
      // `seniorEligible: false` is NOT — it means "only the ineligible ones".
      // Building the clause conditionally is what keeps those apart.
      await service.listQuestions(TEXAN, { ...query });

      const where = prisma.civicsQuestion.findMany.mock.calls[0][0].where;
      expect('seniorEligible' in where).toBe(false);
    });

    it('honours an explicit seniorEligible: false as a filter, not as "no filter"', async () => {
      await service.listQuestions(TEXAN, { ...query, seniorEligible: false });

      expect(prisma.civicsQuestion.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { testVersionCode: 'v2008', seniorEligible: false },
        }),
      );
    });

    it('translates page and pageSize into skip/take and a totalPages count', async () => {
      prisma.civicsQuestion.count.mockResolvedValue(101);

      const result = await service.listQuestions(TEXAN, { page: 3, pageSize: 20 });

      expect(prisma.civicsQuestion.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 40, take: 20 }),
      );
      expect(result).toMatchObject({ total: 101, page: 3, pageSize: 20, totalPages: 6 });
    });

    it('counts with the same filter it lists with', async () => {
      // A count over a different `where` is how a paginator ends up promising
      // pages that are empty when you reach them.
      await service.listQuestions(TEXAN, { ...query, categoryId: CATEGORY_ID });

      expect(prisma.civicsQuestion.count).toHaveBeenCalledWith({
        where: { testVersionCode: 'v2008', categoryId: CATEGORY_ID },
      });
    });

    it('returns summaries with no answers on them', async () => {
      const result = await service.listQuestions(TEXAN, { ...query });

      expect(result.items[0]).toEqual({
        id: QUESTION_ID,
        number: 43,
        prompt: 'Who is the Governor of your state now?',
        categoryId: CATEGORY_ID,
        testVersionCode: 'v2008',
        seniorEligible: true,
        dynamicScope: 'state',
      });
      expect(prisma.civicsAnswer.findMany).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Resolution — the substantive part
  // ---------------------------------------------------------------------------

  describe('getQuestion', () => {
    it('reports an unknown question id as 404', async () => {
      prisma.civicsQuestion.findUnique.mockResolvedValue(null);

      await expect(service.getQuestion(TEXAN, QUESTION_ID)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('resolves a state-scope question against the caller’s own state', async () => {
      prisma.civicsAnswer.findMany.mockResolvedValue([
        answerRow({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', text: 'Greg Abbott', stateCode: 'TX' }),
      ]);

      const result = await service.getQuestion(TEXAN, QUESTION_ID);

      expect(prisma.civicsAnswer.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ questionId: QUESTION_ID, stateCode: 'TX' }),
        }),
      );
      expect(result.answerResolution).toBe('resolved');
      expect(result.resolvedForStateCode).toBe('TX');
      expect(result.answers.map((a) => a.text)).toEqual(['Greg Abbott']);
    });

    it('gives a learner in a different state a different answer for the same question', async () => {
      // The single most important property of this endpoint: the same question
      // id, two callers, two answers, and neither of them supplied a state.
      prisma.civicsAnswer.findMany.mockImplementation(async ({ where }: any) =>
        where.stateCode === 'TX'
          ? [answerRow({ text: 'Greg Abbott', stateCode: 'TX' })]
          : [answerRow({ text: 'Mike DeWine', stateCode: 'OH' })],
      );

      const texan = await service.getQuestion(TEXAN, QUESTION_ID);
      const ohioan = await service.getQuestion(OHIOAN, QUESTION_ID);

      expect(texan.answers.map((a) => a.text)).toEqual(['Greg Abbott']);
      expect(ohioan.answers.map((a) => a.text)).toEqual(['Mike DeWine']);
      expect(texan.resolvedForStateCode).toBe('TX');
      expect(ohioan.resolvedForStateCode).toBe('OH');
    });

    it('returns state_required — and queries nothing — when the caller has no state', async () => {
      const result = await service.getQuestion(NOMAD, QUESTION_ID);

      expect(result.answerResolution).toBe('state_required');
      expect(result.answers).toEqual([]);
      expect(result.verifiedAt).toBeNull();
      expect(result.resolvedForStateCode).toBeNull();
      // Not queried at all: there is no state to query FOR, and a fallback
      // query would be the guess civics-content.md §5 rejects.
      expect(prisma.civicsAnswer.findMany).not.toHaveBeenCalled();
    });

    it('still returns the question itself when the state is unresolved, never a 404', async () => {
      const result = await service.getQuestion(NOMAD, QUESTION_ID);

      expect(result.number).toBe(43);
      expect(result.prompt).toBe('Who is the Governor of your state now?');
      expect(result.dynamicScope).toBe('state');
    });

    it('ignores the caller’s state for a national-scope question', async () => {
      prisma.civicsQuestion.findUnique.mockResolvedValue(
        question({ dynamicScope: 'national', prompt: 'Who is the President now?' }),
      );
      prisma.civicsAnswer.findMany.mockResolvedValue([answerRow({ text: 'Some President' })]);

      const result = await service.getQuestion(TEXAN, QUESTION_ID);

      expect(prisma.civicsAnswer.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ stateCode: null }) }),
      );
      expect(result.resolvedForStateCode).toBeNull();
      expect(result.answerResolution).toBe('resolved');
    });

    it('resolves a national-scope question for a learner with no state at all', async () => {
      prisma.civicsQuestion.findUnique.mockResolvedValue(
        question({ dynamicScope: 'national' }),
      );
      prisma.civicsAnswer.findMany.mockResolvedValue([answerRow({ text: 'Some President' })]);

      const result = await service.getQuestion(NOMAD, QUESTION_ID);

      expect(result.answerResolution).toBe('resolved');
      expect(result.answers).toHaveLength(1);
    });

    it('returns every simultaneously correct answer for a none-scope question', async () => {
      prisma.civicsQuestion.findUnique.mockResolvedValue(
        question({ dynamicScope: 'none', prompt: 'Name one branch of the government.' }),
      );
      prisma.civicsAnswer.findMany.mockResolvedValue([
        answerRow({ text: 'legislative', sort: 0 }),
        answerRow({ text: 'executive', sort: 1 }),
        answerRow({ text: 'judicial', sort: 2 }),
      ]);

      const result = await service.getQuestion(TEXAN, QUESTION_ID);

      expect(result.answers.map((a) => a.text)).toEqual([
        'legislative',
        'executive',
        'judicial',
      ]);
    });

    // -------------------------------------------------------------------------
    // The clock boundary
    // -------------------------------------------------------------------------

    it('asks the injected Clock for the currency boundary, not the wall clock', async () => {
      prisma.civicsAnswer.findMany.mockResolvedValue([answerRow({ stateCode: 'TX' })]);

      await service.getQuestion(TEXAN, QUESTION_ID);

      expect(clock.now).toHaveBeenCalled();
      expect(prisma.civicsAnswer.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            effectiveFrom: { lte: NOW },
            OR: [{ effectiveTo: null }, { effectiveTo: { gt: NOW } }],
          }),
        }),
      );
    });

    it('moves the boundary when the clock moves, without any other change', async () => {
      const later = new Date('2030-01-01T00:00:00Z');
      clock.now.mockReturnValue(later);
      prisma.civicsAnswer.findMany.mockResolvedValue([answerRow({ stateCode: 'TX' })]);

      await service.getQuestion(TEXAN, QUESTION_ID);

      expect(prisma.civicsAnswer.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            effectiveFrom: { lte: later },
            OR: [{ effectiveTo: null }, { effectiveTo: { gt: later } }],
          }),
        }),
      );
    });

    // -------------------------------------------------------------------------
    // Detail payload
    // -------------------------------------------------------------------------

    it('carries verifiedAt and seniorEligible on the detail', async () => {
      prisma.civicsAnswer.findMany.mockResolvedValue([
        answerRow({ stateCode: 'TX', verifiedAt: new Date('2026-05-20T09:30:00Z') }),
      ]);

      const result = await service.getQuestion(TEXAN, QUESTION_ID);

      expect(result.verifiedAt).toBe('2026-05-20T09:30:00.000Z');
      expect(result.answers[0].verifiedAt).toBe('2026-05-20T09:30:00.000Z');
      expect(result.seniorEligible).toBe(true);
    });

    it('reports the freshest verification across several answers as the question’s', async () => {
      prisma.civicsQuestion.findUnique.mockResolvedValue(question({ dynamicScope: 'none' }));
      prisma.civicsAnswer.findMany.mockResolvedValue([
        answerRow({ sort: 0, verifiedAt: new Date('2026-01-01T00:00:00Z') }),
        answerRow({ sort: 1, verifiedAt: new Date('2026-05-20T00:00:00Z') }),
        answerRow({ sort: 2, verifiedAt: new Date('2026-03-01T00:00:00Z') }),
      ]);

      const result = await service.getQuestion(TEXAN, QUESTION_ID);

      expect(result.verifiedAt).toBe('2026-05-20T00:00:00.000Z');
    });

    it('inlines the category so one screen needs one round trip', async () => {
      prisma.civicsAnswer.findMany.mockResolvedValue([]);

      const result = await service.getQuestion(TEXAN, QUESTION_ID);

      expect(result.category).toEqual({
        id: CATEGORY_ID,
        section: 'AMERICAN GOVERNMENT',
        code: 'system_of_government',
        name: 'System of Government',
        sortOrder: 2,
      });
    });

    it('serves each answer’s citation alongside its text', async () => {
      prisma.civicsAnswer.findMany.mockResolvedValue([
        answerRow({ stateCode: 'TX', sourceNote: 'texas.gov, retrieved 2026-05-01' }),
      ]);

      const result = await service.getQuestion(TEXAN, QUESTION_ID);

      expect(result.answers[0].sourceNote).toBe('texas.gov, retrieved 2026-05-01');
    });
  });

  // ---------------------------------------------------------------------------
  // The structural rule
  // ---------------------------------------------------------------------------

  describe('the caller is the only learner any method can reach', () => {
    it('reads the profile of the userId it was given, and only that one', async () => {
      await service.getQuestion(TEXAN, QUESTION_ID);

      expect(prisma.learnerProfile.findUnique).toHaveBeenCalledWith({
        where: { userId: TEXAN },
        select: { stateCode: true, testVersionCode: true },
      });
    });

    it('never creates a learner_profiles row — a content read is a read', async () => {
      // `JourneyService.getProfile` upserts because orientation needs a row to
      // fill in. Nothing here does: a missing profile already MEANS "no state,
      // no version", which is what a blank row would have said anyway.
      await service.getQuestion(NOMAD, QUESTION_ID);

      expect(prisma.learnerProfile.findUnique).toHaveBeenCalled();
      expect((prisma.learnerProfile as any).upsert).toBeUndefined();
    });
  });
});
