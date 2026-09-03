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
import {
  InterviewsService,
  type InterviewTurnFrame,
} from './interviews.service';
import { CreateInterviewDto } from './dto/create-interview.dto';
import { InterviewQueryDto } from './dto/interview-query.dto';
import { InterviewTurnDto } from './dto/interview-turn.dto';
import {
  InterviewDebriefDto,
  type InterviewDebrief,
} from './dto/interview-debrief.dto';
import {
  InterviewDetailDto,
  InterviewListItemDto,
  InterviewStateDto,
  type InterviewDetail,
  type InterviewState,
} from './dto/interview.dto';

// =============================================================================
// InterviewsController (issue #133, epic #57 / E8 "Mock interview")
// =============================================================================
//
//   POST /api/interviews                @Auth(), none
//   GET  /api/interviews                @Auth(), none
//   GET  /api/interviews/:id            @Auth(), none
//   POST /api/interviews/:id/turns      @Auth(), none  (text/event-stream)
//   POST /api/interviews/:id/complete   @Auth(), none
//
// -----------------------------------------------------------------------------
// NO ROUTE ACCEPTS A USER ID. THAT IS THE SECURITY BOUNDARY.
// -----------------------------------------------------------------------------
//
// `@CurrentUser('id')` is the ONLY source of a user id in this file — not a path
// parameter, not a query parameter, not a body field. Both request DTOs carry a
// compile-time proof that no identity-shaped field crept into them, and the
// query DTO is a `z.strictObject`, so `?userId=…` is a 400 naming the parameter
// rather than something a later edit might start honouring.
//
// The interview id in a path IS caller-supplied, and that is exactly why
// `InterviewsService.requireInterview` filters on `userId` in the `where` of the
// single query that loads an interview, rather than loading it and checking
// after. **Another learner's interview is a 404, not a 403** — naming a resource
// you may not see is itself a leak, and from this caller's position it genuinely
// does not exist. `docs/specs/mock-interview.md` §12 asks for exactly the rule
// `practice.controller.ts` already states, reused rather than reinvented.
//
// An Admin gets no special path either. Same structural property, not a
// permission check a refactor could relax: `InterviewsService` has no "read any
// learner's interviews" method for a future controller to reach for.
//
// -----------------------------------------------------------------------------
// `@Auth()` WITH NO PERMISSIONS, AND NO NEW PERMISSION STRING
// -----------------------------------------------------------------------------
//
// §12, and the identical reason `CLAUDE.md`'s "Journey/Practice/Progress/
// Readiness/Engagement add no permission strings" all give in turn: no route
// here accepts a user id from anywhere but the authenticated session, so there
// is no "read another learner's interview" permission to add in the first place.
// Every authenticated learner owns their own interview history exactly as they
// own their own practice attempts, their own learner profile and their own
// readiness snapshots.
//
// -----------------------------------------------------------------------------
// NO ROUTE RETURNS A VERDICT BEFORE `complete`
// -----------------------------------------------------------------------------
//
// §10, expressed as the shape of this file rather than as a rule someone has to
// remember: the turn endpoint's frames carry officer text, a phase and a
// progress count; `GET /api/interviews/:id` returns `debrief: null` until the
// interview is `completed`; and there is no route that returns a single
// attempt. The engine knew whether each answer was right the moment it graded
// it, recorded that, and used it to choose the next question and to run the stop
// rule — entirely server-side. `POST /api/interviews/:id/complete` is the first
// moment any of it exists where the learner can see it.
// =============================================================================

@ApiTags('Interviews')
@Controller('interviews')
export class InterviewsController {
  private readonly logger = new Logger(InterviewsController.name);

  constructor(private readonly interviews: InterviewsService) {}

