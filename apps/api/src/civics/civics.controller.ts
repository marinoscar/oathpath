import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';

import { ApiDataResponse } from '../common/decorators/api-data-response.decorator';
import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CivicsService } from './civics.service';
import {
  CivicsExplainService,
  type CivicsExplainFrame,
} from './civics-explain.service';
import { CivicsExplainDto } from './dto/civics-explain.dto';
import {
  CivicsTestVersionDto,
  type CivicsTestVersionResponse,
} from './dto/civics-version.dto';
import {
  CivicsCategoryDto,
  type CivicsCategoryResponse,
} from './dto/civics-category.dto';
import { CivicsQuestionQueryDto } from './dto/civics-question-query.dto';
import {
  CivicsQuestionDetailDto,
  CivicsQuestionSummaryDto,
  type CivicsQuestionDetail,
} from './dto/civics-question.dto';

// =============================================================================
// CivicsController (issue #111, epic #51)
// =============================================================================
//
//   GET /api/civics/versions                    @Auth(), no permissions
//   GET /api/civics/versions/:code/categories   @Auth(), no permissions
//   GET /api/civics/questions                   @Auth(), no permissions
//   GET /api/civics/questions/:id               @Auth(), no permissions
//   POST /api/civics/questions/:id/explain      @Auth(), no permissions (SSE)
//
// -----------------------------------------------------------------------------
// NO ROUTE ACCEPTS A USER ID OR A STATE. THAT IS THE SECURITY BOUNDARY.
// -----------------------------------------------------------------------------
//
// `@CurrentUser('id')` is the ONLY source of a user id in this file, and the
// caller's `state_code` is read from that user's own `learner_profiles` row —
// never from a path parameter, a query parameter, or a header. The query DTO is
// a `z.strictObject`, so `?stateCode=TX` is a 400 rather than a parameter
// something might one day start honouring.
//
// So there is no `GET /api/civics/questions/:id?stateCode=…` to forget to
// authorise, and "resolve this question as if I lived somewhere else" is not
// prevented by a check a refactor could relax — it is unreachable, because no
// input names a state or another learner. This is the identical structural rule
// `journey.controller.ts` states for its own routes, and civics-content.md §8
// requires it here.
//
// -----------------------------------------------------------------------------
// `@Auth()` WITH NO PERMISSIONS, AND NO NEW PERMISSION STRING
// -----------------------------------------------------------------------------
//
// Civics content is the core product material every authenticated learner
// reads. Gating it would leave a Viewer — the DEFAULT role every new account
// gets — unable to study, which is the entire product. That is the same
// argument `journey.controller.ts` and `ai/ai-user-key.controller.ts` both
// make, and civics-content.md §8 makes it for these four routes by name: the
// closed permission set (ROADMAP §7) gains nothing from gating a read of public
// exam content.
//
// The ADMIN dynamic-answer surface is a different matter — it reuses
// `system_settings:read`/`:write` (§9) — but that is issue #117, not this one.
//
// The explanation route (#120) keeps the same posture and adds no permission
// string either. It spends the CALLER'S OWN AI key — `AiDispatchService` reads
// no other credential — so there is no shared resource for a permission to
// ration, and gating it would leave a Viewer, the default role, unable to ask
// what an answer means. `ai-evaluation.md` §11 and `ai/ai-user-key.controller.ts`
// make the same argument for the per-user AI surface.
//
// -----------------------------------------------------------------------------
// NOTHING HERE WRITES APPLICATION DATA. THE ONE `POST` IS NOT AN EXCEPTION.
// -----------------------------------------------------------------------------
//
// `POST … /explain` is a POST because it carries a request body and because it
// costs money to serve — it is not safe to retry blindly and must never be
// cached — not because it stores anything. It creates no row a learner can read
// back: no conversation is kept (#120 excludes chat outright), no explanation is
// persisted, and the only row the request leaves behind is the
// `ai_usage_events` accounting record every AI call writes, from inside the
// provider.
// =============================================================================

