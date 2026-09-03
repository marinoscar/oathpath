import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable } from '@nestjs/common';

/**
 * The shape stored in {@link clockOverrideStorage} while a request carries a
 * pinned instant. Deliberately a single field: the override is "what time is
 * it", not a general clock replacement.
 */
export interface ClockOverride {
  readonly now: Date;
}

/**
 * The override store, owned by this module and shared with
 * `TestClockMiddleware`.
 *
 * Why `AsyncLocalStorage` rather than a request-scoped Nest provider: a
 * `@Injectable({ scope: Scope.REQUEST })` clock would bubble request scope up
 * through every service that injects it -- `JourneyService`, and later the
 * mastery scheduler and the readiness engine -- turning API-wide singletons
 * into per-request instantiations. An ALS-backed singleton costs nothing at
 * runtime and isolates strictly better: the override lives exactly as long as
 * the async context it was entered in, so it cannot leak into a concurrent or
 * a subsequent request.
 */
export const clockOverrideStorage = new AsyncLocalStorage<ClockOverride>();

/** Milliseconds in a calendar day. Pure arithmetic on already-resolved instants. */
const MS_PER_DAY = 86_400_000;

/**
 * The application's single, mockable notion of "now".
 *
 * Nothing in this codebase that needs the current time should call `new Date()`
 * directly; inject `Clock` instead. That is what makes an end-to-end spec able
 * to advance the clock a day (ROADMAP section 7) without sleeping, and what
 * makes the interview countdown (#65) a server-computed integer rather than a
 * value derived ad hoc in a component.
 *
 * The surface is intentionally narrow. `now()` plus one timezone-aware
 * calendar-date helper is everything the journey module needs today; a later
 * epic can widen it, with a reason.
 */
@Injectable()
export class Clock {
  /**
   * Cached `Intl.DateTimeFormat` instances, keyed by IANA timezone.
   * Constructing one is comparatively expensive and the set of learner
   * timezones a process sees is small and repeats.
   */
  private readonly formatters = new Map<string, Intl.DateTimeFormat>();

  /**
   * A second cache, for the full date-and-time formatter `localHourIn` and
   * `localDayRangeIn` need.
   *
   * Kept separate from {@link formatters} rather than widening that one:
   * `calendarDateIn` is called on every accrual write and asks for three
   * fields, and making it format six would cost every one of those calls for
   * the benefit of two methods that are called once an hour.
   */
  private readonly dateTimeFormatters = new Map<string, Intl.DateTimeFormat>();

  /**
   * The current instant -- the pinned override when the caller is running
   * inside one, real wall-clock time otherwise.
   *
   * Always a fresh `Date`, so a caller mutating the returned value cannot
   * corrupt the override for the rest of the request.
   */
  now(): Date {
    const override = clockOverrideStorage.getStore();
    return override ? new Date(override.now.getTime()) : new Date();
  }

