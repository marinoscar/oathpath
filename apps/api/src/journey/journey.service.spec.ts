import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { Clock } from '../common/clock/clock';
import { PrismaService } from '../prisma/prisma.service';
import { JourneyService } from './journey.service';

// =============================================================================
// JourneyService — tests (issue #65, epic #50)
// =============================================================================
//
// The behaviours that are worth a test are the ones that are decisions rather
// than plumbing:
//
//   * a first read creates the row instead of 404ing;
//   * the server, not the client, resolves the test version;
//   * unknown test versions are rejected against the ROWS;
//   * orientation completion is inferred, happens once, and never walks a
//     later stage backwards;
//   * the audit row names fields and never values;
//   * the countdown counts calendar days in the learner's own timezone;
//   * "has this learner practised today" is answered on the learner's own
//     calendar day too, and not on UTC's (#81).
// =============================================================================

const LEARNER = '11111111-1111-4111-8111-111111111111';

const TEST_VERSIONS = [
  {
    code: 'v2008',
    label: '2008 Civics Test',
    questionsAsked: 10,
    passThreshold: 6,
    seniorQuestionsAsked: 10,
    seniorPassThreshold: 6,
    contentHash: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  },
  {
    code: 'v2025',
    label: '2025 Civics Test',
    questionsAsked: 20,
    passThreshold: 12,
    seniorQuestionsAsked: 10,
    seniorPassThreshold: 6,
    contentHash: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  },
];

