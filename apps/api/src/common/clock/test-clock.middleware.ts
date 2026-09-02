import { HttpStatus, Injectable, NestMiddleware } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { ErrorResponse } from '../filters/http-exception.filter';
import { clockOverrideStorage } from './clock';

export const TEST_CLOCK_HEADER = 'x-test-clock';

/**
 * A strict ISO-8601 instant: a date, a time, and a zone designator (`Z` or a
 * numeric offset). Capture groups feed the range checks in
 * {@link parseIsoInstant}; the shape alone is not enough.
 *
 * The offset is required on purpose. `new Date('2026-01-15T09:00:00')` -- no
 * designator -- is interpreted in the *server's* local timezone, so the same
 * header would pin a different instant on a developer's laptop than in CI.
 * That is exactly the class of quietly-wrong time this provider exists to
 * eliminate, so it is rejected rather than guessed at.
 */
const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/;

/**
 * Reads the `X-Test-Clock` header and runs the rest of the request with that
 * instant pinned.
 *
 * This middleware is registered by `ClockModule` **only when `NODE_ENV` is not
 * `production`** -- in production the code path is absent, not
 * present-and-ignored, so the header is never read at all. That mirrors how
 * `AppModule` conditionally registers `TestAuthModule` and how
 * `TestEnvironmentGuard` gates `/testing/login`.
 */
@Injectable()
export class TestClockMiddleware implements NestMiddleware {
  // NestJS middleware under the Fastify adapter receives raw Node objects.
  use(req: IncomingMessage, res: ServerResponse, next: () => void): void {
    const raw = req.headers[TEST_CLOCK_HEADER];

    // No header: nothing is entered into the store, and `Clock` reports real
    // wall-clock time. This is the only path production would ever take.
    if (raw === undefined) {
      next();
      return;
    }

    // A repeated header is ambiguous -- two different pinned instants with no
    // principled way to choose. Reject rather than pick one.
    //
    // In practice Node reaches the same verdict one step earlier: for every
    // header but `set-cookie` it joins duplicates into a single
    // comma-separated string, which fails the ISO parse below and is rejected
    // as malformed. So this branch is a defensive guard on a shape the types
    // permit rather than the path a duplicate header usually takes -- both end
    // at the same `reject`, and a duplicate header is a 400 either way.
    if (Array.isArray(raw)) {
      this.reject(req, res, `${TEST_CLOCK_HEADER} must be sent at most once`);
      return;
    }

    const parsed = parseIsoInstant(raw);

    // A malformed value is never a silent fallback to real time. A test
    // asserting against a wrong time it believes is a pinned time is worse
    // than a failing request.
    if (parsed === null) {
      this.reject(
        req,
        res,
        `${TEST_CLOCK_HEADER} must be an ISO-8601 instant with a zone designator, e.g. 2026-01-15T09:00:00Z`,
      );
      return;
    }

    // The remainder of the request runs inside the store, so the override
    // lives exactly as long as this request's async context.
    clockOverrideStorage.run({ now: parsed }, next);
  }

  /**
   * Writes the 400 directly and does not call `next()`.
   *
   * **This deliberately does not `throw new BadRequestException(...)`, unlike
   * every other input rejection in this codebase. Do not "fix" it back into a
   * throw.**
   *
   * Under the Fastify adapter, an exception thrown from *middleware* -- as
   * opposed to from a guard, pipe, controller or interceptor -- reaches
   * `HttpExceptionFilter` with the raw Node `ServerResponse` in the arguments
   * host, not a Fastify reply. The filter's last line is
   * `response.code(status).send(...)`, and `ServerResponse` has no `.code()`,
   * so the filter itself throws `TypeError: response.code is not a function`.
   * Nothing is ever written to the socket and the request hangs until the
   * client times out.
   *
   * A hang is a far worse outcome than the 500 it looks like it should have
   * been: a developer who typo'd the header would get no error at all, which
   * is precisely the silently-wrong failure this provider exists to eliminate.
   *
   * So the envelope is built here, matching `HttpExceptionFilter`'s
   * `ErrorResponse` exactly -- same fields, and `code: 'BAD_REQUEST'` from the
   * filter's own status mapping -- so this response is indistinguishable from
   * every other 400 the API returns. The shape is imported rather than
   * retyped, so a change to the envelope breaks this build too.
   */
  private reject(
    req: IncomingMessage,
    res: ServerResponse,
    message: string,
  ): void {
    const body: ErrorResponse = {
      statusCode: HttpStatus.BAD_REQUEST,
      code: 'BAD_REQUEST',
      message,
      timestamp: new Date().toISOString(),
      path: originalUrlOf(req),
    };

    res.statusCode = HttpStatus.BAD_REQUEST;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(body));
  }
}

/**
 * The request path as `HttpExceptionFilter` would report it.
 *
 * `req.url` is not it: Nest mounts middleware through middie, which rewrites
 * `url` relative to the mount point, so a rejected `GET /api/health/live`
 * arrives here as `/`. Middie preserves the real path on `originalUrl`, which
 * is what the filter's Fastify request would have carried. Without this the
 * envelope would be the right shape with the wrong `path` -- the sort of
 * detail that makes a debugging session longer than it needed to be.
 */
function originalUrlOf(req: IncomingMessage): string {
  const { originalUrl } = req as IncomingMessage & { originalUrl?: string };
  return originalUrl ?? req.url ?? '';
}

function parseIsoInstant(value: string): Date | null {
  const match = ISO_INSTANT.exec(value);
  if (!match) {
    return null;
  }

  // Optional groups are `undefined` at runtime even though the array type says
  // otherwise; absent seconds and an absent offset both mean zero.
  const n = (index: number): number => {
    const part: string | undefined = match[index];
    return part === undefined ? 0 : Number(part);
  };

  const [year, month, day, hour, minute, second] = [1, 2, 3, 4, 5, 6].map(n);
  const [offsetHour, offsetMinute] = [8, 9].map(n);

  // Every field is range-checked by hand, because `Date` is not strict enough
  // to be trusted here. `new Date('2026-02-31T00:00:00Z')` does not produce an
  // `Invalid Date` -- it silently rolls the day over into March 3rd. Accepting
  // that would pin a test to an instant three days from the one it asked for,
  // which is the precise failure this header exists to make impossible.
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return null;
  }

  const parsed = new Date(value);

  /* istanbul ignore next -- the range checks above already reject every shape
     V8 would refuse, so this is a belt-and-braces guard only. */
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
}

function daysInMonth(year: number, month: number): number {
  const lengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month === 2 && isLeapYear(year)) {
    return 29;
  }
  return lengths[month - 1];
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}
