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
}