/** A profile row at every column default — what lazy creation produces. */
function blankProfile(overrides: Record<string, unknown> = {}) {
  return {
    id: '99999999-9999-4999-8999-999999999999',
    userId: LEARNER,
    stage: 'uncertain',
    interviewDate: null,
    stateCode: null,
    testVersionCode: null,
    seniorExemption: false,
    dailyGoalMinutes: 5,
    explanationLanguage: 'en',
    timezone: 'UTC',
    orientationCompletedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('JourneyService', () => {
  let service: JourneyService;
  let prisma: {
    learnerProfile: { upsert: jest.Mock; update: jest.Mock };
    civicsTestVersion: { findMany: jest.Mock };
    auditEvent: { create: jest.Mock };
    practiceAttempt: { findFirst: jest.Mock };
  };
  let clock: { now: jest.Mock; calendarDateIn: jest.Mock };

  beforeEach(async () => {
    prisma = {
      learnerProfile: {
        upsert: jest.fn().mockResolvedValue(blankProfile()),
        // By default, echo back the row with the update applied, which is what
        // Postgres does and what makes the returned response assertable.
        //
        // `interviewDate` is re-hydrated to a `Date` because that is what
        // Prisma hands back for a `@db.Date` column, whatever shape it
        // accepted on the way in. A mock that echoed the ISO string straight
        // back would let a real `.toISOString()` bug hide behind a string that
        // happens to look right.
        update: jest
          .fn()
          .mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
            blankProfile({
              ...data,
              ...(typeof data.interviewDate === 'string'
                ? { interviewDate: new Date(data.interviewDate) }
                : {}),
            }),
          ),
      },
      civicsTestVersion: { findMany: jest.fn().mockResolvedValue(TEST_VERSIONS) },
      auditEvent: { create: jest.fn().mockResolvedValue({}) },
      // A learner who has never practised. Individual tests hand back a row.
      practiceAttempt: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    clock = {
      now: jest.fn().mockReturnValue(new Date('2026-02-01T10:00:00Z')),
      calendarDateIn: jest.fn().mockReturnValue('2026-02-01'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JourneyService,
        { provide: PrismaService, useValue: prisma },
        { provide: Clock, useValue: clock },
      ],
    }).compile();

    service = module.get(JourneyService);
  });

  // ---------------------------------------------------------------------------
  // getProfile
  // ---------------------------------------------------------------------------

  describe('getProfile', () => {
    it('creates the row lazily rather than reporting it missing', () => {
      // An upsert, not a find-then-create: two concurrent first loads (the
      // provider and a page mounting together) must land on one row rather
      // than on a unique-constraint violation.
      return service.getProfile(LEARNER).then((response) => {
        expect(prisma.learnerProfile.upsert).toHaveBeenCalledWith({
          where: { userId: LEARNER },
          create: { userId: LEARNER },
          update: {},
        });
        expect(response.profile.stage).toBe('uncertain');
      });
    });

    it('never modifies an existing row on a read', async () => {
      await service.getProfile(LEARNER);

      const { update } = prisma.learnerProfile.upsert.mock.calls[0][0];
      expect(update).toEqual({});
      expect(prisma.learnerProfile.update).not.toHaveBeenCalled();
    });

    it('serves the caller’s own profile, scoped by the id it was given', async () => {
      await service.getProfile(LEARNER);

      expect(prisma.learnerProfile.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: LEARNER } }),
      );
    });

    it('derives filedFrom rather than reading it from a column', async () => {
      const { testVersions } = await service.getProfile(LEARNER);

      expect(testVersions.find((v) => v.code === 'v2008')?.filedFrom).toBeNull();
      expect(testVersions.find((v) => v.code === 'v2025')?.filedFrom).toBe(
        '2025-10-20',
      );
      // Nothing in the row itself carried it — the rows fed to the service
      // have no such column.
      expect(TEST_VERSIONS[1]).not.toHaveProperty('filedFrom');
    });

    it('serves all 56 states and territories', async () => {
      const { states } = await service.getProfile(LEARNER);

      expect(states).toHaveLength(56);
      for (const code of ['DC', 'PR', 'GU', 'VI', 'AS', 'MP']) {
        expect(states.map((s) => s.code)).toContain(code);
      }
    });

    it('renders an interview date as a calendar day, not a timestamp', async () => {
      prisma.learnerProfile.upsert.mockResolvedValue(
        blankProfile({ interviewDate: new Date('2026-03-15T00:00:00Z') }),
      );

      const { profile } = await service.getProfile(LEARNER);
      expect(profile.interviewDate).toBe('2026-03-15');
    });
  });

  // ---------------------------------------------------------------------------
  // updateProfile — validation
  // ---------------------------------------------------------------------------

  describe('updateProfile validation', () => {
    it('rejects a test version that is not a row in civics_test_versions', async () => {
      await expect(
        service.updateProfile(LEARNER, { testVersionCode: 'v1999' }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.learnerProfile.update).not.toHaveBeenCalled();
    });

    it('names the codes that ARE valid, from the rows', async () => {
      // Checked against the table rather than a hardcoded union, so a future
      // revision row is accepted the day it is inserted.
      await expect(
        service.updateProfile(LEARNER, { testVersionCode: 'v1999' }),
      ).rejects.toThrow(/v2008, v2025/);
    });

    it('accepts a version the table has but this code has never heard of', async () => {
      prisma.civicsTestVersion.findMany.mockResolvedValue([
        ...TEST_VERSIONS,
        { ...TEST_VERSIONS[1], code: 'v2031', label: '2031 Civics Test' },
      ]);

      await expect(
        service.updateProfile(LEARNER, { testVersionCode: 'v2031' }),
      ).resolves.toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // updateProfile — the server resolves the test version
  // ---------------------------------------------------------------------------

  describe('updateProfile test-version resolution', () => {
    it('resolves a pre-cutoff filing date to the 2008 test', async () => {
      await service.updateProfile(LEARNER, { filingDate: '2025-10-19' });

      expect(prisma.learnerProfile.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ testVersionCode: 'v2008' }),
        }),
      );
    });

    it('resolves a filing on the cutoff to the 2025 test', async () => {
      await service.updateProfile(LEARNER, { filingDate: '2025-10-20' });

      expect(prisma.learnerProfile.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ testVersionCode: 'v2025' }),
        }),
      );
    });

    it('never stores the filing date itself', async () => {
      // It is an input to a decision, not a fact about the learner this
      // product keeps. There is no column for it.
      await service.updateProfile(LEARNER, { filingDate: '2025-10-20' });

      const { data } = prisma.learnerProfile.update.mock.calls[0][0];
      expect(data).not.toHaveProperty('filingDate');
    });
  });

  // ---------------------------------------------------------------------------
  // updateProfile — merge semantics
  // ---------------------------------------------------------------------------

  describe('updateProfile merge semantics', () => {
    it('leaves untouched fields out of the update entirely', async () => {
      prisma.learnerProfile.upsert.mockResolvedValue(
        blankProfile({ timezone: 'America/Chicago', dailyGoalMinutes: 20 }),
      );

      await service.updateProfile(LEARNER, { seniorExemption: true });

      const { data } = prisma.learnerProfile.update.mock.calls[0][0];
      expect(data).toEqual({ seniorExemption: true });
    });

    it('writes nothing for a value that is already what was sent', async () => {
      prisma.learnerProfile.upsert.mockResolvedValue(
        blankProfile({ timezone: 'America/Chicago' }),
      );

      await service.updateProfile(LEARNER, { timezone: 'America/Chicago' });

      const { data } = prisma.learnerProfile.update.mock.calls[0][0];
      expect(data).toEqual({});
    });

    it('clears the interview date on an explicit null', async () => {
      prisma.learnerProfile.upsert.mockResolvedValue(
        blankProfile({ interviewDate: new Date('2026-03-15T00:00:00Z') }),
      );

      await service.updateProfile(LEARNER, { interviewDate: null });

      const { data } = prisma.learnerProfile.update.mock.calls[0][0];
      expect(data.interviewDate).toBeNull();
    });

    it('writes an interview date at UTC midnight, so the day cannot drift', async () => {
      await service.updateProfile(LEARNER, { interviewDate: '2026-03-15' });

      const { data } = prisma.learnerProfile.update.mock.calls[0][0];
      expect(data.interviewDate).toBe('2026-03-15T00:00:00.000Z');
    });
  });

  // ---------------------------------------------------------------------------
  // updateProfile — orientation inference
  // ---------------------------------------------------------------------------

  describe('orientation completion', () => {
    const COMPLETE_FORM = {
      filingDate: '2025-11-01',
      stateCode: 'CA',
      timezone: 'America/Los_Angeles',
      dailyGoalMinutes: 10,
      explanationLanguage: 'es',
    };

    it('sets the timestamp and moves uncertain → oriented in one write', async () => {
      await service.updateProfile(LEARNER, COMPLETE_FORM);

      const { data } = prisma.learnerProfile.update.mock.calls[0][0];
      expect(data.orientationCompletedAt).toEqual(
        new Date('2026-02-01T10:00:00Z'),
      );
      expect(data.stage).toBe('oriented');
    });

    it('takes the completion time from the Clock, never from wall-clock time', async () => {
      await service.updateProfile(LEARNER, COMPLETE_FORM);
      expect(clock.now).toHaveBeenCalled();
    });

    it('does not complete on a partial profile', async () => {
      // A state but no test version: the learner has told us where they live
      // and nothing about which test they take.
      await service.updateProfile(LEARNER, { stateCode: 'CA' });

      const { data } = prisma.learnerProfile.update.mock.calls[0][0];
      expect(data).not.toHaveProperty('orientationCompletedAt');
      expect(data).not.toHaveProperty('stage');
    });

    it('completes on the save that supplies the last missing field', async () => {
      // Half the form was saved earlier; this request finishes it.
      prisma.learnerProfile.upsert.mockResolvedValue(
        blankProfile({ testVersionCode: 'v2025' }),
      );

      await service.updateProfile(LEARNER, { stateCode: 'CA' });

      const { data } = prisma.learnerProfile.update.mock.calls[0][0];
      expect(data.orientationCompletedAt).toBeDefined();
      expect(data.stage).toBe('oriented');
    });

    it('is idempotent — a second save re-runs neither the timestamp nor the transition', async () => {
      const completedAt = new Date('2026-01-15T09:00:00Z');
      prisma.learnerProfile.upsert.mockResolvedValue(
        blankProfile({
          stage: 'oriented',
          stateCode: 'CA',
          testVersionCode: 'v2025',
          orientationCompletedAt: completedAt,
        }),
      );

      await service.updateProfile(LEARNER, {
        ...COMPLETE_FORM,
        filingDate: undefined,
        testVersionCode: 'v2025',
      });

      const { data } = prisma.learnerProfile.update.mock.calls[0][0];
      expect(data).not.toHaveProperty('orientationCompletedAt');
      expect(data).not.toHaveProperty('stage');
    });

    it('never walks a later stage backwards to oriented', async () => {
      // A learner who has reached `learning` editing their settings must not
      // be demoted: every stage past `oriented` belongs to a later epic, and
      // this method must never touch one.
      prisma.learnerProfile.upsert.mockResolvedValue(
        blankProfile({
          stage: 'learning',
          stateCode: 'CA',
          testVersionCode: 'v2025',
          orientationCompletedAt: null,
        }),
      );

      await service.updateProfile(LEARNER, { dailyGoalMinutes: 15 });

      const { data } = prisma.learnerProfile.update.mock.calls[0][0];
      // The timestamp is backfilled, because it genuinely is complete...
      expect(data.orientationCompletedAt).toBeDefined();
      // ...but the stage is left exactly where the later epic put it.
      expect(data).not.toHaveProperty('stage');
    });
  });

  // ---------------------------------------------------------------------------
  // updateProfile — audit
  // ---------------------------------------------------------------------------

  describe('audit', () => {
    it('records journey:profile_update against the learner', async () => {
      await service.updateProfile(LEARNER, { dailyGoalMinutes: 15 });

      expect(prisma.auditEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          actorUserId: LEARNER,
          action: 'journey:profile_update',
          targetType: 'learner_profile',
          targetId: LEARNER,
        }),
      });
    });

    it('lists the field NAMES that changed', async () => {
      await service.updateProfile(LEARNER, {
        stateCode: 'NY',
        dailyGoalMinutes: 15,
      });

      const { data } = prisma.auditEvent.create.mock.calls[0][0];
      expect(data.meta.fields.sort()).toEqual(['dailyGoalMinutes', 'stateCode']);
    });

    it('records whether orientation completed on this write', async () => {
      await service.updateProfile(LEARNER, {
        filingDate: '2025-11-01',
        stateCode: 'CA',
      });

      const { data } = prisma.auditEvent.create.mock.calls[0][0];
      expect(data.meta.orientationCompleted).toBe(true);
    });

    it('NEVER carries the profile values themselves', async () => {
      // Audit rows are queried and exported far more casually than the table
      // they describe, and this profile holds where a learner lives and when
      // their naturalization interview is. Knowing WHICH field changed is
      // enough; copying the value multiplies the places it must be protected.
      await service.updateProfile(LEARNER, {
        stateCode: 'NY',
        interviewDate: '2026-03-15',
        seniorExemption: true,
        timezone: 'America/New_York',
        explanationLanguage: 'es',
        dailyGoalMinutes: 42,
      });

      const { data } = prisma.auditEvent.create.mock.calls[0][0];
      const serialised = JSON.stringify(data.meta);

      for (const value of [
        'NY',
        '2026-03-15',
        'America/New_York',
        '"es"',
        '42',
        'true,',
      ]) {
        expect(serialised).not.toContain(value);
      }
      expect(JSON.parse(serialised)).toEqual({
        fields: expect.any(Array),
        orientationCompleted: false,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // getHome
  // ---------------------------------------------------------------------------

  describe('getHome', () => {
    it('reports no countdown when no interview is booked', async () => {
      const home = await service.getHome(LEARNER);

      expect(home.interviewDate).toBeNull();
      expect(home.daysUntilInterview).toBeNull();
      expect(home.interviewPast).toBe(false);
    });

    it('counts whole calendar days in the learner’s own timezone', async () => {
      prisma.learnerProfile.upsert.mockResolvedValue(
        blankProfile({
          timezone: 'America/Los_Angeles',
          interviewDate: new Date('2026-02-15T00:00:00Z'),
          orientationCompletedAt: new Date('2026-01-01T00:00:00Z'),
        }),
      );
      clock.calendarDateIn.mockReturnValue('2026-02-01');

      const home = await service.getHome(LEARNER);

      expect(clock.calendarDateIn).toHaveBeenCalledWith('America/Los_Angeles');
      expect(home.daysUntilInterview).toBe(14);
    });

    it('counts across a DST boundary without drifting', async () => {
      // 8 March 2026 is a US spring-forward date. An elapsed-milliseconds
      // division across it returns 21.958…, which floors to 21 — one day
      // short. Calendar-day arithmetic gives the right answer.
      prisma.learnerProfile.upsert.mockResolvedValue(
        blankProfile({
          timezone: 'America/Los_Angeles',
          interviewDate: new Date('2026-03-23T00:00:00Z'),
          orientationCompletedAt: new Date('2026-01-01T00:00:00Z'),
        }),
      );
      clock.calendarDateIn.mockReturnValue('2026-03-01');

      expect((await service.getHome(LEARNER)).daysUntilInterview).toBe(22);
    });

    it('treats the interview day itself as not past', async () => {
      prisma.learnerProfile.upsert.mockResolvedValue(
        blankProfile({
          interviewDate: new Date('2026-02-01T00:00:00Z'),
          orientationCompletedAt: new Date('2026-01-01T00:00:00Z'),
        }),
      );

      const home = await service.getHome(LEARNER);

      expect(home.daysUntilInterview).toBe(0);
      expect(home.interviewPast).toBe(false);
      expect(home.nextAction.kind).toBe('interview_countdown');
    });

    it('reports a past interview as past, and stops counting down', async () => {
      prisma.learnerProfile.upsert.mockResolvedValue(
        blankProfile({
          interviewDate: new Date('2026-01-20T00:00:00Z'),
          orientationCompletedAt: new Date('2026-01-01T00:00:00Z'),
        }),
      );

      const home = await service.getHome(LEARNER);

      expect(home.daysUntilInterview).toBe(-12);
      expect(home.interviewPast).toBe(true);
      // `practice` since E3 (#81), `explore` before it: a new rung was
      // inserted below the countdown, so a learner with nothing recorded today
      // is invited to practise rather than to look around.
      expect(home.nextAction.kind).toBe('practice');
    });

    it('says the daily goal is not tracked, and invents no minutesToday', async () => {
      // journey-shell.md §10: a displayed `0` is indistinguishable from a
      // learner who genuinely did nothing today.
      const home = await service.getHome(LEARNER);

      expect(home.dailyGoal).toEqual({ minutes: 5, tracked: false });
      expect(home.dailyGoal).not.toHaveProperty('minutesToday');
    });

    it('is deterministic — two consecutive loads give an identical answer', async () => {
      prisma.learnerProfile.upsert.mockResolvedValue(
        blankProfile({
          interviewDate: new Date('2026-02-20T00:00:00Z'),
          orientationCompletedAt: new Date('2026-01-01T00:00:00Z'),
        }),
      );

      expect(await service.getHome(LEARNER)).toEqual(
        await service.getHome(LEARNER),
      );
    });

    // -------------------------------------------------------------------------
    // "Have I practised today?" — on the learner's calendar day, not UTC's
    // -------------------------------------------------------------------------
    //
    // Every fixture here is in `Pacific/Auckland` (UTC+13 in February) with the
    // clock pinned to 15 February LOCAL. That zone is chosen so the assertions
    // DISCRIMINATE: the two boundary instants below are two minutes apart and
    // fall on the SAME UTC calendar day, so an implementation that reduced
    // `answeredAt` in UTC could not tell them apart and would have to get one
    // of the two wrong.
    describe('hasPractisedToday', () => {
      /** An oriented learner in Auckland, whose local "today" is 15 February. */
      function inAuckland(): void {
        prisma.learnerProfile.upsert.mockResolvedValue(
          blankProfile({
            timezone: 'Pacific/Auckland',
            orientationCompletedAt: new Date('2026-01-01T00:00:00Z'),
          }),
        );
        clock.calendarDateIn.mockReturnValue('2026-02-15');
      }

      /** The learner's most recent attempt, at `answeredAt`. */
      function lastAttemptAt(answeredAt: string): void {
        prisma.practiceAttempt.findFirst.mockResolvedValue({
          answeredAt: new Date(answeredAt),
        });
      }

      it('recommends practice when nothing has ever been recorded', async () => {
        inAuckland();

        expect((await service.getHome(LEARNER)).nextAction.kind).toBe(
          'practice',
        );
      });

      it('counts an attempt at 23:59 on the learner’s own day as today', async () => {
        // 2026-02-15T23:59+13:00 — still 15 February in Auckland, already
        // 15 February in UTC as well, but only just: the instant is 10:59Z.
        inAuckland();
        lastAttemptAt('2026-02-15T10:59:00Z');

        expect((await service.getHome(LEARNER)).nextAction.kind).toBe('explore');
      });

      it('does NOT count an attempt at 00:01 the next local day', async () => {
        // 2026-02-16T00:01+13:00 — the very next local day, and TWO MINUTES
        // after the instant above. Both are 15 February in UTC; only one is
        // 15 February in Auckland. A UTC comparison would call this one
        // "today" and tell a learner who has not practised since yesterday
        // that their work is done.
        inAuckland();
        lastAttemptAt('2026-02-15T11:01:00Z');

        expect((await service.getHome(LEARNER)).nextAction.kind).toBe(
          'practice',
        );
      });

      it('counts an attempt at 00:01 on the learner’s own day, which UTC calls yesterday', async () => {
        // 2026-02-15T00:01+13:00 = 2026-02-14T11:01Z. The mirror image of the
        // case above: UTC says 14 February and would refuse to count work the
        // learner did this morning.
        inAuckland();
        lastAttemptAt('2026-02-14T11:01:00Z');

        expect((await service.getHome(LEARNER)).nextAction.kind).toBe('explore');
      });

      it('asks only for the caller’s latest attempt, and only for its timestamp', async () => {
        // Scoped by the id the service was handed — there is no other source
        // of a user id in this module — and narrowed to one column: an attempt
        // row carries the learner's own response text and a frozen answer
        // snapshot, and Home has no business loading either to answer a
        // yes/no question.
        inAuckland();

        await service.getHome(LEARNER);

        expect(prisma.practiceAttempt.findFirst).toHaveBeenCalledWith({
          where: { userId: LEARNER },
          orderBy: { answeredAt: 'desc' },
          select: { answeredAt: true },
        });
      });

      it('reads the learner’s day from the Clock, never from wall-clock time', async () => {
        inAuckland();

        await service.getHome(LEARNER);

        expect(clock.calendarDateIn).toHaveBeenCalledWith('Pacific/Auckland');
      });

      it('lets the countdown outrank practice for a learner with a date', async () => {
        prisma.learnerProfile.upsert.mockResolvedValue(
          blankProfile({
            timezone: 'Pacific/Auckland',
            interviewDate: new Date('2026-02-20T00:00:00Z'),
            orientationCompletedAt: new Date('2026-01-01T00:00:00Z'),
          }),
        );
        clock.calendarDateIn.mockReturnValue('2026-02-15');
        lastAttemptAt('2026-02-15T10:59:00Z');

        expect((await service.getHome(LEARNER)).nextAction.kind).toBe(
          'interview_countdown',
        );
      });
    });

    it('creates the profile lazily, so Home works on a first login too', async () => {
      await service.getHome(LEARNER);

      expect(prisma.learnerProfile.upsert).toHaveBeenCalledWith({
        where: { userId: LEARNER },
        create: { userId: LEARNER },
        update: {},
      });
    });
  });
});
