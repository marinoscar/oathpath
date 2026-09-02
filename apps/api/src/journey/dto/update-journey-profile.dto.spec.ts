import {
  DAILY_GOAL_MAX_MINUTES,
  DAILY_GOAL_MIN_MINUTES,
  UPDATE_JOURNEY_PROFILE_NAMES_NO_USER,
  updateJourneyProfileSchema,
} from './update-journey-profile.dto';

// =============================================================================
// PUT /api/journey/profile body — tests (issue #65, epic #50)
// =============================================================================
//
// This schema is the whole of the 400 surface for the write endpoint, so each
// rejection an acceptance criterion names is asserted here directly, and the
// integration spec then proves the same rejection reaches the wire as a 400.
// =============================================================================

const parse = (body: unknown) => updateJourneyProfileSchema.safeParse(body);

describe('updateJourneyProfileSchema', () => {
  it('accepts an empty body — every field is optional', () => {
    // A no-op save is not an error. Merge semantics mean an absent key leaves
    // its field alone, and the emptiest possible request is just the limit of
    // that.
    expect(parse({}).success).toBe(true);
  });

  it('accepts a complete orientation submission', () => {
    const result = parse({
      filingDate: '2025-11-01',
      seniorExemption: false,
      interviewDate: '2026-03-15',
      stateCode: 'CA',
      dailyGoalMinutes: 5,
      explanationLanguage: 'es',
      timezone: 'America/Los_Angeles',
    });

    expect(result.success).toBe(true);
  });

  it('rejects an unknown field rather than silently dropping it', () => {
    // `.strict()`. A client sending `stage` or `userId` gets told, instead of
    // believing a write happened that never did.
    expect(parse({ stage: 'ready' }).success).toBe(false);
  });

  describe('stateCode', () => {
    it.each(['CA', 'NY', 'DC', 'PR', 'GU', 'VI', 'AS', 'MP'])(
      'accepts %s',
      (code) => {
        expect(parse({ stateCode: code }).success).toBe(true);
      },
    );

    it('uppercases a lowercase code rather than rejecting it', () => {
      // Case carries no meaning here, so correcting it is strictly kinder
      // than a 400 the learner cannot act on.
      const result = parse({ stateCode: 'ca' });
      expect(result.success).toBe(true);
      expect(result.success && result.data.stateCode).toBe('CA');
    });

    it.each(['ZZ', 'CAL', 'C', '', 'UK'])('rejects %p', (code) => {
      expect(parse({ stateCode: code }).success).toBe(false);
    });
  });

  describe('timezone', () => {
    it.each(['UTC', 'America/Los_Angeles', 'Asia/Tokyo', 'Pacific/Chatham'])(
      'accepts %s',
      (timezone) => {
        expect(parse({ timezone }).success).toBe(true);
      },
    );

    it.each([
      'Not/AZone',
      'America/Nowhere',
      'PST8PDT7',
      'utc/utc',
      '',
    ])('rejects %p', (timezone) => {
      // The check is the exact operation `Clock.calendarDateIn` performs, so
      // anything accepted here is guaranteed formattable later. A zone that
      // slipped through would surface as a 500 on Home, not as a bad input.
      expect(parse({ timezone }).success).toBe(false);
    });
  });

  describe('explanationLanguage', () => {
    it.each(['en', 'es', 'es-MX', 'zh-Hant-TW', 'pt-BR'])(
      'accepts %s',
      (tag) => {
        expect(parse({ explanationLanguage: tag }).success).toBe(true);
      },
    );

    it.each(['en_US', 'e', '123', 'en-', '', 'not a tag'])(
      'rejects %p',
      (tag) => {
        expect(parse({ explanationLanguage: tag }).success).toBe(false);
      },
    );
  });

  describe('dailyGoalMinutes', () => {
    it.each([DAILY_GOAL_MIN_MINUTES, 5, 60, DAILY_GOAL_MAX_MINUTES])(
      'accepts %i',
      (minutes) => {
        expect(parse({ dailyGoalMinutes: minutes }).success).toBe(true);
      },
    );

    it.each([0, -5, DAILY_GOAL_MAX_MINUTES + 1, 5.5])('rejects %p', (minutes) => {
      // Zero is not a goal, and eight hours a day is a typo rather than a
      // plan — either would hand the learner a target that teaches them
      // nothing.
      expect(parse({ dailyGoalMinutes: minutes }).success).toBe(false);
    });
  });

  describe('interviewDate', () => {
    it('accepts a calendar date', () => {
      expect(parse({ interviewDate: '2026-03-15' }).success).toBe(true);
    });

    it('accepts an explicit null, which clears the date', () => {
      // The one field where null is meaningful: a cancelled interview has to
      // be removable, and merge semantics give no other way to say "no date".
      const result = parse({ interviewDate: null });
      expect(result.success).toBe(true);
      expect(result.success && result.data.interviewDate).toBeNull();
    });

    it.each(['15-03-2026', '2026-3-15', '2026-02-31', 'tomorrow'])(
      'rejects %p',
      (value) => {
        expect(parse({ interviewDate: value }).success).toBe(false);
      },
    );
  });

  describe('filingDate and testVersionCode are alternatives', () => {
    it('accepts a filing date alone', () => {
      expect(parse({ filingDate: '2025-10-20' }).success).toBe(true);
    });

    it('accepts a test version code alone', () => {
      // Shape only here — whether the code names a real row is checked
      // against the database in the service.
      expect(parse({ testVersionCode: 'v2025' }).success).toBe(true);
    });

    it('rejects both together', () => {
      // There is no principled way to choose between a filing date and a
      // contradicting explicit code, so the request is a client bug and is
      // reported as one rather than silently resolved one way.
      const result = parse({
        filingDate: '2025-10-20',
        testVersionCode: 'v2008',
      });

      expect(result.success).toBe(false);
      expect(result.success === false && result.error.issues[0].message).toMatch(
        /not both/,
      );
    });
  });

  it('carries the compile-time proof that no identity field is in the body', () => {
    expect(UPDATE_JOURNEY_PROFILE_NAMES_NO_USER).toBe(true);
  });

  it('has no field that could name another user or set a stage', () => {
    // The runtime companion to the type-level proof. `.strict()` means each
    // of these is rejected outright, which is what makes cross-user writes
    // unreachable through the body as well as through the URL.
    for (const field of [
      'userId',
      'user_id',
      'id',
      'learnerId',
      'profileId',
      'email',
      'stage',
      'orientationCompletedAt',
      'completeOrientation',
    ]) {
      expect(parse({ [field]: 'anything' }).success).toBe(false);
    }
  });
});
