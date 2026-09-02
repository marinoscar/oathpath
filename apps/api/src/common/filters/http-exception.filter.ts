import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { hasVerbatimErrorBody } from '../exceptions/verbatim-error-body.exception';

/**
 * The standard error envelope every failing request returns.
 *
 * Exported so anything that has to name the shape is compile-time bound to it
 * rather than hand-rolling a copy that could drift.
 */
export interface ErrorResponse {
  statusCode: number;
  code: string;
  message: string;
  details?: unknown;
  timestamp: string;
  path: string;
}

/** The one method of a Fastify reply this filter needs, and uses to recognise one. */
interface FastifyLikeReply {
  code(status: number): { send(body: unknown): unknown };
}

/**
 * The request path to report in the envelope.
 *
 * `req.url` alone is not it. Nest mounts middleware through middie, which
 * rewrites `url` relative to the mount point, so an exception thrown from
 * middleware reports `path: "/"` for every request in the application. Middie
 * preserves the real path on `originalUrl`, and Fastify's own request exposes
 * an `originalUrl` getter defined as `raw.originalUrl || raw.url` -- so on the
 * ordinary (non-middleware) path this returns exactly what `request.url`
 * returned before, and on the middleware path it returns the URL the client
 * actually asked for.
 *
 * Exported because it describes a fact about this application's request
 * pipeline, not about this filter, and the next thing that needs the real URL
 * from a raw Node request should import it rather than rediscover middie.
 */
