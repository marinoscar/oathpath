import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CivicsTestVersion, LearnerProfile } from '@prisma/client';

import { Clock } from '../common/clock/clock';
import { US_STATES_AND_TERRITORIES } from '../common/constants/us-states.constants';
import { PrismaService } from '../prisma/prisma.service';
import { PracticeService } from '../practice/practice.service';
import type {
  CivicsTestVersionOption,
  JourneyProfile,
  JourneyProfileResponse,
} from './dto/journey-profile.dto';
import type { JourneyHomeResponse } from './dto/journey-home.dto';
import type { UpdateJourneyProfileInput } from './dto/update-journey-profile.dto';
import { recommendStudyAction } from './study-coach';
import { filedFromFor, resolveTestVersionCode } from './test-version-resolution';

// =============================================================================
// JourneyService (issue #65, epic #50)
// =============================================================================
//
// Everything behind `/api/journey/*`: the learner's own profile, the
// orientation write, and Home's deterministic answer to "what should I do
// next".
//
// -----------------------------------------------------------------------------
// EVERY METHOD TAKES A `userId` THAT CAME FROM `@CurrentUser('id')`
// -----------------------------------------------------------------------------
//
// There is no method here that takes a user id from anywhere else, because the
// controller has no parameter that could carry one. The service is written to
// that assumption on purpose: an admin-facing "read any learner's profile"
// method would be the natural place for a future caller to reach for, and it
// deliberately does not exist. Adding one is a new method with a visible diff
// and a reviewer, not a query-string edit.
//
// -----------------------------------------------------------------------------
// NOTHING IN THIS MODULE CONSTRUCTS A WALL-CLOCK DATE, ANYWHERE
// -----------------------------------------------------------------------------
//
// There is no bare `Date` construction in any file under `src/journey/` --
// grep for it and the result is empty, comments included, so the rule is
// checkable rather than merely stated.
//
// Every notion of "now" comes from the injected `Clock` (#63), which is what
// makes `X-Test-Clock` able to pin a countdown in a test without sleeping, and
// what keeps the interview countdown a server-computed integer rather than a
// value derived ad hoc. `Date.UTC` appears below in the calendar-day
// arithmetic, which is a pure function of two given dates and reads no clock
// at all, and `Intl.DateTimeFormat` appears in {@link calendarDateOf}, which
// reduces an instant THE DATABASE HANDED US to a calendar day in the learner's
// timezone -- also a pure function of its argument, and the same mechanism
// `Clock.calendarDateIn` uses on the one instant this module is allowed to ask
// for.
// =============================================================================

/** Milliseconds in a calendar day, at UTC midnight. See {@link dayIndexOf}. */
const MS_PER_DAY = 86_400_000;

@Injectable()
export class JourneyService {
  private readonly logger = new Logger(JourneyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly practiceService: PracticeService,
  ) {}

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  /**
   * The caller's profile, plus the two reference lists the orientation form
   * needs to render. See `dto/journey-profile.dto.ts` on why all three travel
   * together rather than as three round trips.
   *
   * **THIS READ WRITES, ON ITS FIRST CALL FOR A GIVEN USER.** That is stated
   * plainly rather than buried, because a `GET` with a side effect is
   * surprising and deserves its reason:
   *
   * `LearnerProfileProvider` calls this on mount, before the learner has done
   * anything at all — a first login reaches it. journey-shell.md §3.2 permits
   * the row to be created "at account creation (or lazily on first orientation
   * read)", and lazy creation is what makes the endpoint work for the accounts
   * that ALREADY EXIST: users created before `learner_profiles` existed have
   * no row, and no backfill can cover accounts created by a future OAuth path
   * that forgets to make one. The alternative — 404 on a first login — would
   * make the very first screen a new learner sees an error.
   *
   * It is an UPSERT, not a read-then-create, so two concurrent first loads
   * (the provider and a page mounting together) race into one row rather than
   * into a unique-constraint violation.
   */
  async getProfile(userId: string): Promise<JourneyProfileResponse> {
    const [profile, testVersions] = await Promise.all([
      this.ensureProfile(userId),
      this.listTestVersions(),
    ]);

    return this.buildProfileResponse(profile, testVersions);
  }

