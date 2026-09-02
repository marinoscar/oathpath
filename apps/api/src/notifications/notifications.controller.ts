import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Sse,
} from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Observable } from 'rxjs';

import { ApiDataResponse } from '../common/decorators/api-data-response.decorator';
import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { NOTIFICATION_EVENTS } from './notification-events';
import {
  NotificationStreamService,
  type SseMessage,
} from './notification-stream.service';
import { NotificationStoreService } from './notification-store.service';
import {
  NotificationEventDto,
  type NotificationEventResponse,
} from './dto/notification-event.dto';
import {
  NotificationDto,
  NotificationListQueryDto,
  UnreadCountDto,
  type NotificationListResponse,
  type UnreadCountResponse,
} from './dto/notification.dto';

// =============================================================================
// NotificationsController (issues #124/#127, epic #109)
// =============================================================================
//
// #124 shipped one endpoint here: the event registry. #127 adds the browser
// channel's entire read surface — the live stream and the four calls behind
// the notification centre.
//
// -----------------------------------------------------------------------------
// EVERY ENDPOINT BELOW IS SCOPED TO THE CALLER, AND THERE IS NO USER ID INPUT
// -----------------------------------------------------------------------------
//
// This is the security property epic #109 hangs on #127, so it is worth
// stating in the one file where it could be broken by a single added
// parameter: `@CurrentUser('id')` is the ONLY source of a user id in this
// controller. Not a path parameter, not a query parameter, not a body field.
// There is no `GET /notifications?userId=…` to forget to authorise, and no
// admin variant that takes an id — a route that could name another user is a
// route somebody has to remember to guard, and #127 chose to have none.
//
// The service layer holds the second half of the same guarantee: every
// statement in `notification-store.service.ts` carries `userId` in its `where`
// clause rather than checking ownership after the fact. See its header.
// =============================================================================

