import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  MiddlewareConsumer,
  Module,
  NestMiddleware,
  NestModule,
} from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { createTestApp, TestContext } from './helpers/test-app.helper';

/**
 * Exceptions thrown from MIDDLEWARE, over the real Fastify stack (#183).
 *
 * `HttpExceptionFilter`'s unit spec drives the filter with a hand-made
 * `{ code, send }` reply, which is what the filter is handed for an exception
 * from a guard, pipe, interceptor or controller. It structurally cannot catch
 * the defect this suite exists for, because that defect is about the object
 * the FRAMEWORK hands the filter on a different path:
 *
 * Nest runs middleware through middie under the Fastify adapter, and when
 * middleware throws it builds the arguments host from the raw Node
 * `IncomingMessage`/`ServerResponse` (`MiddlewareModule`'s
 * `new ExecutionContextHost([req, res, next])`). `ServerResponse` has no
 * `.code()`, so `response.code(status).send(...)` made the filter itself throw
 * `TypeError`, nothing was ever written to the socket, and the request hung
 * until the client gave up — no status, no body, no clue, and a stack trace
 * pointing at a global filter the middleware's author never touched.
 *
 * So every case here goes over `app.inject` against a booted app, and every
 * case races the request against a short timer: a hang fails loudly, naming
 * the defect, instead of idling to Jest's own timeout thirty seconds later.
 * That race is the whole point of the suite — an assertion that never runs
 * because the request never settled proves nothing.
 */

const THROW_HEADER = 'x-throw-from-middleware';

/**
 * Throws on demand, from middleware.
 *
 * Header-driven rather than path-driven so the same registration covers every
 * case AND the pass-through case: proving the middleware is transparent when
 * it does not throw is what rules out "the 500s are just this middleware being
 * broken".
 */
@Injectable()
class ThrowingMiddleware implements NestMiddleware {
  use(req: IncomingMessage, _res: ServerResponse, next: () => void): void {
    switch (req.headers[THROW_HEADER]) {
      case 'http':
        throw new BadRequestException('middleware refused this request');

      case 'http-with-details':
        throw new HttpException(
          {
            message: 'middleware refused this request',
            details: { reason: 'because the test said so' },
          },
          HttpStatus.I_AM_A_TEAPOT,
        );

      // Not an `HttpException` at all. The filter's `@Catch()` is unqualified,
      // so this reaches exactly the same code — and a middleware is a very
      // ordinary place for an unplanned `TypeError` to come from, which is the
      // case that hung hardest before the fix.
      case 'plain-error':
        throw new Error('middleware exploded');

      default:
        next();
    }
  }
}

@Module({ providers: [ThrowingMiddleware] })
class ThrowingMiddlewareModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(ThrowingMiddleware).forRoutes('*');
  }
}

describe('Exceptions thrown from middleware (Fastify adapter)', () => {
  /**
   * A real, always-200 route with no database and no auth, so a non-200 here
   * can only have come from the middleware.
   */
  const ROUTE = '/api/health/live';

  /** With a query string, because `path` must survive one. */
  const ROUTE_WITH_QUERY = `${ROUTE}?probe=1`;

  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp({
      useMockDatabase: true,
      imports: [ThrowingMiddlewareModule],
    });
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  /**
   * Every request goes through this, so a hang can never pass as a failure to
   * assert: `app.inject` that never settles loses the race and fails with a
   * message naming the defect.
   */
  const inject = async (url: string, headers: Record<string, string> = {}) => {
    const responded = ctx.app.inject({ method: 'GET', url, headers });
    const hung = new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              `Request to ${url} never produced a response — HttpExceptionFilter is failing to write to the raw ServerResponse it gets when middleware throws (#183).`,
            ),
          ),
        5_000,
      ).unref(),
    );

    return Promise.race([responded, hung]);
  };

  describe('an HttpException', () => {
    it('answers with the exception status rather than hanging', async () => {
      const res = await inject(ROUTE, { [THROW_HEADER]: 'http' });

      expect(res.statusCode).toBe(400);
      expect(res.headers['content-type']).toContain('application/json');
    });

    it('answers with the standard error envelope, like every other 400', async () => {
      const res = await inject(ROUTE, { [THROW_HEADER]: 'http' });

      expect(JSON.parse(res.body)).toEqual({
        statusCode: 400,
        code: 'BAD_REQUEST',
        message: 'middleware refused this request',
        timestamp: expect.any(String),
        path: ROUTE,
      });
    });

    it('reports the original URL as `path`, not the middie-rewritten one', async () => {
      const res = await inject(ROUTE_WITH_QUERY, { [THROW_HEADER]: 'http' });

      // Middie rewrites `req.url` relative to the mount point, so before the
      // fix every middleware rejection in the application reported `path: "/"`
      // — the right envelope with the wrong URL, which is the sort of detail
      // that makes a debugging session longer than it needed to be.
      expect(JSON.parse(res.body).path).toBe(ROUTE_WITH_QUERY);
      expect(JSON.parse(res.body).path).not.toBe('/');
    });

    it('carries `details` and the status-derived code through', async () => {
      const res = await inject(ROUTE, { [THROW_HEADER]: 'http-with-details' });

      expect(res.statusCode).toBe(418);
      expect(JSON.parse(res.body)).toMatchObject({
        statusCode: 418,
        // 418 is not in the filter's code map, so it falls to the catch-all
        // published value — the same as it would from a controller.
        code: 'ERROR',
        message: 'middleware refused this request',
        details: { reason: 'because the test said so' },
      });
    });

    it('does not reach the handler', async () => {
      const res = await inject(ROUTE, { [THROW_HEADER]: 'http' });

      // The health route answers `{ data: { status: 'ok' }, meta }`; the
      // envelope must not be a body written on top of a handler that also ran.
      expect(JSON.parse(res.body).data).toBeUndefined();
    });
  });

  describe('a non-HttpException error', () => {
    it('answers 500 with the standard envelope rather than hanging', async () => {
      const res = await inject(ROUTE_WITH_QUERY, {
        [THROW_HEADER]: 'plain-error',
      });

      expect(res.statusCode).toBe(500);
      expect(res.headers['content-type']).toContain('application/json');
      expect(JSON.parse(res.body)).toMatchObject({
        statusCode: 500,
        code: 'INTERNAL_ERROR',
        message: 'middleware exploded',
        path: ROUTE_WITH_QUERY,
      });
    });
  });

  describe('the rest of the pipeline', () => {
    it('is untouched when the middleware does not throw', async () => {
      const res = await inject(ROUTE);

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({ data: { status: 'ok' } });
    });

    it('still answers a guard rejection through the Fastify reply', async () => {
      // The other branch of the same `send()`, in the same booted app: an
      // exception from a guard is handed a Fastify reply, and must still be
      // enveloped exactly as before.
      const res = await inject('/api/users');

      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body)).toMatchObject({
        statusCode: 401,
        code: 'UNAUTHORIZED',
        path: '/api/users',
      });
    });
  });
});