  /**
   * Home's payload: where the learner is, how long they have, and the one
   * thing to do next.
   *
   * Deterministic and pure over the profile — no AI call, no randomness, and
   * identical on two consecutive loads (ROADMAP §7).
   */
  async getHome(userId: string): Promise<JourneyHomeResponse> {
    const profile = await this.ensureProfile(userId);

    // "Now", read ONCE per request, as a calendar day in the learner's own
    // timezone. Both facts below are questions about that day -- how many days
    // until the interview, and whether anything has been practised on it -- so
    // reading the clock twice would let a request that straddles local midnight
    // answer them from two different days.
    const today = this.clock.calendarDateIn(profile.timezone);

    const interviewDate = toCalendarDate(profile.interviewDate);
    const daysUntilInterview = daysBetween(today, interviewDate);
    const hasPractisedToday = await this.hasPractisedOn(
      userId,
      today,
      profile.timezone,
    );
    const { dueCount, lapsedCount } = await this.loadStudyCoachCounts(
      userId,
      profile.testVersionCode,
    );

    return {
      stage: profile.stage,
      interviewDate,
      daysUntilInterview,
      // Today is NOT past. A learner whose interview is in four hours is
      // counting down, not looking back.
      interviewPast: daysUntilInterview !== null && daysUntilInterview < 0,
      dailyGoal: {
        minutes: profile.dailyGoalMinutes,
        // Literally false for the whole of E1. See `dto/journey-home.dto.ts`
        // and journey-shell.md §10 — there is deliberately no `minutesToday`.
        tracked: false,
      },
      nextAction: recommendStudyAction({
        orientationCompletedAt: profile.orientationCompletedAt,
        daysUntilInterview,
        hasPractisedToday,
        dueCount,
        lapsedCount,
      }),
    };
  }

  // ---------------------------------------------------------------------------
  // The write
  // ---------------------------------------------------------------------------