  @Post()
  @Auth()
  @ApiOperation({
    summary: 'Start a mock interview',
    description:
      'Opens a mock interview and returns it together with the officer’s **opening turn** — ' +
      'a greeting and one non-scored small-talk question.\n\n' +
      '**The question bank, the pass rule and the senior accommodation come from the ' +
      'caller’s own learner profile, never from this request.** There is no ' +
      '`testVersionCode` and no `seniorExemption` field: a request that could set either ' +
      'would let a learner sit a smaller pool against a lower pass mark and be told they ' +
      'passed a test they were never given. Both are then frozen onto the interview, so ' +
      'editing the profile mid-interview cannot change the rule the interview is graded ' +
      'against.\n\n' +
      '**`transcriptRetained` defaults to `false`.** With it off, the interview records ' +
      'everything that HAPPENED — every turn, in order, in its phase, naming the question ' +
      'asked, plus every outcome, grading method and frozen answer snapshot — and does ' +
      'not record what the learner SAID. Applicant turn text is stored empty, ' +
      '`responseText` is null, and the AI grader’s written feedback is not stored at all. ' +
      'The learner is still graded on their real words; only the record of them is ' +
      'withheld. The honest cost: they cannot re-read their own phrasing afterwards.\n\n' +
      '**The civics questions are chosen deterministically from the interview’s own id.** ' +
      'The same interview always asks the same questions in the same order, drawn from ' +
      'the caller’s own test version, restricted to senior-eligible questions only if ' +
      'they claim that accommodation, and excluding any state-specific question they have ' +
      'set no state for — such a question has no answer that could honestly be graded.\n\n' +
      'A learner who has not finished orientation has no resolved test version and gets a ' +
      '400 naming that.',
  })
  @ApiDataResponse(InterviewStateDto, {
    status: 201,
    description: 'The new interview and the officer’s opening turn',
  })
  @ApiResponse({
    status: 400,
    description:
      'Invalid body, or the caller has not finished orientation so no test version is resolved',
  })
  createInterview(
    @CurrentUser('id') userId: string,
    @Body() body: CreateInterviewDto,
  ): Promise<InterviewState> {
    return this.interviews.createInterview(userId, body);
  }

  @Get()
  @Auth()
  @ApiOperation({
    summary: 'List the caller’s mock interviews',
    description:
      'The caller’s own interviews, **newest first**, paginated with the same ' +
      '`page`/`pageSize` shape every other list in this API uses.\n\n' +
      'Each row carries `status`, `startedAt`, `completedAt`, `civicsAsked`, ' +
      '`civicsCorrect` and `passedCivics` — enough to answer "did I do better on my second ' +
      'mock interview than my first", which is what this endpoint exists for. Open one to ' +
      'read its transcript and its debrief.\n\n' +
      'There are deliberately no filters: this is the one query the table’s ' +
      '`[userId, startedAt]` index serves.\n\n' +
      'Scoped to the caller. An unknown query parameter — `?userId=` included — is a 400.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiDataResponse(InterviewListItemDto, {
    pagination: 'flat',
    description: 'A page of the caller’s interviews, newest first',
  })
  listInterviews(
    @CurrentUser('id') userId: string,
    @Query() query: InterviewQueryDto,
  ) {
    return this.interviews.listInterviews(userId, query);
  }

