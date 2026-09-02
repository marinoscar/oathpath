import { BadRequestException, Injectable, NestMiddleware } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { clockOverrideStorage } from './clock';

export const TEST_CLOCK_HEADER = 'x-test-clock';

/**
 * A strict ISO-8601 instant: a date, a time, and a zone designator (`Z` or a
 * numeric offset).
 *
 * The offset is required on purpose. `new Date('2026-01-15T09:00:00')` -- no
 * designator -- is interpreted in the *server's* local timezone, so the same
 * header would pin a different instant on a developer's laptop than in CI.
 * That is exactly the class of quietly-wrong time this provider exists to
 * eliminate, so it is rejected rather than guessed at.
 */
const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?([Zz]|[+-]\d{2}:\d{2})$/;

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
  use(req: IncomingMessage, _res: ServerResponse, next: () => void): void {
    const raw = req.headers[TEST_CLOCK_HEADER];

    // No header: nothing is entered into the store, and `Clock` reports real
    // wall-clock time. This is the only path production would ever take.
    if (raw === undefined) {
      next();
      return;
    }

    // A repeated header is ambiguous -- two different pinned instants with no
    // principled way to choose. Reject rather than pick one.
    if (Array.isArray(raw)) {
      throw new BadRequestException(
        `${TEST_CLOCK_HEADER} must be sent at most once`,
      );
    }

    const parsed = parseIsoInstant(raw);

    // A malformed value is never a silent fallback to real time. A test
    // asserting against a wrong time it believes is a pinned time is worse
    // than a failing request.
    if (parsed === null) {
      throw new BadRequestException(
        `${TEST_CLOCK_HEADER} must be an ISO-8601 instant with a zone designator, e.g. 2026-01-15T09:00:00Z`,
      );
    }

    // The remainder of the request runs inside the store, so the override
    // lives exactly as long as this request's async context.
    clockOverrideStorage.run({ now: parsed }, next);
  }
}

function parseIsoInstant(value: string): Date | null {
  if (!ISO_INSTANT.test(value)) {
    return null;
  }

  const parsed = new Date(value);

  // The regex admits shapes the calendar does not, such as 2026-02-31.
  // `Date` turns those into `Invalid Date` rather than throwing.
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
}