  /**
   * The current calendar date in `timeZone`, as a `YYYY-MM-DD` string -- the
   * same shape a Prisma `@db.Date` column round-trips.
   *
   * This exists because "how many days until the interview" is a question
   * about calendar days in the learner's timezone, not about elapsed
   * milliseconds: at 2026-01-15T23:30:00-08:00 the answer in
   * `America/Los_Angeles` is measured from January 15, while the same instant
   * is already January 16 in UTC.
   *
   * Throws `RangeError` for an unknown timezone identifier, which is what
   * `Intl` does and what a bad stored `timezone` deserves -- silently falling
   * back to UTC would hand a learner a countdown that is quietly off by one.
   */
  calendarDateIn(timeZone: string): string {
    const parts = this.formatterFor(timeZone).formatToParts(this.now());

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
   * The current hour of the local clock in `timeZone`, `0`-`23`.
   *
   * `calendarDateIn`'s companion derivation, and the question the hourly
   * practice reminder (`docs/specs/habit-streaks.md` §6) is built on: "whose
   * local hour, right now, equals the hour they asked to be reminded at". A
   * fixed daily cron structurally cannot answer that for more than one zone at
   * a time, and a caller that reached for `new Date().getHours()` would be
   * asking about the SERVER's hour -- which is the API container's zone, not
   * the learner's, and is unpinnable by `X-Test-Clock`.
   *
   * Throws `RangeError` for an unknown timezone, exactly as `calendarDateIn`
   * does and for the same reason: a silent fallback to UTC would send a
   * learner their reminder at somebody else's breakfast time.
   */
  localHourIn(timeZone: string): number {
    const parts = this.dateTimeFormatterFor(timeZone).formatToParts(this.now());
    const hour = parts.find((part) => part.type === 'hour')?.value;

    /* istanbul ignore next -- Intl always emits the parts we requested */
    if (hour === undefined) {
      throw new Error(`Intl did not return an "hour" part for ${timeZone}`);
    }

    // `hourCycle: 'h23'` is requested below, so midnight is "00" and never
    // "24" -- the one value `Number` would happily turn into an off-by-one
    // day. Parsed rather than compared as a string so callers get a number
    // they can compare to a stored `reminderHour`.
    return Number(hour);
  }

  /**
   * The UTC instant bounds of the CURRENT local calendar day in `timeZone`:
   * `[start, end)`.
   *
   * The range half of the same fact `calendarDateIn` returns as a string --
   * §3's local-day derivation applied to a query range instead of a stored
   * date. `docs/specs/habit-streaks.md` §6.3 needs exactly this to ask "has
   * this learner already been reminded today", against a
   * `notification_deliveries.created_at` column that stores instants, for a
   * learner whose "today" starts at a different instant from every learner in
   * another zone.
   *
   * DERIVED IN TWO PASSES, because the UTC offset that converts local midnight
   * to an instant is itself a function of the instant: the offset in effect
   * NOW is not necessarily the offset in effect at this morning's midnight
   * (that is what a DST transition during the day means). The first pass
   * guesses with the current offset, the second re-reads the offset at the
   * guessed instant and corrects it.
   *
   * Throws `RangeError` for an unknown timezone, as its two siblings do.
   */
  localDayRangeIn(timeZone: string): { start: Date; end: Date } {
    const today = this.calendarDateIn(timeZone);
    const startOfToday = Date.parse(`${today}T00:00:00.000Z`);

    return {
      start: this.instantAtLocalMidnight(startOfToday, timeZone),
      end: this.instantAtLocalMidnight(startOfToday + MS_PER_DAY, timeZone),
    };
  }

  /**
   * The instant at which the local clock in `timeZone` reads midnight on the
   * day `utcMidnight` names.
   *
   * `utcMidnight` is a wall-clock reading carried in a `Date` -- the
   * `YYYY-MM-DD` day at 00:00 as if it were UTC -- not an instant anybody is
   * claiming is correct. The two passes below turn it into the instant that
   * actually reads that way in `timeZone`.
   */
  private instantAtLocalMidnight(utcMidnight: number, timeZone: string): Date {
    const firstGuess = utcMidnight - this.offsetMsAt(new Date(utcMidnight), timeZone);
    const corrected = utcMidnight - this.offsetMsAt(new Date(firstGuess), timeZone);

    return new Date(corrected);
  }

  /**
   * How far ahead of UTC `timeZone` is at `instant`, in milliseconds.
   *
   * Read out of `Intl` rather than out of a table: the offset includes
   * whatever DST rule is in force at that instant, and the rules change by
   * legislation more often than a hard-coded table gets updated.
   */
  private offsetMsAt(instant: Date, timeZone: string): number {
    const parts = this.dateTimeFormatterFor(timeZone).formatToParts(instant);

    const part = (type: Intl.DateTimeFormatPartTypes): number => {
      const found = parts.find((p) => p.type === type);
      /* istanbul ignore next -- Intl always emits the parts we requested */
      if (!found) {
        throw new Error(`Intl did not return a "${type}" part for ${timeZone}`);
      }
      return Number(found.value);
    };

    const asIfUtc = Date.UTC(
      part('year'),
      part('month') - 1,
      part('day'),
      part('hour'),
      part('minute'),
      part('second'),
    );

    // Milliseconds are not in the formatted parts, so both sides are truncated
    // to the second before subtracting -- otherwise a non-zero millisecond
    // component of `instant` would show up as a bogus sub-second "offset".
    return asIfUtc - Math.floor(instant.getTime() / 1000) * 1000;
  }

  private formatterFor(timeZone: string): Intl.DateTimeFormat {
    const cached = this.formatters.get(timeZone);
    if (cached) {
      return cached;
    }

    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    this.formatters.set(timeZone, formatter);
    return formatter;
  }

  private dateTimeFormatterFor(timeZone: string): Intl.DateTimeFormat {
    const cached = this.dateTimeFormatters.get(timeZone);
    if (cached) {
      return cached;
    }

    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      // `h23`, not `hour12: false` alone: some engines render midnight as
      // "24" under `hourCycle: 'h24'`, which would make `localHourIn` return
      // 24 for a learner who asked to be reminded at hour 0.
      hourCycle: 'h23',
    });
    this.dateTimeFormatters.set(timeZone, formatter);
    return formatter;
  }
}