  /**
   * Apply an orientation or settings save to the caller's own profile.
   *
   * Merge semantics: an absent key leaves its field untouched. The reasoning,
   * and the one exception (`interviewDate: null` clears), is in
   * `dto/update-journey-profile.dto.ts`.
   */
  async updateProfile(
    userId: string,
    input: UpdateJourneyProfileInput,
  ): Promise<JourneyProfileResponse> {
    const [current, testVersions] = await Promise.all([
      this.ensureProfile(userId),
      this.listTestVersions(),
    ]);

    const data: Prisma.LearnerProfileUncheckedUpdateInput = {};
    const changedFields: string[] = [];

    // --- test version: resolved from the filing date, or given directly -----
    //
    // journey-shell.md §3.2 and §6.3: THE SERVER RESOLVES THIS, NEVER THE
    // CLIENT. The cutoff rule lives in exactly one place
    // (`test-version-resolution.ts`) and the browser never learns it. The two
    // inputs are alternatives — the DTO rejects a request carrying both, since
    // there is no principled way to choose between a filing date and a
    // contradicting explicit code.
    const proposedTestVersion =
      input.filingDate !== undefined
        ? resolveTestVersionCode(input.filingDate)
        : input.testVersionCode;

    if (proposedTestVersion !== undefined) {
      // Checked against the ROWS, not against a hardcoded union. The table
      // exists so a future test revision is an insert rather than a schema
      // change (journey-shell.md §3.1); validating against a constant here
      // would reject that row on the day it lands.
      if (!testVersions.some((version) => version.code === proposedTestVersion)) {
        throw new BadRequestException(
          `Unknown test version "${proposedTestVersion}". Valid codes: ${testVersions
            .map((version) => version.code)
            .join(', ')}`,
        );
      }

      if (proposedTestVersion !== current.testVersionCode) {
        data.testVersionCode = proposedTestVersion;
        changedFields.push('testVersionCode');
      }
    }

    // --- interview date -----------------------------------------------------
    //
    // Written as a UTC-midnight ISO string rather than through a `Date`, both
    // because the column is `@db.Date` (a calendar day, not an instant) and
    // because constructing a `Date` here would put date parsing back into a
    // module whose whole point is that it has one source of time.
    if (input.interviewDate !== undefined) {
      const next = input.interviewDate;
      if (next !== toCalendarDate(current.interviewDate)) {
        data.interviewDate = next === null ? null : `${next}T00:00:00.000Z`;
        changedFields.push('interviewDate');
      }
    }

    // --- the plain scalars --------------------------------------------------
    if (input.stateCode !== undefined && input.stateCode !== current.stateCode) {
      data.stateCode = input.stateCode;
      changedFields.push('stateCode');
    }

    if (
      input.seniorExemption !== undefined &&
      input.seniorExemption !== current.seniorExemption
    ) {
      data.seniorExemption = input.seniorExemption;
      changedFields.push('seniorExemption');
    }

    if (
      input.dailyGoalMinutes !== undefined &&
      input.dailyGoalMinutes !== current.dailyGoalMinutes
    ) {
      data.dailyGoalMinutes = input.dailyGoalMinutes;
      changedFields.push('dailyGoalMinutes');
    }

    if (
      input.explanationLanguage !== undefined &&
      input.explanationLanguage !== current.explanationLanguage
    ) {
      data.explanationLanguage = input.explanationLanguage;
      changedFields.push('explanationLanguage');
    }

    if (input.timezone !== undefined && input.timezone !== current.timezone) {
      data.timezone = input.timezone;
      changedFields.push('timezone');
    }

    // --- orientation completion, INFERRED ------------------------------------
    //
    // There is no client flag, by design (see the DTO header). The evidence IS
    // the stored data: once the profile holds every fact orientation asks for,
    // orientation is complete, and a request cannot claim otherwise.
    //
    // Guarded on `orientationCompletedAt === null`, which makes it idempotent:
    // a later save re-supplying the same fields re-runs neither the timestamp
    // nor the stage transition, so the moment a learner finished setup stays
    // the moment they finished setup.
    //
    // `uncertain` → `oriented` is the ONLY transition E1 implements
    // (journey-shell.md §1). The `stage === 'uncertain'` guard is why a
    // learner who has since reached `learning` cannot be dragged backwards by
    // editing their settings — every later stage is owned by the epic whose
    // evidence justifies it, and this method must never touch one.
    const orientationCompleted =
      current.orientationCompletedAt === null &&
      this.isOrientationComplete({
        testVersionCode: proposedTestVersion ?? current.testVersionCode,
        stateCode: input.stateCode ?? current.stateCode,
        timezone: input.timezone ?? current.timezone,
        dailyGoalMinutes: input.dailyGoalMinutes ?? current.dailyGoalMinutes,
        explanationLanguage:
          input.explanationLanguage ?? current.explanationLanguage,
      });

    if (orientationCompleted) {
      data.orientationCompletedAt = this.clock.now();
      if (current.stage === 'uncertain') {
        data.stage = 'oriented';
      }
    }

    const updated = await this.prisma.learnerProfile.update({
      where: { userId },
      data,
    });

    await this.audit(userId, changedFields, orientationCompleted);

    if (orientationCompleted) {
      this.logger.log(
        { userId, stage: updated.stage },
        'Orientation completed; learner profile advanced',
      );
    }

    return this.buildProfileResponse(updated, testVersions);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * The caller's row, created at every column default if it does not exist.
   *
   * `update: {}` is deliberate: this must never modify an existing row, only
   * guarantee one is there. See {@link getProfile} on why creation is lazy.
   */
  private ensureProfile(userId: string): Promise<LearnerProfile> {
    return this.prisma.learnerProfile.upsert({
      where: { userId },
      create: { userId },
      update: {},
    });
  }

  /** Every seeded civics test version, in a stable order. */
  private listTestVersions(): Promise<CivicsTestVersion[]> {
    return this.prisma.civicsTestVersion.findMany({ orderBy: { code: 'asc' } });
  }

  /**
   * Whether the profile now holds everything orientation asks for.
   *
   * All five are checked even though three of them (`timezone`,
   * `dailyGoalMinutes`, `explanationLanguage`) carry column defaults and are
   * therefore never null in practice. That is not redundancy for its own sake:
   * the list documents what "oriented" ATTESTS TO, and if a later migration
   * drops one of those defaults the gate tightens automatically instead of
   * quietly certifying an incomplete profile.
   */
  private isOrientationComplete(profile: {
    testVersionCode: string | null;
    stateCode: string | null;
    timezone: string | null;
    dailyGoalMinutes: number | null;
    explanationLanguage: string | null;
  }): boolean {
    return (
      isPresent(profile.testVersionCode) &&
      isPresent(profile.stateCode) &&
      isPresent(profile.timezone) &&
      isPresent(profile.explanationLanguage) &&
      profile.dailyGoalMinutes !== null &&
      profile.dailyGoalMinutes !== undefined
    );
  }

  /**
   * Whether this learner has recorded a practice attempt on their own
   * calendar day `today`.
   *
   * -------------------------------------------------------------------------
   * WHY THIS READS THE LATEST ATTEMPT INSTEAD OF COUNTING A TIME WINDOW
   * -------------------------------------------------------------------------
   *
   * The obvious implementation is `count({ answeredAt: { gte: startOfDay, lt:
   * endOfDay } })`. It is not used here, because building those two instants
   * means converting the learner's local midnight into UTC, and the only
   * offset this module can obtain without constructing a `Date` is the offset
   * AT THE CURRENT INSTANT. On the two days a year the zone shifts, that
   * offset is not the offset at local midnight, so the window would slide by
   * an hour and an attempt made at 23:30 the previous local day would be
   * counted as today's. That is exactly the quiet off-by-one
   * {@link daysBetween} refuses to make about the countdown, and it would be
   * no more acceptable here.
   *
   * Reducing an instant to a calendar day, in contrast, is exact in every
   * zone and on every day: `Intl` already knows which offset applied at that
   * instant. So this asks for the single most recent attempt -- attempts are
   * never recorded in the future, so if the newest one is not on today's local
   * day, none are -- and compares calendar days. One row, one comparison, no
   * offset arithmetic.
   *
   * `select` is narrowed to the one column: an attempt row carries the
   * learner's own response text and a frozen answer snapshot, and Home has no
   * business loading either to answer a yes/no question.
   */
  private async hasPractisedOn(
    userId: string,
    today: string,
    timeZone: string,
  ): Promise<boolean> {
    const latest = await this.prisma.practiceAttempt.findFirst({
      where: { userId },
      orderBy: { answeredAt: 'desc' },
      select: { answeredAt: true },
    });

    if (!latest) {
      return false;
    }

    return calendarDateOf(latest.answeredAt, timeZone) === today;
  }

  /**
   * The Study Coach's two mastery inputs (`study-coach.ts`'s `dueCount` /
   * `lapsedCount`, docs/specs/memory-model.md §6), read through
   * `PracticeService.getQueue` rather than a second aggregation over
   * `question_mastery` — the "one shared query, not a duplicate count kept in
   * sync by convention" `study-coach.ts`'s own header requires.
   *
   * **Guarded on `testVersionCode`, not called unconditionally.**
   * `PracticeService.getQueue` throws a 400 for a learner whose test version
   * has not been resolved yet (`requireOrientedProfile`'s own guard) — exactly
   * the learner for whom `recommendStudyAction`'s first branch
   * (`orientationCompletedAt === null`) already returns `orientation` without
   * ever looking at these two counts. Rather than let that branch order do
   * the guarding implicitly (and pay for — or crash on — a query whose result
   * is thrown away), this reads the one field `isOrientationComplete` also
   * requires and skips the call entirely when it is absent.
   */
  private async loadStudyCoachCounts(
    userId: string,
    testVersionCode: string | null,
  ): Promise<{ dueCount: number; lapsedCount: number }> {
    if (testVersionCode === null) {
      return { dueCount: 0, lapsedCount: 0 };
    }

    const queue = await this.practiceService.getQueue(userId);
    return { dueCount: queue.due, lapsedCount: queue.weak };
  }

  /**
   * Record the write.
   *
   * **THE META CARRIES FIELD NAMES, NEVER FIELD VALUES.** Audit rows are
   * queried and exported far more casually than the table they describe, and
   * this profile holds where a learner lives, when their naturalization
   * interview is, and whether they claim a 65-and-over accommodation. Knowing
   * that `interviewDate` changed is enough to reconstruct what happened;
   * copying the date into a second table multiplies the places that fact has
   * to be protected. `AiUserKeyService.audit` makes the identical argument for
   * credentials.
   *
   * `targetType`/`targetId` name the LEARNER whose profile changed, which is
   * always the actor: there is no path through this module by which those two
   * can differ, and a row where they do would itself be the alarm.
   */
  private async audit(
    userId: string,
    changedFields: string[],
    orientationCompleted: boolean,
  ): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        actorUserId: userId,
        action: 'journey:profile_update',
        targetType: 'learner_profile',
        targetId: userId,
        meta: {
          fields: changedFields,
          orientationCompleted,
        } as unknown as Prisma.InputJsonValue,
      },
    });
  }

  /** Assemble the wire shape from a row and the version list. */
  private buildProfileResponse(
    profile: LearnerProfile,
    testVersions: CivicsTestVersion[],
  ): JourneyProfileResponse {
    return {
      profile: toJourneyProfile(profile),
      testVersions: testVersions.map(toTestVersionOption),
      // Copied out of the constant rather than handed over directly: the array
      // is module-level state living for the process lifetime, and an
      // interceptor or serialiser that sorted it in place would reorder the
      // state list for every later request.
      states: US_STATES_AND_TERRITORIES.map((state) => ({
        code: state.code,
        name: state.name,
      })),
    };
  }
}