@ApiTags('Notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly store: NotificationStoreService,
    // `streams`, plural, and not `stream`: the handler below is named `stream`
    // and a field of the same name shadows it on the class.
    private readonly streams: NotificationStreamService,
  ) {}

  @Get('events')
  @Auth()
  @ApiOperation({
    summary: 'List notification events',
    description:
      'The registry of events this application can raise, in the order the ' +
      'preferences UI should render them. Readable by **any authenticated user** — ' +
      'every user renders their own preferences against it.\n\n' +
      'This describes what events *exist*, not what the caller has chosen. An event ' +
      'with `mandatory: true` cannot be switched off; that is enforced server-side ' +
      'during delivery, and the flag is here so the UI can show the control disabled ' +
      'with a reason rather than hiding it.',
  })
  @ApiDataResponse(NotificationEventDto, {
    isArray: true,
    description: 'The notification event registry',
  })
  listEvents(): NotificationEventResponse[] {
    // Mapped field by field rather than returned directly, for three reasons:
    //
    //   1. `mandatory` is normalised from `boolean | undefined` to `boolean`,
    //      so no client has to know that absent means "the user is in charge".
    //   2. `channels` is COPIED. The arrays in `NOTIFICATION_EVENTS` are the
    //      registry's own state and this is a module-level constant living for
    //      the process lifetime; handing out the live array would let a
    //      serialiser or an interceptor that sorts in place reconfigure
    //      delivery for every later dispatch.
    //   3. The response shape is decided here, in code that is about the
    //      response shape. A spread would make it a consequence of whatever
    //      the registry happens to hold, so a field added for the dispatcher's
    //      internal use would silently become public API.
    return NOTIFICATION_EVENTS.map((event) => ({
      key: event.key,
      label: event.label,
      description: event.description,
      channels: [...event.channels],
      defaultEnabled: event.defaultEnabled,
      mandatory: event.mandatory === true,
    }));
  }

  // ---------------------------------------------------------------------------
  // The live stream (#127)
  // ---------------------------------------------------------------------------

  /**
   * Server-Sent Events for the calling user's notifications.
   *
   * -----------------------------------------------------------------------------
   * WHY `@Sse()` AND NOT A HAND-WRITTEN `@Res()` HANDLER
   * -----------------------------------------------------------------------------
   *
   * This app runs the FASTIFY adapter, and the reflex worry is that `@Sse()` is
   * Express-shaped. It is not, as of the Nest 11 this project pins: the SSE
   * dispatch in `router-execution-context` unwraps `res.raw ?? res`, so under
   * Fastify the framework's `SseStream` is piped to the underlying Node
   * `ServerResponse` — which has the `writeHead`/`flushHeaders` it needs. The
   * mechanism is the same one Express gets.
   *
   * Choosing it over hand-writing frames onto a `@Res()` reply buys, for free
   * and already tested:
   *
   *   * The header set, INCLUDING `X-Accel-Buffering: no` — the response-side
   *     half of the nginx buffering problem #127 describes. (The `location`
   *     block with `proxy_buffering off` is still required; that is #127's
   *     infra half and is not in this commit. Both halves are needed: nginx
   *     honours the header, but the read timeout is not something a header can
   *     change.)
   *   * Correct SSE framing, including multi-line `data:` splitting and
   *     `: comment` lines — the heartbeat mechanism below.
   *   * Socket tuning (`setKeepAlive`, `setNoDelay`, `setTimeout(0)`) so Node
   *     itself does not close an idle stream.
   *   * Teardown on client disconnect: it unsubscribes the Observable when the
   *     raw socket emits `close`, which is what runs the registry cleanup in
   *     `NotificationStreamService.subscribe`.
   *
   * A hand-written version would reimplement all of that, and would get the
   * header set subtly wrong the first time.
   *
   * -----------------------------------------------------------------------------
   * ONE CAVEAT FOR THE WEB CLIENT: `EventSource` CANNOT SEND AN `Authorization`
   * HEADER
   * -----------------------------------------------------------------------------
   *
   * This route is guarded by the ordinary `@Auth()` — the same
   * `Authorization: Bearer …` every other endpoint requires. The native
   * `EventSource` constructor takes no headers, so the browser half of #127
   * must connect with a fetch-based SSE client (`@microsoft/fetch-event-source`
   * or equivalent), which supports headers and reconnection both.
   *
   * A `?token=` QUERY PARAMETER WAS REJECTED, and should stay rejected. An
   * access token in a URL is written to the nginx access log, kept in browser
   * history, and forwarded in `Referer` — turning a 15-minute bearer credential
   * into something replayable from a log file that is retained for months and
   * read by people who are not supposed to hold sessions. Making the transport
   * convenient is not worth putting credentials in logs; the client-side
   * library is a smaller cost, paid once.
   *
   * -----------------------------------------------------------------------------
   * WHAT ARRIVES, AND WHAT DOES NOT
   * -----------------------------------------------------------------------------
   *
   * `event: notification` frames whose `data` is one `NotificationDto` (minus
   * `readAt` — it is unread by definition at that instant), plus periodic
   * `: heartbeat` comment lines that `EventSource` swallows without surfacing.
   *
   * NOT A DELIVERY GUARANTEE. Anything published while this connection is down
   * is gone: there is no buffer, no `Last-Event-ID` handling and no replay.
   * `EventSource` will reconnect on its own, and THE CLIENT MUST REFETCH
   * `GET /api/notifications/unread-count` AND `GET /api/notifications` ON EVERY
   * (RE)CONNECT rather than assuming the gap was filled. That is not a
   * shortcoming to fix later — it is the design: the `notifications` table is
   * the source of truth and one indexed query after a reconnect is strictly
   * more reliable than any replay mechanism built on top of a stream. The same
   * refetch also covers the multi-replica case documented on
   * `NotificationStreamService`.
   */
  @Sse('stream')
  @Auth()
  @ApiProduces('text/event-stream')
  @ApiOperation({
    summary: 'Stream this user’s notifications (SSE)',
    description:
      'A `text/event-stream` carrying **only the authenticated caller’s** notifications. ' +
      'There is no parameter that selects a user; the recipient is the bearer of the token.\n\n' +
      '**Frames.** `event: notification` with a JSON `data` payload matching `Notification` ' +
      '(without `readAt`), plus `: heartbeat` comment lines roughly every 25 seconds so ' +
      'proxies do not reap an idle connection.\n\n' +
      '**This is not a delivery guarantee.** Events published while the connection is down are ' +
      'lost — there is no replay and no `Last-Event-ID` support. `EventSource` reconnects by ' +
      'itself; the client must then refetch `GET /api/notifications/unread-count` and ' +
      '`GET /api/notifications`, which is what makes a gap harmless. The durable record is the ' +
      'notification list, not the stream.\n\n' +
      '**Client note.** The native `EventSource` cannot send an `Authorization` header. Use a ' +
      'fetch-based SSE client; a token in the query string is deliberately not supported, ' +
      'because it would put a live credential into access logs and browser history.',
  })
  @ApiOkResponse({
    description: 'An open event stream. Terminates when the client disconnects.',
    content: {
      'text/event-stream': {
        schema: {
          type: 'string',
          example:
            ': connected\n\nevent: notification\ndata: {"id":"…","eventKey":"security.role_changed",' +
            '"title":"Your roles changed","body":"…","link":"/settings","createdAt":"…"}\n\n: heartbeat\n\n',
        },
      },
    },
  })
  stream(@CurrentUser('id') userId: string): Observable<SseMessage> {
    // THE ENTIRE ISOLATION MECHANISM, IN ONE ARGUMENT. `userId` comes from the
    // verified JWT and from nowhere else, and `subscribe` registers this
    // connection under exactly that key. There is no filter to get wrong
    // because there is nothing to filter — this connection is never written to
    // by anything except a publish for this user.
    //
    // Returned SYNCHRONOUSLY (not `async`), so the Observable's own teardown
    // function is the complete cleanup story and no `@SseSignal()` is needed:
    // nothing is allocated before subscription, so nothing can leak if the
    // client disappears during setup.
    return this.streams.subscribe(userId);
  }

  // ---------------------------------------------------------------------------
  // The notification centre (#127)
  // ---------------------------------------------------------------------------

  @Get()
  @Auth()
  @ApiOperation({
    summary: 'List this user’s notifications',
    description:
      'The caller’s own notifications, newest first. **Any authenticated user** may read ' +
      'their own; there is no way to read anybody else’s — the recipient is the bearer of ' +
      'the token, not a parameter.\n\n' +
      'This is the durable surface of the browser channel. It is correct regardless of whether ' +
      'the user ever granted browser-notification permission, and regardless of whether the SSE ' +
      'stream was connected when the notification was raised.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiQuery({
    name: 'unreadOnly',
    required: false,
    enum: ['true', 'false'],
    description: 'Return only unread notifications. Defaults to `false`.',
  })
  @ApiDataResponse(NotificationDto, {
    pagination: 'flat',
    description: 'A page of the caller’s notifications',
  })
  async list(
    @CurrentUser('id') userId: string,
    @Query() query: NotificationListQueryDto,
  ): Promise<NotificationListResponse> {
    return this.store.list(userId, query);
  }

  @Get('unread-count')
  @Auth()
  @ApiOperation({
    summary: 'Count this user’s unread notifications',
    description:
      'The number behind the bell badge, for the authenticated caller only.\n\n' +
      'A separate endpoint rather than something derived from a page of `GET /api/notifications`: ' +
      'a count taken from a page silently caps at `pageSize` and under-reports. Clients should ' +
      'call this on load and again on every SSE (re)connect, which is how a gap in the stream is ' +
      'recovered from.',
  })
  @ApiDataResponse(UnreadCountDto, { description: 'The unread count' })
  async unreadCount(
    @CurrentUser('id') userId: string,
  ): Promise<UnreadCountResponse> {
    return { unreadCount: await this.store.unreadCount(userId) };
  }

  /**
   * `POST`, not `PATCH`, and `/read` rather than a body flag.
   *
   * Marking read is an ACTION with one possible outcome, not a partial
   * replacement of a resource whose fields a client may choose. `PATCH /:id`
   * with `{ readAt }` would invite a client to send an arbitrary timestamp for
   * a column that answers "when did they actually see this?"; there is no
   * legitimate reason for the client to pick that value, so the endpoint does
   * not accept it.
   */
  @Post(':id/read')
  @Auth()
  @ApiOperation({
    summary: 'Mark one notification read',
    description:
      'Marks a single notification read and returns the caller’s resulting unread count, ' +
      'so a click costs one round trip rather than two.\n\n' +
      '**Idempotent.** Marking an already-read notification succeeds and leaves the original ' +
      '`readAt` untouched.\n\n' +
      '**Ownership.** Only the caller’s own notifications can be marked. An id belonging to ' +
      'another user returns `404`, identical to an id that does not exist — the two are ' +
      'deliberately indistinguishable so the endpoint cannot be used to probe for valid ids.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiDataResponse(UnreadCountDto, { description: 'The new unread count' })
  @ApiResponse({ status: 404, description: 'No such notification for this user' })
  async markRead(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<UnreadCountResponse> {
    return { unreadCount: await this.store.markRead(userId, id) };
  }

  @Post('read-all')
  @Auth()
  // 200, not 204: the response carries the new count, which is the whole
  // reason a client calls this rather than marking rows one at a time.
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mark all of this user’s notifications read',
    description:
      'Clears the caller’s badge in one call and returns the resulting unread count — ' +
      'normally `0`, but not assumed to be: a notification arriving between the update and the ' +
      'count is reported honestly rather than hidden behind a hardcoded zero.\n\n' +
      'Affects only the caller’s rows. Notifications already read keep their original ' +
      '`readAt`.',
  })
  @ApiDataResponse(UnreadCountDto, { description: 'The new unread count' })
  async markAllRead(
    @CurrentUser('id') userId: string,
  ): Promise<UnreadCountResponse> {
    return { unreadCount: await this.store.markAllRead(userId) };
  }
}
