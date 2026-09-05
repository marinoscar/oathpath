import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';

import { ApiDataResponse } from '../common/decorators/api-data-response.decorator';
import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PracticeService } from './practice.service';
import { CreatePracticeSessionDto } from './dto/create-practice-session.dto';
import { PracticeSessionQueryDto } from './dto/practice-session-query.dto';
import { PracticeQueueDto, type PracticeQueueResponse } from './dto/practice-queue.dto';
import { RecordAttemptDto } from './dto/record-attempt.dto';
import {
  PracticeAttemptDto,
  type PracticeAttemptResponse,
} from './dto/practice-attempt.dto';
import {
  PracticeRealtimeSessionFailedDto,
  PracticeRealtimeSessionOkDto,
  PracticeRealtimeSessionUnavailableDto,
  type PracticeRealtimeSessionResponse,
} from './dto/practice-realtime-session.dto';
import { PracticeRealtimeService } from './realtime/practice-realtime.service';
import { PRACTICE_REALTIME_SESSION_TTL_SECONDS } from './realtime/practice-realtime-tools';
import {
  PracticeAttemptResultDto,
  PracticeSessionDetailDto,
  PracticeSessionDto,
  PracticeSessionListItemDto,
  PracticeSessionStateDto,
  type PracticeAttemptResult,
  type PracticeSessionDetail,
  type PracticeSessionResponse,
  type PracticeSessionState,
} from './dto/practice-session.dto';

// =============================================================================
// PracticeController (issue #73, epic #52 / E3)
// =============================================================================
//
//   POST /api/practice/sessions                                  @Auth(), none
//   GET  /api/practice/sessions                                  @Auth(), none
//   GET  /api/practice/sessions/:id                              @Auth(), none
//   POST /api/practice/sessions/:id/attempts                     @Auth(), none
//   POST /api/practice/sessions/:id/attempts/:attemptId/self-mark @Auth(), none
//   POST /api/practice/sessions/:id/complete                     @Auth(), none
//   GET  /api/practice/queue                                     @Auth(), none
//   POST /api/practice/sessions/:id/realtime-session             @Auth(), none  (#353, E15)
//
// `GET /queue` is issue #78 (epic #54 / E5 "Memory"): the Practice page's
// picker counts, drawn from `mastery/selector.ts`'s own bucket rule so they
// can never disagree with what starting a session right now would select.
//
// The last route is issue #353 (epic #345 / E15): the realtime mint, which
// hands the browser a short-lived credential for a spoken practice session and
// is the ONE route in this file that delegates to something other than
// `PracticeService` — see `realtime/practice-realtime.service.ts` for why the
// dispatcher stays off the class that writes every attempt row. It adds no
// permission string, for the same reason nothing else here has one, and it
// takes NO REQUEST BODY at all: the instructions, the tools and the session's
// lifetime are the server's, and a body would be the first field through which
// a caller could ask for a session that is not this practice session's.
//
// -----------------------------------------------------------------------------
// NO ROUTE ACCEPTS A USER ID. THAT IS THE SECURITY BOUNDARY.
// -----------------------------------------------------------------------------
//
// `@CurrentUser('id')` is the ONLY source of a user id in this file — not a
// path parameter, not a query parameter, not a body field. Both request DTOs
// carry a compile-time proof that no identity-shaped field crept into them, and
// both query DTOs are `z.strictObject`, so `?userId=…` is a 400 naming the
// parameter rather than something a later edit might start honouring.
//
// Every session id in a path IS caller-supplied, and that is exactly why
// `PracticeService.requireSession` filters on `userId` in the `where` of the
// single query that loads a session, rather than loading it and checking after.
// **Another learner's session is a 404, not a 403** — naming a resource you may
// not see is itself a leak, and from this caller's position it genuinely does
// not exist. The attempt id nested under it inherits the same property for
// free: it is only ever resolved within an already-owner-scoped session.
//
// An Admin gets no special path either. Same structural property, not a
// permission check a refactor could relax: `PracticeService` has no "read any
// learner's sessions" method for a future controller to reach for.
//
// -----------------------------------------------------------------------------
// `@Auth()` WITH NO PERMISSIONS, AND NO NEW PERMISSION STRING
// -----------------------------------------------------------------------------
//
// Every authenticated user owns their own practice history, exactly as they own
// their own learner profile (`journey.controller.ts`) and their own AI key
// (`ai/ai-user-key.controller.ts`). Gating these would leave a Viewer — the
// DEFAULT role every new account gets — unable to practise, which is the entire
// product.
//
// This is also the `storage_objects` posture `CLAUDE.md`'s RBAC section
// describes: ownership governs access, decided per row inside the service,
// because a `PermissionsGuard` here would reject the ordinary case. ROADMAP
// §7's permission set is closed and practice-sessions.md §10 says plainly that
// this epic introduces nothing into it. It does not.
//
// -----------------------------------------------------------------------------
// WHY THE ATTEMPT ROUTES ARE NESTED UNDER THE SESSION
// -----------------------------------------------------------------------------
//
// practice-sessions.md §10 sketches `POST /api/practice/attempts/:id/self-mark`
// as a top-level route. This module nests it —
// `/sessions/:id/attempts/:attemptId/self-mark` — because the nesting IS the
// authorisation: resolving the session first, by owner, means an attempt id can
// never be probed on its own. A top-level attempt route would need its own
// ownership check, correct in a second place, and the reason `requireSession`
// is the single door would be gone.
//
// The cost is one redundant id in the URL, and the tradeoff only exists for E3.
// `practice_attempts.sessionId` is nullable by design (E8's mock-interview
// attempts have no session, §2.2), so whatever writes those will need its own
// route shape anyway — nesting here does not paint that in.
// =============================================================================