  @Get(':id')
  @Auth()
  @ApiOperation({
    summary: 'Resume an interview, or re-read its debrief',
    description:
      'One interview, its whole transcript in order, how far through the civics section it ' +
      'is, and — **only once it is `completed`** — its stored debrief.\n\n' +
      '`debrief` is `null` while the interview is in progress. That is the same rule the ' +
      'turn stream follows: no verdict, no score and no correct/incorrect signal reaches ' +
      'the learner before the interview is finished, because the real interview gives no ' +
      'per-question feedback either and a rehearsal that does is teaching them to expect ' +
      'a signal the actual event will never give.\n\n' +
      '`progress.civicsAsked` / `civicsPlanned` is **pacing, not score** — there is ' +
      'deliberately no running correct count here.\n\n' +
      'An applicant turn with empty `text` on an interview whose `transcriptRetained` is ' +
      '`false` means the words were never kept, **not** that the learner said nothing.\n\n' +
      '**An interview belonging to another learner is a 404, not a 403.** Confirming that ' +
      'an id names a real interview would itself be the leak.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiDataResponse(InterviewDetailDto, {
    description: 'The interview, its transcript, and its debrief once completed',
  })
  @ApiResponse({ status: 404, description: 'No such interview for this caller' })
  getInterview(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<InterviewDetail> {
    return this.interviews.getInterview(userId, id);
  }

  @Post(':id/complete')
  @Auth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Finish the interview and get the debrief',
    description:
      'Closes the interview, computes its debrief, and triggers a readiness recompute — ' +
      'this is the **first** moment any performance information exists where the learner ' +
      'can see it.\n\n' +
      'The debrief carries: the civics result (`planned`, `asked`, `correct`, `threshold`, ' +
      '`passed`, `stoppedEarly`, `stopReason`); every question asked, with its accepted ' +
      'answers **as they stood when that answer was graded** and never re-resolved; every ' +
      'phase and whether this rehearsal conducted it (the reading and writing tests are ' +
      'reported `skipped`, honestly, rather than omitted); the category names with at ' +
      'least one miss; and the readiness score, its change, and the `interview` ' +
      'component.\n\n' +
      '`planned` and `threshold` are echoed from the `civics_test_versions` row this ' +
      'interview was created against — a client must never hardcode either.\n\n' +
      '`asked` is smaller than `planned` whenever the early stop fired, which is the real ' +
      'test’s own behaviour: an officer who has heard enough correct answers stops, and ' +
      'so does one who has heard enough wrong ones. `stopReason` says which.\n\n' +
      '**Idempotent.** Completing an already-completed interview returns the identical ' +
      'stored debrief and recomputes nothing — a double-tap must not write a second ' +
      'readiness snapshot for one interview.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiDataResponse(InterviewDebriefDto, {
    description: 'The debrief, and the readiness this completion produced',
  })
  @ApiResponse({ status: 404, description: 'No such interview for this caller' })
  @ApiResponse({
    status: 409,
    description: 'The interview is abandoned and cannot be completed',
  })
  completeInterview(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<InterviewDebrief> {
    return this.interviews.completeInterview(userId, id);
  }

  /**
   * Take one turn, and stream the officer's reply.
   *
   * ---------------------------------------------------------------------------
   * HAND-WRITTEN SSE, NOT `@Sse()` — THE SAME REASON `explainQuestion` GIVES
   * ---------------------------------------------------------------------------
   *
   * `@Sse()` hard-codes `RequestMethod.GET`, and this route takes a body (the
   * applicant's text), which a GET cannot reliably carry through the world's
   * proxies and clients. So the transport is written out below, modelled line
   * for line on `civics.controller.ts`'s own handler rather than redesigned:
   * `hijack()`, an immediate `: connected` comment, an `AbortController` fired
   * from `close`, and a loop that breaks after the first non-`delta` frame.
   *
   * ---------------------------------------------------------------------------
   * EVERYTHING IS RESOLVED BEFORE A SINGLE BYTE IS WRITTEN
   * ---------------------------------------------------------------------------
   *
   * `submitTurn` is awaited here, while the response is still unwritten, and it
   * is `async`-returning-an-iterable rather than a generator for exactly that
   * reason. An unknown interview id (404), an interview that belongs to somebody
   * else (also 404), a completed one (409) and one with no turn left to take
   * (409) all throw before `hijack()`, so `HttpExceptionFilter` turns each into
   * an ordinary error envelope. Inside a generator the same throws would land
   * after `200 text/event-stream` was already on the wire, and a 404 would reach
   * the client as a stream that opened and broke.
   *
   * The grading, the `practice_attempts` row, the mastery schedule and the
   * interview's own counters are all committed by then too — the stream carries
   * the officer's WORDING and nothing that decides anything.
   *
   * ---------------------------------------------------------------------------
   * AUTH IS A HEADER. NEVER A QUERY PARAMETER.
   * ---------------------------------------------------------------------------
   *
   * An ordinary `Authorization: Bearer …`, which means a fetch-based SSE reader
   * rather than the native `EventSource` (it issues a GET and cannot send
   * headers). A `?token=` escape hatch is deliberately not supported: a live
   * credential in a URL lands in access logs, browser history and `Referer`.
   * The explain endpoint already requires the same client, so this adds no new
   * burden.
   *
   * ---------------------------------------------------------------------------
   * A DISCONNECT ABORTS THE UPSTREAM CALL
   * ---------------------------------------------------------------------------
   *
   * Inference runs on the learner's own key, so an abandoned officer turn is
   * money nobody will read the output of. The turns are still persisted — see
   * `InterviewsService.streamOfficerTurns`' `finally` — so reconnecting shows a
   * complete transcript rather than one missing the officer's last line.
   */
  @Post(':id/turns')
  @Auth()
  // 200, not the 201 a POST defaults to. The status line is written by hand
  // below; this decorator keeps the DOCUMENT honest about what the wire says.
  @HttpCode(HttpStatus.OK)
  @ApiProduces('text/event-stream')
  @ApiOperation({
    summary: 'Answer the officer (SSE)',
    description:
      'A `text/event-stream` carrying the officer’s reply to one applicant turn.\n\n' +
      '**The interview decides; the model only speaks.** Which question comes next, ' +
      'whether the answer was right, when the civics section stops and whether the ' +
      'learner passed are all computed server-side before this stream opens. The model is ' +
      'asked for one short acknowledgement sentence and nothing else, and the civics ' +
      'question itself is appended to that sentence **verbatim from the database** — it ' +
      'never passes through the model, so it cannot be paraphrased, translated, ' +
      'simplified or invented.\n\n' +
      '**No verdict is returned here.** Not a tick, not a score, not a hint. The engine ' +
      'knows the grade the instant it computes it and deliberately does not send it: the ' +
      'real interview gives no per-question feedback, and a rehearsal that does is ' +
      'coaching the learner to expect reassurance the actual event will never provide. ' +
      '`POST /api/interviews/{id}/complete` is where they find out.\n\n' +
      '**Frames.** An opening `: connected` comment so headers flush, then any number of ' +
      '`event: delta` frames whose `data` is `{"text":"…"}`, then **exactly one** terminal ' +
      'frame, always last. All three terminal frames carry `officerTurns`, `phase`, ' +
      '`turnIndex`, `progress` and `awaitingCompletion`:\n\n' +
      '- `event: done` — the officer’s turn is whole.\n' +
      '- `event: unavailable` — adds `{"cause":"no_user_key"|"ai_disabled"|"role_unbound"|' +
      '"capability_unsupported"}`. No call was attempted: the caller has stored no AI key, ' +
      'or an administrator has not finished configuring AI. **The interview continues ' +
      'unchanged** — same phase, same next question, same grading — with the officer using ' +
      'a neutral, code-owned line. Render the turn; do not render an error.\n' +
      '- `event: error` — adds `{"errorCode":"…","error":"…"}`. The call was attempted and ' +
      'did not finish. The interview still advanced, identically.\n\n' +
      '**One exchange can produce several officer turns.** The reading and writing tests ' +
      'are announced as skipped and consume no answer, and neither does the closing ' +
      'statement — so the last civics answer of an interview is followed by three officer ' +
      'turns at once. `awaitingCompletion: true` means the only remaining action is ' +
      '`complete`.\n\n' +
      '**Client note.** The native `EventSource` issues a GET and cannot send an ' +
      '`Authorization` header; use a fetch-based SSE reader. A token in the query string ' +
      'is deliberately not supported — it would put a live credential into access logs ' +
      'and browser history.\n\n' +
      '**Cost.** Disconnecting aborts the upstream request. The turn is still recorded.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiBody({
    type: InterviewTurnDto,
    description:
      '`text` is what the applicant said, up to 2000 characters. It may be empty — an ' +
      'applicant who says nothing has still taken their turn. There is no `questionId`, ' +
      'no `phase`, no `skipped`, no `revealed` and no `hintUsed`: which question this ' +
      'answers is the interview’s own state, and none of the practice screen’s ' +
      'affordances exists inside a rehearsal.',
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
            ': connected\n\nevent: delta\ndata: {"text":"Thank you. "}\n\n' +
            'event: delta\ndata: {"text":"Let us continue."}\n\n' +
            'event: done\ndata: {"phase":"civics","turnIndex":5,' +
            '"progress":{"civicsAsked":2,"civicsPlanned":10},' +
            '"awaitingCompletion":false,"officerTurns":[]}\n\n',
        },
      },
    },
  })
  @ApiResponse({ status: 404, description: 'No such interview for this caller' })
  @ApiResponse({
    status: 409,
    description:
      'The interview is completed or abandoned, or has no turn left to take',
  })
  async submitTurn(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: InterviewTurnDto,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const abort = new AbortController();

    // AWAITED BEFORE A SINGLE BYTE IS WRITTEN — see this method's doc comment.
    // Everything that can be a 404 or a 409, and everything that decides the
    // interview, happens inside this call.
    const frames = await this.interviews.submitTurn(userId, id, body, abort.signal);

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
      // Nest's own `@Sse()` sets it.
      'X-Accel-Buffering': 'no',
    });

    // THE OPENING COMMENT FRAME, IMMEDIATELY. A comment is invisible to
    // `EventSource` consumers, and writing one is what pushes the headers out of
    // Node's buffer now rather than whenever the first token happens to arrive.
    // Without it a learner mid-interview sees nothing at all until the model
    // responds, which is indistinguishable from a hung request.
    res.write(': connected\n\n');

    // Teardown, wired the way Nest's own SSE dispatch wires it: on `close` of
    // the RAW response. `writableEnded` is what tells the two cases apart — Node
    // emits `close` after a normal `end()` too, and aborting there would fire on
    // every successful request.
    let clientGone = false;
    res.on('close', () => {
      if (res.writableEnded) return;

      clientGone = true;
      abort.abort();
    });

    try {
      for await (const frame of frames) {
        // Checked BEFORE the write, not after: writing to a closed socket is an
        // error event nobody is listening for, and the point of noticing the
        // disconnect is to stop doing work for it.
        if (clientGone) break;

        res.write(frameFor(frame));

        // A terminal frame is the last thing on the wire, by contract
        // (`InterviewTurnFrame`). Breaking here rather than trusting the
        // iterable to end makes "exactly one terminal frame" a property of the
        // TRANSPORT as well as of the producer — a stream that yielded something
        // after `done` could not smuggle it out.
        if (frame.event !== 'delta') break;
      }
    } catch (err) {
      // Reached only for a fault in this loop itself — the service and the
      // dispatcher below it never throw from their iterators. The exception
      // filter cannot help once `200` is on the wire, so the failure has to
      // arrive as the transport's own terminal event; a connection dropped
      // without one leaves a browser waiting forever on a request that is over.
      this.logger.error(
        `Interview turn stream failed for user ${userId} on interview ${id}: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );

      if (!clientGone) {
        res.write(
          `event: error\ndata: ${JSON.stringify({
            errorCode: 'stream_transport_error',
            // No prompt, no completion, no exception text, and nothing the
            // applicant typed: the same rule `AiDispatchService` holds one layer
            // down, held here because a transport error message is the easiest
            // place to lose it.
            error: 'The officer’s reply could not be delivered.',
          })}\n\n`,
        );
      }
    } finally {
      // Only when the socket is still ours to close. `end()` on a response whose
      // connection is already gone is a no-op at best and an unhandled error at
      // worst.
      if (!clientGone) res.end();
    }
  }
}

/**
 * One frame, in SSE's wire format.
 *
 * `event:` then `data:` then a BLANK LINE, which is what actually dispatches the
 * event on the client. `JSON.stringify` output contains no newline, so a single
 * `data:` line is always sufficient here.
 */
function frameFor(frame: InterviewTurnFrame): string {
  return `event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`;
}
