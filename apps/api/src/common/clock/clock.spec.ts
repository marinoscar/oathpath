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