/**
 * `{ data: <one of these>, meta? }`, with `status` as the discriminator.
 *
 * The same helper `ai-speech.controller.ts` and `interviews.controller.ts`
 * already carry, copied rather than shared for the reason they give: it exists
 * because `createZodDto` builds a class and a class cannot extend a union
 * (TS2509), so a union response has to be published as one DTO per member and
 * composed by hand here.
 */
function envelopedOneOf(
  ...models: Parameters<typeof getSchemaPath>[0][]
): SchemaObject {
  return {
    type: 'object',
    required: ['data'],
    properties: {
      data: {
        oneOf: models.map((model) => ({ $ref: getSchemaPath(model) })),
        discriminator: { propertyName: 'status' },
      },
      meta: { type: 'object', additionalProperties: true },
    },
  };
}

@ApiTags('Practice')
// Referenced by `$ref` from the hand-written `oneOf` below, so nothing else in
// the document would pull them in — without this they are dangling references.
@ApiExtraModels(
  PracticeRealtimeSessionOkDto,
  PracticeRealtimeSessionUnavailableDto,
  PracticeRealtimeSessionFailedDto,
)
@Controller('practice')
export class PracticeController {
  constructor(
    private readonly practiceService: PracticeService,
    private readonly practiceRealtime: PracticeRealtimeService,
  ) {}

  @Post('sessions')
  @Auth()
  @ApiOperation({
    summary: 'Start a practice session',
    description:
      'Opens a session and returns it together with its **first question, prompt only**.\n\n' +
      '`kind` is `quick` (a "Quick 5" across the learner\'s whole test version) or ' +
      '`category` (one section). The other three values of the underlying enum — ' +
      '`review`, `weak`, `mixed` — are declared in the database for E5\'s spaced-' +
      'repetition scheduler and are **not accepted here**; requesting one is a 400.\n\n' +
      '`categoryId` is **required** when `kind` is `category` and **rejected** otherwise. ' +
      'A quick session carrying one is a 400 rather than a session that quietly ignored ' +
      'the only filter the client asked for.\n\n' +
      '**Any session still `in_progress` for this learner is closed first** — set to ' +
      '`abandoned`, keeping every attempt it already produced. At most one session is ' +
      'open at a time, and a new start is the moment the old one is proven unfinished; ' +
      'there is no timer sweeping stale sessions.\n\n' +
      '**Question selection (v1)**: the learner\'s own test version, their category when ' +
      'given, and — if they claim the 65/20 senior accommodation — only ' +
      '`seniorEligible` questions. Questions that cannot be graded for them are removed ' +
      'from the pool entirely rather than served: a `state`-scope question ("who is the ' +
      'Governor of your state") for a learner with no state set has no resolvable ' +
      'answer, so spending one of five questions on it would teach and measure nothing. ' +
      'What remains is ordered **unseen-first** — questions they have never attempted ' +
      'before questions they have — with each group shuffled.\n\n' +
      '`plannedCount` defaults to 5 and is clamped down to the number of questions ' +
      'actually available, so "4 of 5" on the summary screen is always honest.\n\n' +
      '**No accepted answer appears in this response.** The question carries `id`, ' +
      '`number`, `prompt`, `categoryId` and `dynamicScope`, and nothing else — answers ' +
      'arrive with the grade, never with the prompt.\n\n' +
      'Scoped to the caller. There is no parameter or body field that names a user or a ' +
      'test version.',
  })
  @ApiDataResponse(PracticeSessionStateDto, {
    status: 201,
    description: 'The new session, its first question, and progress at 0',
  })
  @ApiResponse({
    status: 400,
    description:
      'Invalid body, or the caller has not finished orientation so no test version is resolved',
  })
  @ApiResponse({ status: 404, description: 'Unknown category for this test version' })
  @ApiResponse({
    status: 409,
    description: 'No questions are available to practise for this selection',
  })
  createSession(
    @CurrentUser('id') userId: string,
    @Body() body: CreatePracticeSessionDto,
  ): Promise<PracticeSessionState> {
    return this.practiceService.createSession(userId, body);
  }