/** A row's public shape. Mapped field by field, so a column added to the table does not become public API by accident. */
function toJourneyProfile(profile: LearnerProfile): JourneyProfile {
  return {
    stage: profile.stage,
    interviewDate: toCalendarDate(profile.interviewDate),
    stateCode: profile.stateCode,
    testVersionCode: profile.testVersionCode,
    seniorExemption: profile.seniorExemption,
    dailyGoalMinutes: profile.dailyGoalMinutes,
    explanationLanguage: profile.explanationLanguage,
    timezone: profile.timezone,
    orientationCompletedAt: profile.orientationCompletedAt
      ? profile.orientationCompletedAt.toISOString()
      : null,
  };
}

/** A version row plus its derived `filedFrom`. See `test-version-resolution.ts`. */
function toTestVersionOption(
  version: CivicsTestVersion,
): CivicsTestVersionOption {
  return {
    code: version.code,
    label: version.label,
    questionsAsked: version.questionsAsked,
    passThreshold: version.passThreshold,
    seniorQuestionsAsked: version.seniorQuestionsAsked,
    seniorPassThreshold: version.seniorPassThreshold,
    filedFrom: filedFromFor(version.code),
  };
}

/**
 * A `@db.Date` column as the `YYYY-MM-DD` string the API sends.
 *
 * Prisma materialises a `@db.Date` at UTC midnight, so the UTC calendar parts
 * are the stored day by construction — using local parts here would shift the
 * date by one for any server west of Greenwich, which is precisely the bug the
 * column type was chosen to avoid.
 */
