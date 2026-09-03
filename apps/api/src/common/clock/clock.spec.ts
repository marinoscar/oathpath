import { Clock, clockOverrideStorage } from './clock';

/** Yields to the macrotask queue, forcing the two contexts below to interleave. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('Clock', () => {
  let clock: Clock;

  beforeEach(() => {
    clock = new Clock();
  });

  describe('now() without an override', () => {
    it('returns real wall-clock time', () => {
      const before = Date.now();
      const observed = clock.now().getTime();
      const after = Date.now();

      expect(observed).toBeGreaterThanOrEqual(before);
      expect(observed).toBeLessThanOrEqual(after);
    });

    it('returns a Date, advancing as real time does', async () => {
      const first = clock.now();
      await tick();
      const second = clock.now();

      expect(first).toBeInstanceOf(Date);
      expect(second.getTime()).toBeGreaterThanOrEqual(first.getTime());
    });
  });

  describe('now() inside an override', () => {
    const pinned = new Date('2026-01-15T09:00:00.000Z');

    it('returns the pinned instant', () => {
      clockOverrideStorage.run({ now: pinned }, () => {
        expect(clock.now().toISOString()).toBe('2026-01-15T09:00:00.000Z');
      });
    });

    it('keeps the pinned instant across awaits inside the same context', async () => {
      await clockOverrideStorage.run({ now: pinned }, async () => {
        expect(clock.now().getTime()).toBe(pinned.getTime());
        await tick();
        expect(clock.now().getTime()).toBe(pinned.getTime());
        await tick();
        expect(clock.now().getTime()).toBe(pinned.getTime());
      });
    });

    it('returns a copy, so a caller cannot mutate the override', () => {
      clockOverrideStorage.run({ now: pinned }, () => {
        const first = clock.now();
        first.setFullYear(1999);

        expect(clock.now().toISOString()).toBe('2026-01-15T09:00:00.000Z');
      });

      // ...and the caller's own Date is untouched by the store, either way.
      expect(pinned.toISOString()).toBe('2026-01-15T09:00:00.000Z');
    });
  });

  describe('override isolation', () => {
    it('does not leak between two overlapping async contexts', async () => {
      const alpha = new Date('2020-03-01T00:00:00.000Z');
      const beta = new Date('2031-11-30T12:00:00.000Z');

      const observedByAlpha: string[] = [];
      const observedByBeta: string[] = [];

      const runAlpha = clockOverrideStorage.run({ now: alpha }, async () => {
        observedByAlpha.push(clock.now().toISOString());
        await tick();
        observedByAlpha.push(clock.now().toISOString());
        await tick();
        observedByAlpha.push(clock.now().toISOString());
      });

      const runBeta = clockOverrideStorage.run({ now: beta }, async () => {
        observedByBeta.push(clock.now().toISOString());
        await tick();
        observedByBeta.push(clock.now().toISOString());
        await tick();
        observedByBeta.push(clock.now().toISOString());
      });

      // Started before either finished: their awaits interleave.
      await Promise.all([runAlpha, runBeta]);

      expect(observedByAlpha).toEqual([
        '2020-03-01T00:00:00.000Z',
        '2020-03-01T00:00:00.000Z',
        '2020-03-01T00:00:00.000Z',
      ]);
      expect(observedByBeta).toEqual([
        '2031-11-30T12:00:00.000Z',
        '2031-11-30T12:00:00.000Z',
        '2031-11-30T12:00:00.000Z',
      ]);
    });

    it('does not leak from an override into an unwrapped context that awaits alongside it', async () => {
      const pinned = new Date('2020-03-01T00:00:00.000Z');
      const observedOutside: number[] = [];

      const inside = clockOverrideStorage.run({ now: pinned }, async () => {
        await tick();
        await tick();
        return clock.now().getTime();
      });

      const outside = (async () => {
        observedOutside.push(clock.now().getTime());
        await tick();
        observedOutside.push(clock.now().getTime());
      })();

      const [insideResult] = await Promise.all([inside, outside]);

      expect(insideResult).toBe(pinned.getTime());
      for (const observed of observedOutside) {
        expect(observed).toBeGreaterThan(pinned.getTime());
        expect(Math.abs(observed - Date.now())).toBeLessThan(5_000);
      }
    });

    it('reports real time again once the override context has completed', async () => {
      const pinned = new Date('2020-03-01T00:00:00.000Z');

      await clockOverrideStorage.run({ now: pinned }, async () => {
        await tick();
        expect(clock.now().getTime()).toBe(pinned.getTime());
      });

      expect(clockOverrideStorage.getStore()).toBeUndefined();
      expect(Math.abs(clock.now().getTime() - Date.now())).toBeLessThan(1_000);
    });

    it('restores the outer override when a nested one completes', () => {
      const outer = new Date('2020-03-01T00:00:00.000Z');
      const inner = new Date('2031-11-30T12:00:00.000Z');

      clockOverrideStorage.run({ now: outer }, () => {
        expect(clock.now().getTime()).toBe(outer.getTime());

        clockOverrideStorage.run({ now: inner }, () => {
          expect(clock.now().getTime()).toBe(inner.getTime());
        });

        expect(clock.now().getTime()).toBe(outer.getTime());
      });
    });
  });

  describe('localHourIn()', () => {
    // The derivation the hourly practice reminder is built on
    // (`docs/specs/habit-streaks.md` §6): "whose local hour, right now, equals
    // the hour they chose". One instant, three answers.
    it('reports a different hour per zone for the SAME instant', () => {
      const instant = new Date('2026-01-15T00:00:00.000Z');

      clockOverrideStorage.run({ now: instant }, () => {
        expect(clock.localHourIn('Asia/Tokyo')).toBe(9);
        expect(clock.localHourIn('UTC')).toBe(0);
        expect(clock.localHourIn('America/Los_Angeles')).toBe(16);
      });
    });

    it('reports midnight as 0 and never as 24', () => {
      // `hourCycle: 'h23'`, and the reason it is pinned: a `24` here would
      // mean a learner who chose hour 0 is never selected at all.
      const instant = new Date('2026-01-15T00:00:00.000Z');

      clockOverrideStorage.run({ now: instant }, () => {
        expect(clock.localHourIn('UTC')).toBe(0);
      });
    });

    it('reports 23 an hour before midnight', () => {
      const instant = new Date('2026-01-15T23:30:00.000Z');

      clockOverrideStorage.run({ now: instant }, () => {
        expect(clock.localHourIn('UTC')).toBe(23);
      });
    });

    it('accounts for daylight saving time in the named zone', () => {
      // 2026-07-15T16:00:00Z is 09:00 PDT (UTC-7); the same wall-clock hour in
      // January is 17:00Z (UTC-8).
      clockOverrideStorage.run({ now: new Date('2026-07-15T16:00:00.000Z') }, () => {
        expect(clock.localHourIn('America/Los_Angeles')).toBe(9);
      });
      clockOverrideStorage.run({ now: new Date('2026-01-15T17:00:00.000Z') }, () => {
        expect(clock.localHourIn('America/Los_Angeles')).toBe(9);
      });
    });

    it('rejects an unknown timezone rather than quietly falling back to UTC', () => {
      expect(() => clock.localHourIn('Mars/Olympus_Mons')).toThrow(RangeError);
    });
  });

  describe('localDayRangeIn()', () => {
    it('brackets the current local day in UTC instants', () => {
      // 09:00 Jan 15 in Tokyo. Tokyo's day started at 15:00Z on Jan 14 and
      // ends at 15:00Z on Jan 15.
      clockOverrideStorage.run({ now: new Date('2026-01-15T00:00:00.000Z') }, () => {
        const { start, end } = clock.localDayRangeIn('Asia/Tokyo');

        expect(start.toISOString()).toBe('2026-01-14T15:00:00.000Z');
        expect(end.toISOString()).toBe('2026-01-15T15:00:00.000Z');
      });
    });

    it('brackets a different window for a different zone at the same instant', () => {
      clockOverrideStorage.run({ now: new Date('2026-01-15T00:00:00.000Z') }, () => {
        const tokyo = clock.localDayRangeIn('Asia/Tokyo');
        const la = clock.localDayRangeIn('America/Los_Angeles');

        // Same instant, two different local days — the whole reason the
        // "already reminded today" query cannot use a UTC day.
        expect(la.start.toISOString()).toBe('2026-01-14T08:00:00.000Z');
        expect(la.end.toISOString()).toBe('2026-01-15T08:00:00.000Z');
        expect(tokyo.start.getTime()).not.toBe(la.start.getTime());
      });
    });

    it('contains the current instant, and is exactly one day long outside a DST shift', () => {
      const instant = new Date('2026-01-15T12:34:56.000Z');

      clockOverrideStorage.run({ now: instant }, () => {
        const { start, end } = clock.localDayRangeIn('Europe/Berlin');

        expect(start.getTime()).toBeLessThanOrEqual(instant.getTime());
        expect(end.getTime()).toBeGreaterThan(instant.getTime());
        expect(end.getTime() - start.getTime()).toBe(86_400_000);
      });
    });

    it('is 23 hours long on a spring-forward day, and 25 on a fall-back day', () => {
      // The two-pass offset correction, asserted where a single pass would be
      // wrong: the offset in effect NOW is not the offset in effect at this
      // morning's midnight.
      clockOverrideStorage.run({ now: new Date('2026-03-08T20:00:00.000Z') }, () => {
        const { start, end } = clock.localDayRangeIn('America/Los_Angeles');
        expect(end.getTime() - start.getTime()).toBe(23 * 3_600_000);
      });

      clockOverrideStorage.run({ now: new Date('2026-11-01T20:00:00.000Z') }, () => {
        const { start, end } = clock.localDayRangeIn('America/Los_Angeles');
        expect(end.getTime() - start.getTime()).toBe(25 * 3_600_000);
      });
    });

    it('starts on the same local day calendarDateIn reports', () => {
      // 23:30Z on Jan 15 is already Jan 16 in Tokyo. The range must bracket
      // THAT day, not the UTC one — the two derivations answering differently
      // is precisely how a learner gets reminded twice.
      const instant = new Date('2026-01-15T23:30:00.000Z');

      const today = clockOverrideStorage.run({ now: instant }, () =>
        clock.calendarDateIn('Asia/Tokyo'),
      );
      const { start } = clockOverrideStorage.run({ now: instant }, () =>
        clock.localDayRangeIn('Asia/Tokyo'),
      );

      expect(today).toBe('2026-01-16');
      clockOverrideStorage.run({ now: start }, () => {
        expect(clock.calendarDateIn('Asia/Tokyo')).toBe(today);
      });
    });

    it('rejects an unknown timezone', () => {
      expect(() => clock.localDayRangeIn('Mars/Olympus_Mons')).toThrow(RangeError);
    });
  });

  describe('calendarDateIn()', () => {
    it('returns the local calendar date on the earlier side of a day boundary', () => {
      // 19:30 on Jan 15 in Los Angeles (UTC-8) is already Jan 16 in UTC.
      const instant = new Date('2026-01-16T03:30:00.000Z');

      clockOverrideStorage.run({ now: instant }, () => {
        expect(clock.calendarDateIn('America/Los_Angeles')).toBe('2026-01-15');
        expect(clock.calendarDateIn('UTC')).toBe('2026-01-16');
      });
    });

    it('returns the local calendar date on the later side of a day boundary', () => {
      // 08:00 on Jan 16 in Tokyo (UTC+9) is still Jan 15 in UTC.
      const instant = new Date('2026-01-15T23:00:00.000Z');

      clockOverrideStorage.run({ now: instant }, () => {
        expect(clock.calendarDateIn('Asia/Tokyo')).toBe('2026-01-16');
        expect(clock.calendarDateIn('UTC')).toBe('2026-01-15');
        expect(clock.calendarDateIn('America/Los_Angeles')).toBe('2026-01-15');
      });
    });

    it('zero-pads month and day to a Prisma @db.Date-shaped string', () => {
      const instant = new Date('2026-03-07T12:00:00.000Z');

      clockOverrideStorage.run({ now: instant }, () => {
        expect(clock.calendarDateIn('UTC')).toBe('2026-03-07');
      });
    });

    it('accounts for daylight saving time in the named zone', () => {
      // 2026-03-08T09:30:00Z is 01:30 PST; DST starts at 02:00 local that day.
      const beforeDst = new Date('2026-03-08T09:30:00.000Z');
      // 2026-11-01T08:30:00Z is 01:30 PDT, before the fall-back to PST.
      const beforeFallBack = new Date('2026-11-01T08:30:00.000Z');

      clockOverrideStorage.run({ now: beforeDst }, () => {
        expect(clock.calendarDateIn('America/Los_Angeles')).toBe('2026-03-08');
      });
      clockOverrideStorage.run({ now: beforeFallBack }, () => {
        expect(clock.calendarDateIn('America/Los_Angeles')).toBe('2026-11-01');
      });
    });

    it('follows real time when there is no override', () => {
      const expected = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'UTC',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date());

      expect(clock.calendarDateIn('UTC')).toBe(expected);
    });

    it('rejects an unknown timezone rather than quietly falling back to UTC', () => {
      expect(() => clock.calendarDateIn('Mars/Olympus_Mons')).toThrow(RangeError);
    });

    it('reuses a cached formatter for a repeated timezone', () => {
      const instant = new Date('2026-01-16T03:30:00.000Z');

      clockOverrideStorage.run({ now: instant }, () => {
        expect(clock.calendarDateIn('America/Los_Angeles')).toBe('2026-01-15');
        expect(clock.calendarDateIn('America/Los_Angeles')).toBe('2026-01-15');
        expect(clock.calendarDateIn('America/Los_Angeles')).toBe('2026-01-15');
      });
    });
  });
});