export function originalUrlOf(
  request: Partial<IncomingMessage> & { originalUrl?: string },
): string {
  return request.originalUrl ?? request.url ?? '';
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();
    const request = ctx.getRequest();
    const path = originalUrlOf(request);

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    let message = 'An unexpected error occurred';
    let details: unknown;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      // ---------------------------------------------------------------------
      // Verbatim bodies (#153) — checked FIRST, and returns immediately.
      // ---------------------------------------------------------------------
      // A branded exception carries a body dictated by an external spec, not by
      // us: today that is `POST /auth/device/token`, whose RFC 8628 §3.5 body is
      // `{ error, error_description }`. Sending it through the envelope below
      // destroys it — the envelope reads only `message`, `code` and `details`,
      // so all four RFC outcomes used to arrive as the same generic 400 and a
      // polling client could not tell them apart. See
      // `common/exceptions/verbatim-error-body.exception.ts` for why the opt-out
      // is an explicit brand rather than the filter sniffing for an `error` key.
      //
      // Nothing is merged in — not `statusCode`, not `timestamp`, not `path`.
      // Extra keys would not upset a tolerant parser, but they would put fields
      // the RFC never defines into a protocol response, and a body that is
      // "mostly the spec" is exactly the kind of thing a strict client rejects
      // and a reader stops trusting. The status line still carries the code.
      //
      // The object guard matters: a string payload has nothing to send
      // verbatim, so such an exception falls through to the envelope rather than
      // putting a bare JSON string on the wire.
      if (
        hasVerbatimErrorBody(exception) &&
        typeof exceptionResponse === 'object' &&
        exceptionResponse !== null
      ) {
        this.logOutcome(
          request.method,
          path,
          status,
          this.summarize(exceptionResponse as Record<string, unknown>),
          exception,
        );

        // Sent through the same writer as the envelope below, not through a
        // bare `response.code(...)`. A verbatim body is not a "less likely to
        // come from middleware" case — it is exactly as likely, because a
        // middleware is a perfectly ordinary place to reject a protocol
        // request, and the device-flow endpoints this brand exists for are
        // precisely the sort of thing a future rate-limiting or client-auth
        // middleware would guard. Leaving this line calling `.code()` directly
        // would have left half of #183's defect in place, in the half nobody
        // would think to test.
        this.send(response, status, exceptionResponse);
        return;
      }

      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
      } else if (typeof exceptionResponse === 'object') {
        const resp = exceptionResponse as Record<string, unknown>;
        message = (resp.message as string) || message;
        details = resp.details;
      }

      // `code` is ALWAYS derived from the status, and a `code` on the thrown
      // payload is deliberately ignored.
      //
      // This line used to be preceded by `code = (resp.code as string) ||
      // this.getCodeFromStatus(status)`, which this one immediately overwrote —
      // dead since it was written, so no exception in the app could ever set its
      // own code (#153). The dead line was removed rather than made to work,
      // because honouring a payload `code` is a real behaviour change on the
      // wire and the current behaviour is the one the API actually promises:
      //
      //   * `common/dto/error.dto.ts` publishes `code` as a CLOSED ENUM of the
      //     nine status-derived values, and says in so many words that the
      //     filter overwrites any `code` an exception supplied. That DTO is the
      //     `default` error response on every operation in the OpenAPI document,
      //     so it is a published contract, not a comment.
      //   * `http-exception.filter.spec.ts` asserts it ("The filter overrides
      //     custom code with standard code mapping"). The behaviour is tested,
      //     not accidental.
      //   * One exception does pass a `code`: `DatabaseSeedException` sends
      //     `DATABASE_SEED_REQUIRED`. Reviving the dead line would have changed
      //     that response's `code` from `INTERNAL_ERROR` to a value outside the
      //     published enum — a silent contract break in the one place nobody
      //     would think to check. Its identifying data is already in `details`,
      //     which the envelope carries through.
      //
      // Endpoint-specific machine-readable data belongs under `details`; an
      // externally-specified body belongs behind the verbatim brand above.
      code = this.getCodeFromStatus(status);
    } else if (exception instanceof Error) {
      message = exception.message;
      // Don't expose stack traces in production
      if (process.env.NODE_ENV !== 'production') {
        details = exception.stack;
      }
    }

    const errorResponse: ErrorResponse = {
      statusCode: status,
      code,
      message,
      timestamp: new Date().toISOString(),
      path,
    };

    if (details) {
      errorResponse.details = details;
    }

    this.logOutcome(request.method, path, status, message, exception);

    this.send(response, status, errorResponse);
  }

  /**
   * Writes the response, whatever kind of response object this filter was handed.
   *
   * ---------------------------------------------------------------------------
   * WHY THIS IS NOT JUST `response.code(status).send(body)` (#183)
   * ---------------------------------------------------------------------------
   * For an exception thrown from a guard, pipe, interceptor or controller the
   * arguments host holds a Fastify reply, and `.code().send()` is correct.
   *
   * For an exception thrown from **middleware** it does not. Nest runs
   * middleware through middie under the Fastify adapter and, when middleware
   * throws, hands this filter the raw Node `IncomingMessage`/`ServerResponse`
   * (see `MiddlewareModule`'s `new ExecutionContextHost([req, res, next])`).
   * `ServerResponse` has no `.code()`, so the filter itself threw
   * `TypeError: response.code is not a function`, nothing was ever written to
   * the socket, and the request hung until the client gave up — no status, no
   * body, no clue, and a stack trace pointing at a global filter the author of
   * the middleware never touched.
   *
   * The shape is detected by CAPABILITY rather than by `NODE_ENV`, an adapter
   * flag or an `instanceof`. The question being asked really is "can this
   * object take a status the Fastify way?", the answer is knowable from the
   * object itself, and a capability check keeps the existing unit spec's plain
   * `{ code, send }` mock — which is neither a Fastify reply nor a
   * `ServerResponse` — on the Fastify branch where it belongs.
   */
  private send(response: unknown, status: number, body: unknown): void {
    const reply = response as Partial<FastifyLikeReply>;

    if (typeof reply.code === 'function') {
      reply.code(status).send(body);
      return;
    }

    const raw = response as ServerResponse;

    // Already answered: a second write would throw ERR_HTTP_HEADERS_SENT from
    // inside the filter, which is the same class of failure this method exists
    // to remove. The likeliest way to get here is a middleware that answered
    // the request itself and then threw; the client already has its response,
    // so there is nothing to do but say so in the log.
    if (raw.headersSent || raw.writableEnded) {
      this.logger.warn(
        `Cannot write a ${status} error response — the response was already sent`,
      );
      return;
    }

    // Serialised before `writeHead`, so a body that cannot be stringified (a
    // circular `details`, say) degrades to a smaller envelope instead of
    // throwing between the head and the body and hanging the request again.
    let payload: string;
    try {
      payload = JSON.stringify(body);
    } catch (error) {
      this.logger.error('Failed to serialize the error response body', error);
      payload = JSON.stringify({
        statusCode: status,
        code: this.getCodeFromStatus(status),
        message: 'An unexpected error occurred',
        timestamp: new Date().toISOString(),
        path: '',
      } satisfies ErrorResponse);
    }

    // `charset=utf-8` matches what Fastify puts on every other JSON response,
    // so a middleware rejection is indistinguishable from any other error on
    // the wire — headers included.
    raw.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    raw.end(payload);
  }

  /**
   * One log line per handled failure, identical for enveloped and verbatim
   * responses. Extracted so the verbatim early-return above cannot silently
   * skip logging — a device-flow `slow_down` storm has to be visible in the
   * logs like any other 4xx.
   *
   * Takes the resolved path rather than the request, so the log line and the
   * envelope can never disagree about which URL failed.
   */
  private logOutcome(
    method: string,
    path: string,
    status: number,
    summary: string,
    exception: unknown,
  ): void {
    if (status >= 500) {
      this.logger.error(
        `${method} ${path} - ${status}`,
        exception instanceof Error ? exception.stack : exception,
      );
    } else {
      this.logger.warn(`${method} ${path} - ${status}: ${summary}`);
    }
  }

  /**
   * A short log-only description of a verbatim body.
   *
   * Reading `error` here is for the LOG LINE ONLY and shapes nothing — an RFC
   * body's `error` is the single most useful thing to see in operations
   * (`slow_down` and `access_denied` mean very different things at 3am), and
   * without it every device-flow failure logs as an indistinguishable 400. The
   * body itself is never stringified into the log: a verbatim payload is
   * whatever the spec says it is, and this filter should not assume the rest of
   * it is safe to print.
   */
  private summarize(body: Record<string, unknown>): string {
    const label = body.error ?? body.message;
    return typeof label === 'string' ? label : 'verbatim error body';
  }

  private getCodeFromStatus(status: number): string {
    const codeMap: Record<number, string> = {
      400: 'BAD_REQUEST',
      401: 'UNAUTHORIZED',
      403: 'FORBIDDEN',
      404: 'NOT_FOUND',
      409: 'CONFLICT',
      422: 'UNPROCESSABLE_ENTITY',
      429: 'TOO_MANY_REQUESTS',
      500: 'INTERNAL_ERROR',
    };
    return codeMap[status] || 'ERROR';
  }
}