@ApiTags('Civics')
@Controller('civics')
export class CivicsController {
  /**
   * Only ever used by the streaming route below, and only for a fault in the
   * transport itself. Nothing a learner typed and nothing a model said is
   * loggable here — see `AiDispatchService`'s header for the rule.
   */
  private readonly logger = new Logger(CivicsController.name);

  constructor(
    private readonly civicsService: CivicsService,
    private readonly explainService: CivicsExplainService,
  ) {}

  @Get('versions')
  @Auth()
  @ApiOperation({
    summary: 'List the civics test versions',
    description:
      'Every `civics_test_versions` row: the two official question banks and the shape ' +
      'of each interview — how many questions are asked and how many must be right, ' +
      'both for the ordinary case and for the 65/20 senior accommodation.\n\n' +
      '`contentHash` is a sha256 over the content file the loader last applied, or null ' +
      'before any content has been loaded. It answers "does the live database match ' +
      'exactly the content file in git" — it is **not** a hash of the official USCIS ' +
      'source document.\n\n' +
      'Its own call rather than a field on every question, because a version list ' +
      'changes far less often than a question list and has its own cache lifetime.',
  })
  @ApiDataResponse(CivicsTestVersionDto, {
    isArray: true,
    description: 'Every civics test version, in code order',
  })
  listVersions(): Promise<CivicsTestVersionResponse[]> {
    return this.civicsService.listVersions();
  }

  @Get('versions/:code/categories')
  @Auth()
  @ApiOperation({
    summary: "List a version's categories",
    description:
      "The version's categories in `sortOrder` — the order the official material uses, " +
      'which is not alphabetical (Government precedes History precedes Integrated ' +
      'Civics).\n\n' +
      'An unknown version code is a **404**, not an empty list: "this version does not ' +
      'exist" and "this version has no categories loaded yet" are different facts, and ' +
      'collapsing them would make a client-side typo indistinguishable from content that ' +
      'has not been seeded.',
  })
  @ApiParam({
    name: 'code',
    type: String,
    description: 'A test version code, e.g. `v2008` or `v2025`.',
  })
  @ApiDataResponse(CivicsCategoryDto, {
    isArray: true,
    description: 'The version’s categories, in render order',
  })
  @ApiResponse({ status: 404, description: 'Unknown test version code' })
  listCategories(
    @Param('code') code: string,
  ): Promise<CivicsCategoryResponse[]> {
    return this.civicsService.listCategories(code);
  }