  @Get('sessions')
  @Auth()
  @ApiOperation({
    summary: "List the caller's recent practice sessions",
    description:
      'The caller\'s own sessions, **newest first**, paginated with the same ' +
      '`page`/`pageSize` shape every other list in this API uses.\n\n' +
      'Each item carries `kind`, `status`, `startedAt`, `completedAt`, `plannedCount`, ' +
      'and live `answeredCount`/`correctCount` counted from the attempt rows — not from ' +
      'the stored `summary`, which exists only on a completed session. A session ' +
      'abandoned after three of five still reports three.\n\n' +
      'There are deliberately no filters: "recent sessions" is the one question this ' +
      'endpoint answers, and it is the one query the table\'s single index serves.\n\n' +
      'Scoped to the caller. An unknown query parameter — `?userId=` included — is a 400.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiDataResponse(PracticeSessionListItemDto, {
    pagination: 'flat',
    description: 'A page of the caller’s sessions, newest first',
  })
  listSessions(
    @CurrentUser('id') userId: string,
    @Query() query: PracticeSessionQueryDto,
  ) {
    return this.practiceService.listSessions(userId, query);
  }

  @Get('sessions/:id')
  @Auth()
  @ApiOperation({
    summary: 'Resume or review one session',
    description:
      'One session, every attempt recorded against it, and — while it is still ' +
      '`in_progress` and has fewer attempts than it planned — the **next unanswered ' +
      'question, prompt only**. A completed or abandoned session returns ' +
      '`nextQuestion: null`.\n\n' +
      'Each attempt carries the learner\'s own `responseText`, the `outcome`, the ' +
      '`gradingMethod` that produced it, and its `answerSnapshot`: **the accepted ' +
      'answers exactly as they stood when that attempt was graded**, frozen and never ' +
      're-resolved. That is what keeps a debrief honest a year later, after a dynamic ' +
      'answer ("who is the Speaker of the House") has been corrected — the learner sees ' +
      'what they were graded against, not what is true today.\n\n' +
      '**A session belonging to another learner is a 404, not a 403.** Confirming that ' +
      'an id names a real session would itself be the leak.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiDataResponse(PracticeSessionDetailDto, {
    description: 'The session, its attempts, and the next question',
  })
  @ApiResponse({ status: 404, description: 'No such session for this caller' })
  getSession(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PracticeSessionDetail> {
    return this.practiceService.getSession(userId, id);
  }

  @Post('sessions/:id/attempts')
  @Auth()
  @ApiOperation({
    summary: 'Answer a question, and be graded',
    description:
      'Grades one response and writes one `practice_attempts` row — the evidence every ' +
      'later feature reads.\n\n' +
      '**Grading is deterministic and has no AI in it.** The response is compared ' +
      'against the question\'s currently accepted answers, first raw and case-sensitive, ' +
      'then after a documented seven-step normalisation (case, filler openings like ' +
      '"I think it\'s", possessives and punctuation, `U.S.` → `United States`, leading ' +
      'articles, number words to digits). There is **no fuzzy matching**: a near miss is ' +
      '`incorrect`, and the self-mark route below is the learner\'s recourse.\n\n' +
      '`skipped: true` is recorded as `outcome: "skipped"` with no response — a skip is ' +
      'real evidence, not a dropped request. `revealed` and `hintUsed` are recorded ' +
      'independently and change no outcome: a revealed-then-answered attempt grades ' +
      'exactly as an unrevealed one does, it is simply weaker evidence of recall.\n\n' +
      '`durationMs` is optional and should be **omitted**, never sent as `0`, when the ' +
      'client cannot measure it — `0` would claim the learner answered instantly.\n\n' +
      'The response carries `acceptedAnswers` — this is the first point at which they ' +
      'are shown, and they are earned: the attempt is already recorded. The same list is ' +
      'frozen into `attempt.answerSnapshot`, so the screen and the permanent record ' +
      'cannot disagree.\n\n' +
      '`nextQuestion` is prompt-only and null once the planned count is reached. ' +
      '`progress.answered` is counted from the persisted rows on every response, so two ' +
      'tabs and a resumed session all agree.\n\n' +
      'One attempt per question per session: a repeat is a 409. Answering a question ' +
      'again is a new session.\n\n' +
      '**Voice (E9).** `inputMode` (`typed`/`spoken`) and `promptMode` (`read`/`heard`) ' +
      'default to the pre-voice values, so an existing client keeps working unchanged. ' +
      'A spoken attempt that was actually answered must also send `transcript` — the ' +
      'text the learner **confirmed** after seeing what the recogniser returned, which ' +
      'is the step that keeps an accent from costing them the answer — and may send ' +
      '`asrConfidence`. Omit `asrConfidence` when there is none: absent means unknown, ' +
      'and a sent `0` would claim the recogniser was certain it heard nothing. Neither ' +
      'field is accepted on a typed attempt or on a skip.\n\n' +
      'The server, never the client, decides what a low confidence means: below the ' +
      'confidence threshold, an outcome that is not `correct` is recorded with ' +
      '`failureCause: "misheard"`, overriding any cause the AI grader supplied.\n\n' +
      '**One retry, and only one.** `retryOfAttemptId` is the single exception to the ' +
      'one-attempt-per-question rule: it must name an attempt of yours, in this ' +
      'session, at this question, that is not itself a retry and has not already been ' +
      'retried — anything else is a 404 (unknown attempt) or a 409. The superseded ' +
      'attempt is kept and still returned, but stops counting toward `progress.answered` ' +
      'and the session summary, so a mishearing and its correction read as one answered ' +
      'question rather than two failures.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiDataResponse(PracticeAttemptResultDto, {
    status: 201,
    description: 'The graded attempt, the accepted answers, and what comes next',
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid body, or a question outside this session’s test version or category',
  })
  @ApiResponse({
    status: 404,
    description:
      'No such session for this caller, no such question, or no such attempt to retry',
  })
  @ApiResponse({
    status: 409,
    description:
      'The session is not in progress; this question was already answered in it and no valid ' +
      'retryOfAttemptId was sent; or the named attempt is itself a retry or has already been retried',
  })
  recordAttempt(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RecordAttemptDto,
  ): Promise<PracticeAttemptResult> {
    return this.practiceService.recordAttempt(userId, id, body);
  }

  @Post('sessions/:id/attempts/:attemptId/self-mark')
  @Auth()
  @ApiOperation({
    summary: 'Mark a graded attempt correct after all',
    description:
      '"I was right — the matcher just didn\'t recognise it." Flips a recorded ' +
      '`incorrect` or `skipped` attempt to `outcome: "correct"` with ' +
      '`gradingMethod: "self"`.\n\n' +
      '**A distinct route, and a distinct grading method, on purpose.** Deterministic ' +
      'matching will never accept a real paraphrase or an unanticipated synonym, and ' +
      'without this a learner who genuinely knew the answer is told they were wrong. ' +
      'But a self-mark must never be indistinguishable from a verified match: it counts ' +
      'as correct, and `gradingMethod` is how a later mastery model knows to weigh it ' +
      'less. That is why this is not a field on the attempt body.\n\n' +
      '**Reveal the accepted answer first** — a 409 otherwise. The claim being made is ' +
      '"my answer matched the accepted one", and that is only checkable against the ' +
      'accepted one, not against the learner\'s memory of what they think it was.\n\n' +
      '**Idempotent**: a second call on an already self-marked attempt returns the same ' +
      'state. An attempt already graded correct by the matcher is a 400 — there is ' +
      'nothing to grant, and overwriting `exact` with `self` would *downgrade* the ' +
      'record from a verified match to a learner\'s own claim.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiParam({ name: 'attemptId', type: String, format: 'uuid' })
  @ApiDataResponse(PracticeAttemptDto, {
    description: 'The attempt, now correct by self-assessment',
  })
  @ApiResponse({ status: 400, description: 'The attempt was already graded correct' })
  @ApiResponse({
    status: 404,
    description: 'No such session for this caller, or no such attempt in it',
  })
  @ApiResponse({ status: 409, description: 'The accepted answer has not been revealed yet' })
  selfMarkAttempt(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('attemptId', ParseUUIDPipe) attemptId: string,
  ): Promise<PracticeAttemptResponse> {
    return this.practiceService.selfMarkAttempt(userId, id, attemptId);
  }

  @Post('sessions/:id/complete')
  @Auth()
  @ApiOperation({
    summary: 'Finish a session and compute its summary',
    description:
      'Sets `status: "completed"`, stamps `completedAt`, and persists a `summary`.\n\n' +
      '**Every number in the summary is computed from the attempt rows that were ' +
      'actually written** — outcome counts, how many of the correct ones were ' +
      'self-marked, how many were revealed or used a hint, and the total reported ' +
      'duration. Nothing the client sent contributes to it. The summary is a cached ' +
      'rendering so the summary screen need not re-aggregate; if it ever disagreed with ' +
      'the attempts, the attempts are right.\n\n' +
      '`totalDurationMs` is null — never 0 — when no attempt reported a duration, and ' +
      '`timedAttempts` says how many it covers, so a partial total cannot be read as a ' +
      'complete one.\n\n' +
      '**Idempotent**: completing an already-completed session returns the stored ' +
      'summary unchanged and does not move `completedAt`. The moment a learner finished ' +
      'stays the moment they finished. An abandoned session is a 409 — it was closed by ' +
      'a later session start and has no completion to record.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiDataResponse(PracticeSessionDto, {
    status: 201,
    description: 'The completed session, with its computed summary',
  })
  @ApiResponse({ status: 404, description: 'No such session for this caller' })
  @ApiResponse({ status: 409, description: 'The session was abandoned and cannot be completed' })
  completeSession(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PracticeSessionResponse> {
    return this.practiceService.completeSession(userId, id);
  }

  @Get('queue')
  @Auth()
  @ApiOperation({
    summary: "The caller's practice queue counts",
    description:
      'Counts for the Practice page\'s picker — how many questions are **due**, **weak**, ' +
      '**new** (broken down by category), **steady**/in-progress, and **mastered** — plus ' +
      'the whole bank\'s `total` for the caller\'s own resolved test version.\n\n' +
      'Every count comes from `mastery/selector.ts`\'s `classifyMasteryBucket`, the exact ' +
      'same function `POST /api/practice/sessions` uses to order a session\'s questions, so ' +
      'this endpoint can never disagree with what starting a session right now would ' +
      'actually select.\n\n' +
      '`due` is `state IN (review, lapsed)` with `dueAt` already passed. `weak` is a ' +
      '`lapsed` question (any `dueAt`) or a `learning`/`review` question with repeated ' +
      'lapses or a broken correct streak — the same struggling-content signal the review ' +
      'queue reacts to. `new.total`/`new.byCategory` are never-attempted questions (or ' +
      '`state: \'new\'`), so the picker can show where coverage is thinnest. `mastered` is ' +
      'the pool the selector samples from once everything else is exhausted.\n\n' +
      'Scoped exactly like session creation: the caller\'s own test version, and ' +
      '`seniorEligible` only, under the 65/20 accommodation.',
  })
  @ApiDataResponse(PracticeQueueDto, {
    description: 'Queue counts for the picker, by bucket and by category',
  })
  @ApiResponse({
    status: 400,
    description: 'The caller has not finished orientation so no test version is resolved',
  })
  getQueue(@CurrentUser('id') userId: string): Promise<PracticeQueueResponse> {
    return this.practiceService.getQueue(userId);
  }

  /**
   * Mint one ephemeral realtime session credential for this practice session.
   *
   * ---------------------------------------------------------------------------
   * THE SUCCESS BODY IS A CREDENTIAL, NOT DATA
   * ---------------------------------------------------------------------------
   *
   * The browser never sees the learner's API key — only an ephemeral,
   * session-scoped secret. A long-lived key handed to browser JavaScript is a
   * key in the network tab, in browser history, and readable by any script on
   * the page, and it keeps working until a human revokes it. The secret this
   * route returns expires in about a minute and is scoped to a session
   * configuration this application authored for this one practice session.
   *
   * Three consequences visible in this handler:
   *
   *   * `@Header('Cache-Control', 'no-store')`. A cached mint response is a
   *     bearer credential sitting in a shared cache or a browser's disk cache
   *     for longer than it is valid — a liability with no matching benefit,
   *     since it cannot open a second session even while still readable.
   *   * NO REQUEST BODY. There is nothing for a client to configure: the
   *     instructions, the tools and the TTL are all the server's, and the model
   *     comes from the admin's `realtime` binding.
   *   * The secret is never logged, never a span attribute and never an
   *     `audit_events` row — see `PracticeRealtimeService`'s own header.
   *
   * ---------------------------------------------------------------------------
   * `unavailable` IS A 200 WITH A CAUSE, NEVER A 4xx OR A 5xx
   * ---------------------------------------------------------------------------
   *
   * The posture `ai-speech.controller.ts` already takes, for the reason
   * `ai-speech.dto.ts` states in full: a non-2xx is flattened into generic
   * failure handling and the cause — the one fact this response exists to
   * carry — never reaches the screen. An unbound `realtime` role is not an
   * error; it is a deployment where spoken practice is not configured, and the
   * client's correct response is to fall back to E13's hands-free loop or to
   * typing, with no loss of progress: both drive the same session and the same
   * `practice_attempts` rows.
   *
   * The 404 and the 409 below are different in kind and stay exception-shaped:
   * they are facts about the SESSION, not about AI.
   */
  @Post('sessions/:id/realtime-session')
  @Auth()
  // 200, not the 201 a POST defaults to. Nothing in this application is
  // created — a credential is minted at the provider — and there is no
  // resource this route could hand back a location for.
  @HttpCode(HttpStatus.OK)
  // See the doc comment. `no-store`, not merely `no-cache`.
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Mint a realtime session for this practice session',
    description:
      'Returns a **short-lived, single-session client secret** your browser uses to open ' +
      'a realtime voice connection directly to the AI provider. The audio never passes ' +
      'through this API.\n\n' +
      '**It is never your API key.** Your own key does not leave the server on any code ' +
      `path. The secret returned here expires in roughly ${PRACTICE_REALTIME_SESSION_TTL_SECONDS} ` +
      'seconds — long enough to open the connection, not to hold a conversation — and a ' +
      'session already under way is not cut off when it expires. The response is ' +
      '`Cache-Control: no-store`; do not store it, and do not send it anywhere but the ' +
      'provider.\n\n' +
      '**There is no request body.** The coach’s instructions, the tools the model may ' +
      'call and the session’s lifetime are all decided server-side. There is no model ' +
      'parameter — the model is the one your administrator bound to the `realtime` role.\n\n' +
      '**The application still decides everything.** The model is given five tools ' +
      '(`next_question`, `grade_answer`, `repeat_question`, `skip_question`, ' +
      '`end_session`) and no way to choose a question, report a grade, or end the session ' +
      'early: `grade_answer` has no `verdict` and no `confidence` field at all, question ' +
      'selection stays with the spaced-repetition scheduler, and the question text comes ' +
      'back from `next_question` to be spoken verbatim.\n\n' +
      '**Re-mint freely while the session is `in_progress`.** If the secret expires or the ' +
      'connection drops, call this again — the session resumes at whatever question is ' +
      'still unanswered, because that state is server-side and was never held in the ' +
      'expired session.\n\n' +
      '**Read `status`.** `ok` carries the secret. `unavailable` means no mint was ' +
      'attempted — you have stored no AI key, or an administrator has not bound a ' +
      '`realtime` model — and names the `cause` and the `role`. `failed` means the mint ' +
      'was attempted and did not produce a usable session. **All three are HTTP 200**; a ' +
      'non-2xx would discard the cause, which is the one fact this response exists to ' +
      'carry. On either, practise by voice through the ordinary push-to-talk flow, or by ' +
      'typing — the session and its recorded attempts are identical.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiOkResponse({
    description:
      'The ephemeral secret, or a typed reason there is none. Read `status`. Never ' +
      'cached — the response is `Cache-Control: no-store`.',
    schema: envelopedOneOf(
      PracticeRealtimeSessionOkDto,
      PracticeRealtimeSessionUnavailableDto,
      PracticeRealtimeSessionFailedDto,
    ),
  })
  @ApiResponse({ status: 404, description: 'No such session for this caller' })
  @ApiResponse({
    status: 409,
    description:
      'The session is completed or abandoned, or has no question left to ask — there is ' +
      'nothing left for a realtime session to conduct',
  })
  createRealtimeSession(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PracticeRealtimeSessionResponse> {
    return this.practiceRealtime.createRealtimeSession(userId, id);
  }
}
