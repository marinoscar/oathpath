import { Clock } from '../src/common/clock/clock';
import { createTestApp, TestContext } from './helpers/test-app.helper';

/**
 * `X-Test-Clock` through the real Fastify stack.
 *
 * The unit specs beside the middleware assert what `use()` does when called
 * directly. They structurally cannot catch what the *framework* does with the
 * result, and that is where the original defect lived: the middleware throws a
 * `BadRequestException`, which under the Fastify adapter reaches
 * `HttpExceptionFilter` holding a raw Node `ServerResponse` rather than a
 * Fastify reply. `response.code(...)` does not exist on it, so the filter threw
 * `TypeError`, nothing was written to the socket, and a typo'd header hung the
 * request until the client gave up -- no status, no error, no clue.
 *
 * That is fixed in the filter itself now (#183) rather than worked around
 * here, and `middleware-exception.integration.spec.ts` covers the general
 * case. This suite remains the regression test for the clock header
 * specifically: every case asserts a real status code off a real response, so
 * a regression in the filter's raw-response branch fails loudly here instead
 * of hanging.
 */
describe('X-Test-Clock over HTTP (Fastify adapter)', () => {
  /** A test-only probe: nothing in the app reads the Clock yet (#65 is first). */
  const PROBE = '/api/__clock-probe';

  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp({
      useMockDatabase: true,
      registerRoutes: (app) => {
        const clock = app.get(Clock);
        app.getHttpAdapter().getInstance().get(PROBE, async () => ({
          now: clock.now().toISOString(),
          losAngelesDate: clock.calendarDateIn('America/Los_Angeles'),
        }));
      },
    });
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  /**
   * Every request goes through this, so a hang can never pass as a success:
   * `app.inject` that never settles loses the race and fails with a message
   * naming the defect, rather than idling until Jest's own timeout.
   */
  const inject = async (headers: Record<string, string | string[]>) => {
    const responded = ctx.app.inject({ method: 'GET', url: PROBE, headers });
    const hung = new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              'Request never produced a response — HttpExceptionFilter is failing to write the middleware rejection (see #183).',
            ),
          ),
        5_000,
      ).unref(),
    );

    return Promise.race([responded, hung]);
  };

  describe('rejections', () => {
    it.each([
      ['a non-date string', 'not-a-date'],
      ['a calendar-invalid date Date would roll over', '2026-02-31T00:00:00Z'],
      ['a local time with no zone designator', '2026-01-15T09:00:00'],
      ['a US-style date', '01/15/2026'],
      ['an empty value', ''],
    ])('answers 400 for %s', async (_label, header) => {
      const res = await inject({ 'x-test-clock': header });

      expect(res.statusCode).toBe(400);
      expect(res.headers['content-type']).toContain('application/json');
    });

    it('returns the same error envelope as every other 400 in the API', async () => {
      const res = await inject({ 'x-test-clock': 'not-a-date' });

      expect(JSON.parse(res.body)).toEqual({
        statusCode: 400,
        code: 'BAD_REQUEST',
        message: expect.stringContaining('x-test-clock'),
        timestamp: expect.any(String),
        path: PROBE,
      });
    });

    it('answers 400 for a repeated x-test-clock header', async () => {
      const res = await inject({
        'x-test-clock': ['2020-03-01T00:00:00Z', '2031-11-30T12:00:00Z'],
      });

      // Node joins duplicates of any header but `set-cookie` into one
      // comma-separated string, so this arrives as a malformed value rather
      // than through the middleware's `Array.isArray` guard -- which is why
      // that guard is documented there as defensive. What matters on the wire
      // is identical: a 400, never a coin-flip between the two instants.
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toMatchObject({ code: 'BAD_REQUEST' });
      expect(JSON.parse(res.body).now).toBeUndefined();
    });

    it('does not fall through to the handler when it rejects', async () => {
      const res = await inject({ 'x-test-clock': 'not-a-date' });

      // If the request had reached the probe, the body would carry `now`.
      expect(JSON.parse(res.body)).not.toHaveProperty('now');
    });
  });

  describe('acceptance', () => {
    it('answers 200 and pins the clock for a well-formed instant', async () => {
      const res = await inject({ 'x-test-clock': '2026-01-16T03:30:00Z' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({
        now: '2026-01-16T03:30:00.000Z',
        // The same instant is already the 16th in UTC — the day-boundary case,
        // proven here through the real stack rather than only in a unit test.
        losAngelesDate: '2026-01-15',
      });
    });

    it('answers 200 and reports real time when no header is sent', async () => {
      const res = await inject({});

      expect(res.statusCode).toBe(200);
      const { now } = JSON.parse(res.body);
      expect(Math.abs(new Date(now).getTime() - Date.now())).toBeLessThan(5_000);
    });

    it('does not leak a pinned instant into the next request', async () => {
      const pinned = await inject({ 'x-test-clock': '2020-03-01T00:00:00Z' });
      expect(JSON.parse(pinned.body).now).toBe('2020-03-01T00:00:00.000Z');

      const after = await inject({});
      const { now } = JSON.parse(after.body);
      expect(Math.abs(new Date(now).getTime() - Date.now())).toBeLessThan(5_000);
    });

    it('gives concurrent in-flight requests only their own instant', async () => {
      const [first, second, unpinned] = await Promise.all([
        inject({ 'x-test-clock': '2020-03-01T00:00:00Z' }),
        inject({ 'x-test-clock': '2031-11-30T12:00:00Z' }),
        inject({}),
      ]);

      expect(JSON.parse(first.body).now).toBe('2020-03-01T00:00:00.000Z');
      expect(JSON.parse(second.body).now).toBe('2031-11-30T12:00:00.000Z');
      expect(
        Math.abs(new Date(JSON.parse(unpinned.body).now).getTime() - Date.now()),
      ).toBeLessThan(5_000);
    });
  });

  describe('a normal endpoint', () => {
    it('still serves requests carrying a valid header', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/health/live',
        headers: { 'x-test-clock': '2026-01-15T09:00:00Z' },
      });

      expect(res.statusCode).toBe(200);
    });

    it('rejects a malformed header before reaching the handler', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/health/live',
        headers: { 'x-test-clock': 'not-a-date' },
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).path).toBe('/api/health/live');
    });
  });
});