  @Get('questions')
  @Auth()
  @ApiOperation({
    summary: 'List civics questions',
    description:
      'Paginated question summaries — `number`, `prompt`, `categoryId`, `seniorEligible` ' +
      'and `dynamicScope`. **No answers**: those are resolved per caller and belong on ' +
      'the detail route.\n\n' +
      '**`testVersionCode` defaults to the caller\'s own resolved test version.** ' +
      'Omitting it does not mean "every version" — a learner studying the 2025 test has ' +
      'no use for the 2008 bank. Only a caller who has not finished orientation, and so ' +
      'has no resolved version, sees the whole bank.\n\n' +
      '`seniorEligible` is an explicit filter with no implicit default: a learner ' +
      'claiming the 65/20 accommodation is still entitled to browse the full bank.\n\n' +
      'There is no `userId` and no `stateCode` parameter, and an unknown query parameter ' +
      'is a 400 rather than a silently ignored one.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiQuery({ name: 'testVersionCode', required: false, type: String })
  @ApiQuery({ name: 'categoryId', required: false, type: String, format: 'uuid' })
  @ApiQuery({ name: 'seniorEligible', required: false, type: Boolean })
  @ApiDataResponse(CivicsQuestionSummaryDto, {
    pagination: 'flat',
    description: 'A page of question summaries',
  })
  listQuestions(
    @CurrentUser('id') userId: string,
    @Query() query: CivicsQuestionQueryDto,
  ) {
    return this.civicsService.listQuestions(userId, query);
  }

  @Get('questions/:id')
  @Auth()
  @ApiOperation({
    summary: 'Get one question, with its answers resolved for the caller',
    description:
      "One question plus its category and the answers that are correct **now**, for " +
      '**this caller**.\n\n' +
      'Only current answers are ever returned: a superseded answer is closed rather than ' +
      'deleted, so that a past practice attempt stays explicable, and it is unreachable ' +
      'through this API.\n\n' +
      'How `answers` is populated depends on the question\'s `dynamicScope`:\n\n' +
      '- `none` — every simultaneously correct alternative, in slot order. "Name one ' +
      'branch of the government" returns three.\n' +
      '- `national` — the single current answer. "Who is the President" returns one.\n' +
      '- `state` — the single current answer for the caller\'s own state, read from ' +
      'their learner profile.\n\n' +
      '**`answerResolution: "state_required"` is the case a client must handle.** A ' +
      '`state`-scope question asked by a learner with no state set returns the question ' +
      'with `answers: []` and `verifiedAt: null` — never a 404, never another state\'s ' +
      'answer, never a guess. Render a prompt to set their state.\n\n' +
      '`verifiedAt` is the most recent human verification across the resolved answers — ' +
      'what "current as of …" renders from.\n\n' +
      'There is no `stateCode` parameter. The state comes from the caller\'s profile ' +
      'and nowhere else.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiDataResponse(CivicsQuestionDetailDto, {
    description: 'The question, its category, and the answers resolved for the caller',
  })
  @ApiResponse({ status: 404, description: 'Unknown question id' })
  getQuestion(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CivicsQuestionDetail> {
    return this.civicsService.getQuestion(userId, id);
  }

  // ---------------------------------------------------------------------------
  // The tutor explanation (#120, epic #53 / E4)
  // ---------------------------------------------------------------------------

  /**
   * Stream an explanation of one question's answer, as Server-Sent Events.
   *
   * ---------------------------------------------------------------------------
   * WHY THIS IS HAND-WRITTEN SSE AND NOT `@Sse()`
   * ---------------------------------------------------------------------------
   *
   * `notifications.controller.ts` argues at length for Nest's `@Sse()`, and
   * that argument still stands where it applies: it works under Fastify, it
   * sets the header block (`X-Accel-Buffering: no` included), it frames
   * correctly, it tunes the socket, and it tears down on disconnect. None of it
   * is available here, because `@Sse()` hard-codes `RequestMethod.GET` onto the
   * handler it decorates. This route takes a BODY — the learner's optional
   * `focus` — and a GET with a body is a request half the world's proxies and
   * clients will not send.
   *
   * So the transport below reimplements exactly what `@Sse()` would have done
   * and nothing more: the same header set, the same opening comment frame, the
   * same "unsubscribe when the raw response closes" teardown. Where it differs
   * from that model it is on purpose, and each difference is commented.
   *
   * ---------------------------------------------------------------------------
   * THE AUTH STORY IS THE ONE `notifications.controller.ts` ALREADY SETTLED
   * ---------------------------------------------------------------------------
   *
   * Ordinary `@Auth()`, ordinary `Authorization: Bearer …`. The native
   * `EventSource` cannot send that header, so the web client connects with a
   * fetch-based SSE reader — which it must do here anyway, since `EventSource`
   * only ever issues a GET.
   *
   * A `?token=` QUERY PARAMETER IS REJECTED HERE FOR THE SAME REASON IT WAS
   * REJECTED THERE, and the reason has not weakened: an access token in a URL
   * is written to the nginx access log, kept in browser history and forwarded
   * in `Referer`, which turns a short-lived bearer credential into something
   * replayable out of a log file that is retained for months.
   *
   * ---------------------------------------------------------------------------
   * A CLIENT DISCONNECT ABORTS THE UPSTREAM CALL
   * ---------------------------------------------------------------------------
   *
   * This is not tidiness. Inference runs on the LEARNER'S OWN API KEY
   * (`ai-evaluation.md` §5), so a stream nobody is reading that keeps
   * generating is money coming off a private person's card for text no one will
   * ever see. The `AbortController` below is passed into the dispatcher and
   * aborted the moment the raw response closes early.
   *
   * The usage row is still written: `BaseAiProvider.stream` records it from its
   * own `finally`, which runs when this loop's `break` closes the generator
   * chain. The tokens were spent whether or not anyone read them, and an
   * abandoned stream is recorded distinctly (`client_disconnected`) rather than
   * silently absent.
   */
  @Post('questions/:id/explain')
  @Auth()
  // 200, not the 201 a POST defaults to. Nothing is created — see the file
  // header — and the status line is written by hand below, so this decorator
  // exists to keep the DOCUMENT honest about what the wire will say.
  @HttpCode(HttpStatus.OK)
  @ApiProduces('text/event-stream')
  @ApiOperation({
    summary: 'Explain one question’s answer (SSE)',
    description:
      'A `text/event-stream` carrying a tutor’s explanation of the answer to this ' +
      'question, **for this caller**, generated on **their own** AI key.\n\n' +
      '**Grounded, never consulted.** The question and the answers that are correct now ' +
      'for this learner are read from the database and handed to the model as fact; it is ' +
      'asked what they *mean*, never what they *are*. That is what keeps a question whose ' +
      'answer changed after the model’s training cutoff — who is President, who is your ' +
      'governor — from being explained as whoever the model remembers.\n\n' +
      '**Language.** The explanation is written in the caller’s own ' +
      '`explanationLanguage` (their learner profile), defaulting to `en`. There is ' +
      'deliberately no language parameter: a request that could override the setting ' +
      'would let a client disagree with the person’s own saved preference.\n\n' +
      '**Frames.** An opening `: connected` comment so headers flush, then any number of ' +
      '`event: delta` frames whose `data` is `{"text":"…"}`, then **exactly one** terminal ' +
      'frame, always last:\n\n' +
      '- `event: done` — `{"usage":{…}}`. The explanation is whole.\n' +
      '- `event: unavailable` — `{"cause":"no_user_key"|"ai_disabled"|"role_unbound"|' +
      '"capability_unsupported"}`. No call was attempted: the caller has stored no AI key, ' +
      'or an administrator has not finished configuring AI. **Not a 5xx, and not a ' +
      'connection left open** — the stream opens and says so immediately, so the client ' +
      'renders its "AI is not set up" state instead of spinning.\n' +
      '- `event: state_required` — `{"answerResolution":"state_required"}`. A `state`-scope ' +
      'question asked by a learner with no state set. **No model is called**: there is no ' +
      'correct answer to explain, and guessing a state would teach a confident, memorable, ' +
      'wrong one. Prompt the learner to set their state — the same handling ' +
      '`GET /api/civics/questions/{id}` already asks for.\n' +
      '- `event: error` — `{"errorCode":"…","error":"…"}`. The call was made and did not ' +
      'produce a usable answer. Deltas already delivered were really received, but the ' +
      'explanation is not whole.\n\n' +
      '**Client note.** The native `EventSource` issues a GET and cannot send an ' +
      '`Authorization` header; use a fetch-based SSE reader. A token in the query string is ' +
      'deliberately not supported — it would put a live credential into access logs and ' +
      'browser history.\n\n' +
      '**Cost.** Disconnecting aborts the upstream request, so an abandoned explanation ' +
      'stops being generated and stops being billed. It is still recorded in the caller’s ' +
      'own usage.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiBody({
    type: CivicsExplainDto,
    required: false,
    description:
      'Optional. `focus` is one short sentence (≤200 characters) saying what the learner ' +
      'finds confusing; it is treated strictly as data, never as an instruction to the ' +
      'model. An unknown key is a 400 — there is no `stateCode`, `userId` or `language` ' +
      'parameter.',
  })
  @ApiOkResponse({
    description:
      'An open event stream. Ends after exactly one terminal frame, or when the client ' +
      'disconnects.',
    content: {
      'text/event-stream': {
        schema: {
          type: 'string',
          example:
            ': connected\n\nevent: delta\ndata: {"text":"The Constitution "}\n\n' +
            'event: delta\ndata: {"text":"is the supreme law "}\n\n' +
            'event: done\ndata: {"usage":{"promptTokens":212,"completionTokens":96,' +
            '"totalTokens":308}}\n\n',
        },
      },
    },
  })
  @ApiResponse({ status: 404, description: 'Unknown question id' })
  async explainQuestion(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CivicsExplainDto,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const abort = new AbortController();

    // AWAITED BEFORE A SINGLE BYTE IS WRITTEN, and that ordering is the whole
    // reason `explain` is an async function returning an iterable rather than
    // a generator. An unknown question id throws `NotFoundException` here,
    // while the response is still unwritten, so `HttpExceptionFilter` turns it
    // into an ordinary 404 envelope. Inside a generator the same throw would
    // land after `200 text/event-stream` was already on the wire, and a 404
    // would reach the client as a stream that opened and broke.
    const frames = await this.explainService.explain(userId, id, body, abort.signal);

    // From here on the reply is ours. `hijack()` tells Fastify not to send a
    // response of its own and to skip its `onSend` hooks — without it, the
    // framework and this handler would both believe they own the socket.
    reply.hijack();

    const res = reply.raw;

    res.writeHead(HttpStatus.OK, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      // `no-transform` as well as `no-cache`: a proxy that "helpfully"
      // compresses or rewrites the body is a proxy that buffers it, and a
      // buffered event stream is a slow non-streaming response.
      'Cache-Control': 'no-cache, no-store, no-transform',
      Connection: 'keep-alive',
      // The response-side half of the nginx buffering problem, exactly as
      // Nest's own `@Sse()` sets it. The `proxy_buffering off` in the location
      // block is the other half; a header cannot change a read timeout.
      'X-Accel-Buffering': 'no',
    });

    // THE OPENING COMMENT FRAME, IMMEDIATELY. A comment is invisible to
    // `EventSource` consumers, and writing one is what pushes the headers out
    // of Node's buffer now rather than whenever the first token happens to
    // arrive. Without it a client sees nothing at all until the model
    // responds, which is indistinguishable from a hung request — on the one
    // endpoint whose entire product argument is that it does not feel hung.
    res.write(': connected\n\n');

    // Teardown, wired the way Nest's own SSE dispatch wires it: on `close` of
    // the RAW response. `writableEnded` is what tells the two cases apart —
    // Node emits `close` after a normal `end()` too, and aborting there would
    // fire on every successful request.
    let clientGone = false;
    res.on('close', () => {
      if (res.writableEnded) return;

      clientGone = true;
      abort.abort();
    });

    try {
      for await (const frame of frames) {
        // Checked BEFORE the write, not after: writing to a closed socket is
        // an error event nobody is listening for, and the point of noticing
        // the disconnect is to stop doing work for it.
        if (clientGone) break;

        res.write(frameFor(frame));

        // A terminal frame is the last thing on the wire, by contract
        // (`CivicsExplainFrame`). Breaking here rather than trusting the
        // iterable to end costs nothing and makes "exactly one terminal frame"
        // a property of the TRANSPORT as well as of the producer — a stream
        // that yielded something after `done` could not smuggle it out.
        if (frame.event !== 'delta') break;
      }
    } catch (err) {
      // Reached only for a fault in this loop itself — the service and the
      // dispatcher below it never throw from their iterators. The exception
      // filter cannot help once `200` is on the wire, so the failure has to
      // arrive as the transport's own terminal event; a connection dropped
      // without one leaves a browser waiting forever on a request that is over.
      this.logger.error(
        `Explanation stream failed for user ${userId} on question ${id}: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );

      if (!clientGone) {
        res.write(
          frameFor({
            event: 'error',
            data: {
              errorCode: 'stream_transport_error',
              // No prompt, no completion, no exception text: the same rule
              // `AiDispatchService` holds — what a learner asked and what a
              // model said never reach a message a client or a log can read.
              error: 'The explanation could not be delivered.',
            },
          }),
        );
      }
    } finally {
      // Only when the socket is still ours to close. `end()` on a response
      // whose connection is already gone is a no-op at best and an unhandled
      // error at worst.
      if (!clientGone) res.end();
    }
  }
}

/**
 * One frame, in SSE's wire format.
 *
 * `event:` then `data:` then a BLANK LINE, which is what actually dispatches
 * the event on the client. `JSON.stringify` output contains no newline, so a
 * single `data:` line is always sufficient here — the multi-line splitting
 * `SseStream` implements has nothing to do on this stream.
 */
function frameFor(frame: CivicsExplainFrame): string {
  return `event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`;
}