function toCalendarDate(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(0, 10);
}

/**
 * Whole calendar days from `today` to `interviewDate`, both `YYYY-MM-DD`.
 *
 * NOT AN ELAPSED-MILLISECONDS DIVISION. Two instants 24 hours apart can fall
 * on the same calendar day or on days two apart depending on where a DST
 * boundary sits, and a countdown that is off by one on the week of a clock
 * change is exactly the kind of quiet wrongness this whole `Clock` design
 * exists to prevent. Both operands are already reduced to a calendar day --
 * "today" by the caller through `Clock.calendarDateIn`, which is
 * timezone-aware, and the interview by the `@db.Date` column that already IS a
 * calendar day -- and the subtraction happens between two day numbers.
 *
 * A pure function of its two strings: `today` is passed in rather than read
 * here so that {@link JourneyService.getHome} reads the clock exactly once.
 * An unknown stored `timezone` makes that single `Clock.calendarDateIn` call
 * throw `RangeError`, and that is left to propagate deliberately. It cannot
 * happen through this API -- the write path rejects any zone `Intl` will not
 * format in -- and silently substituting UTC would hand the learner a
 * countdown quietly off by one, which `Clock` itself refuses to do for the
 * same reason.
 */
function daysBetween(today: string, interviewDate: string | null): number | null {
  if (interviewDate === null) {
    return null;
  }

  return dayIndexOf(interviewDate) - dayIndexOf(today);
}

/**
 * An instant as the calendar day it fell on in `timeZone`, `YYYY-MM-DD`.
 *
 * The read-side counterpart to `Clock.calendarDateIn`, which answers the same
 * question about NOW. It lives here rather than on `Clock` because it reads no
 * clock at all: it is a pure function of the instant handed to it, which is
 * always a value Postgres returned (`practice_attempts.answered_at`), never
 * one this module made up.
 *
 * Assembled from `formatToParts` with an explicit `en-US` locale rather than
 * `format()` under a locale that happens to emit ISO order, so the output
 * shape is a property of this function and not of the runtime's locale data --
 * the same construction `Clock` uses, for the same reason.
 */
function calendarDateOf(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);

  const part = (type: Intl.DateTimeFormatPartTypes): string => {
    const found = parts.find((p) => p.type === type);
    /* istanbul ignore next -- Intl always emits the parts we requested */
    if (!found) {
      throw new Error(`Intl did not return a "${type}" part for ${timeZone}`);
    }
    return found.value;
  };

  return `${part('year')}-${part('month')}-${part('day')}`;
}

/**
 * A `YYYY-MM-DD` string as a day number: days since the Unix epoch.
 *
 * `Date.UTC` is a pure function of the numbers passed to it — it reads no
 * clock and has no timezone of its own — so this stays inside the module's
 * "one source of time" rule. Reducing both dates to integers first is what
 * makes the subtraction a count of CALENDAR days rather than of elapsed time.
 */
function dayIndexOf(calendarDate: string): number {
  const [year, month, day] = calendarDate.split('-').map(Number);
  return Date.UTC(year, month - 1, day) / MS_PER_DAY;
}

/** A non-null, non-blank string. */
function isPresent(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
