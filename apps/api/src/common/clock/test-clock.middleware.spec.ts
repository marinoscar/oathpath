import { BadRequestException } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { Clock, clockOverrideStorage } from './clock';
import { TEST_CLOCK_HEADER, TestClockMiddleware } from './test-clock.middleware';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const request = (headers: Record<string, string | string[]>) =>
  ({ headers }) as unknown as IncomingMessage;

const response = () => ({}) as unknown as ServerResponse;

describe('TestClockMiddleware', () => {
  let middleware: TestClockMiddleware;
  let clock: Clock;

  beforeEach(() => {
    middleware = new TestClockMiddleware();
    clock = new Clock();
  });

  afterEach(() => {
    // Nothing may survive a test. If it did, the store would be the leak.
    expect(clockOverrideStorage.getStore()).toBeUndefined();
  });

  describe('without the header', () => {
    it('calls next() and enters nothing into the store', () => {
      let observedStore: unknown = 'not-read';
      const next = jest.fn(() => {
        observedStore = clockOverrideStorage.getStore();
      });

      middleware.use(request({}), response(), next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(observedStore).toBeUndefined();
    });

    it('leaves the Clock on real wall-clock time', () => {
      let observed = 0;
      middleware.use(request({}), response(), () => {
        observed = clock.now().getTime();
      });

      expect(Math.abs(observed - Date.now())).toBeLessThan(1_000);
    });
  });

  describe('with a valid header', () => {
    it('pins the Clock to the header instant for the rest of the request', () => {
      let observed = '';

      middleware.use(
        request({ [TEST_CLOCK_HEADER]: '2026-01-15T09:00:00Z' }),
        response(),
        () => {
          observed = clock.now().toISOString();
        },
      );

      expect(observed).toBe('2026-01-15T09:00:00.000Z');
    });

    it.each([
      ['Z, seconds omitted', '2026-01-15T09:00Z', '2026-01-15T09:00:00.000Z'],
      ['lowercase designators', '2026-01-15t09:00:00z', '2026-01-15T09:00:00.000Z'],
      ['milliseconds', '2026-01-15T09:00:00.250Z', '2026-01-15T09:00:00.250Z'],
      ['negative offset', '2026-01-15T01:00:00-08:00', '2026-01-15T09:00:00.000Z'],
      ['positive offset', '2026-01-15T18:00:00+09:00', '2026-01-15T09:00:00.000Z'],
      ['a leap day', '2028-02-29T09:00:00Z', '2028-02-29T09:00:00.000Z'],
    ])('accepts %s', (_label, header, expected) => {
      let observed = '';

      middleware.use(request({ [TEST_CLOCK_HEADER]: header }), response(), () => {
        observed = clock.now().toISOString();
      });

      expect(observed).toBe(expected);
    });

    it('holds the pinned instant across awaits inside the request', async () => {
      const observed: string[] = [];
      let handled: Promise<void> = Promise.resolve();

      middleware.use(
        request({ [TEST_CLOCK_HEADER]: '2026-01-15T09:00:00Z' }),
        response(),
        () => {
          handled = (async () => {
            observed.push(clock.now().toISOString());
            await tick();
            observed.push(clock.now().toISOString());
            await tick();
            observed.push(clock.now().toISOString());
          })();
        },
      );

      await handled;

      expect(observed).toEqual([
        '2026-01-15T09:00:00.000Z',
        '2026-01-15T09:00:00.000Z',
        '2026-01-15T09:00:00.000Z',
      ]);
    });
  });

  describe('isolation between requests', () => {
    it('gives two concurrent, interleaved requests only their own instant', async () => {
      const observed: Record<string, string[]> = { first: [], second: [] };

      const dispatch = (label: string, header: string): Promise<void> => {
        let handled: Promise<void> = Promise.resolve();

        middleware.use(request({ [TEST_CLOCK_HEADER]: header }), response(), () => {
          handled = (async () => {
            observed[label].push(clock.now().toISOString());
            await tick();
            observed[label].push(clock.now().toISOString());
            await tick();
            observed[label].push(clock.now().toISOString());
          })();
        });

        return handled;
      };

      // Both are in flight before either resolves, so their awaits interleave.
      const first = dispatch('first', '2020-03-01T00:00:00Z');
      const second = dispatch('second', '2031-11-30T12:00:00Z');
      await Promise.all([first, second]);

      expect(observed.first).toEqual([
        '2020-03-01T00:00:00.000Z',
        '2020-03-01T00:00:00.000Z',
        '2020-03-01T00:00:00.000Z',
      ]);
      expect(observed.second).toEqual([
        '2031-11-30T12:00:00.000Z',
        '2031-11-30T12:00:00.000Z',
        '2031-11-30T12:00:00.000Z',
      ]);
    });

    it('does not leak a pinned instant into a concurrent request that sent no header', async () => {
      const pinnedObserved: string[] = [];
      const unpinnedObserved: number[] = [];
      let pinnedHandled: Promise<void> = Promise.resolve();
      let unpinnedHandled: Promise<void> = Promise.resolve();

      middleware.use(
        request({ [TEST_CLOCK_HEADER]: '2020-03-01T00:00:00Z' }),
        response(),
        () => {
          pinnedHandled = (async () => {
            await tick();
            pinnedObserved.push(clock.now().toISOString());
            await tick();
            pinnedObserved.push(clock.now().toISOString());
          })();
        },
      );

      middleware.use(request({}), response(), () => {
        unpinnedHandled = (async () => {
          unpinnedObserved.push(clock.now().getTime());
          await tick();
          unpinnedObserved.push(clock.now().getTime());
        })();
      });

      await Promise.all([pinnedHandled, unpinnedHandled]);

      expect(pinnedObserved).toEqual([
        '2020-03-01T00:00:00.000Z',
        '2020-03-01T00:00:00.000Z',
      ]);
      for (const observed of unpinnedObserved) {
        expect(Math.abs(observed - Date.now())).toBeLessThan(5_000);
      }
    });

    it('reports real time again on the next request after a pinned one', () => {
      middleware.use(
        request({ [TEST_CLOCK_HEADER]: '2020-03-01T00:00:00Z' }),
        response(),
        () => {
          expect(clock.now().toISOString()).toBe('2020-03-01T00:00:00.000Z');
        },
      );

      let observed = 0;
      middleware.use(request({}), response(), () => {
        observed = clock.now().getTime();
      });

      expect(Math.abs(observed - Date.now())).toBeLessThan(1_000);
      expect(clockOverrideStorage.getStore()).toBeUndefined();
    });
  });

  describe('with a malformed header', () => {
    const malformed: [string, string][] = [
      ['an empty value', ''],
      ['whitespace', '   '],
      ['prose', 'yesterday'],
      // `new Date()` coerces this one to `Invalid Date` without complaint.
      ['a non-date string', 'not-a-date'],
      // `new Date()` happily accepts these, which is exactly the problem: a
      // locale-dependent or timezone-dependent parse is not a pinned instant.
      ['a US-style date', '01/15/2026'],
      ['an RFC 1123 date', 'Thu, 15 Jan 2026 09:00:00 GMT'],
      ['a date with no time', '2026-01-15'],
      ['a local time with no zone designator', '2026-01-15T09:00:00'],
      ['epoch seconds', '1768467600'],
      ['epoch milliseconds', '1768467600000'],
      // Shapes `Date` silently rolls over instead of rejecting.
      ['a day past the end of the month', '2026-02-31T00:00:00Z'],
      ['a non-leap February 29th', '2026-02-29T00:00:00Z'],
      ['month 13', '2026-13-01T00:00:00Z'],
      ['day 00', '2026-01-00T00:00:00Z'],
      ['hour 24', '2026-01-15T24:00:00Z'],
      ['minute 60', '2026-01-15T09:60:00Z'],
      ['second 60', '2026-01-15T09:00:60Z'],
      ['a bare offset sign', '2026-01-15T09:00:00+'],
      ['an offset without minutes', '2026-01-15T09:00:00+08'],
      ['trailing junk', '2026-01-15T09:00:00Z junk'],
    ];

    it.each(malformed)('rejects %s with 400', (_label, header) => {
      const next = jest.fn();

      expect(() =>
        middleware.use(request({ [TEST_CLOCK_HEADER]: header }), response(), next),
      ).toThrow(BadRequestException);

      // The critical half of the assertion: it must not fall through to real
      // time. A test asserting against a wrong time it believes is a pinned
      // time is worse than a failing request.
      expect(next).not.toHaveBeenCalled();
      expect(clockOverrideStorage.getStore()).toBeUndefined();
    });

    it('rejects a repeated header rather than picking one of two instants', () => {
      const next = jest.fn();

      expect(() =>
        middleware.use(
          request({
            [TEST_CLOCK_HEADER]: ['2020-03-01T00:00:00Z', '2031-11-30T12:00:00Z'],
          }),
          response(),
          next,
        ),
      ).toThrow(BadRequestException);

      expect(next).not.toHaveBeenCalled();
    });

    it('names the header and the expected shape in the 400', () => {
      let thrown: BadRequestException | undefined;

      try {
        middleware.use(
          request({ [TEST_CLOCK_HEADER]: 'not-a-date' }),
          response(),
          jest.fn(),
        );
      } catch (error) {
        thrown = error as BadRequestException;
      }

      expect(thrown).toBeInstanceOf(BadRequestException);
      expect(thrown?.getStatus()).toBe(400);
      expect(thrown?.message).toContain(TEST_CLOCK_HEADER);
      expect(thrown?.message).toContain('ISO-8601');
    });
  });
});
