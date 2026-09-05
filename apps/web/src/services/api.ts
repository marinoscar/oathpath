/**
 * Where the API lives.
 *
 * EXPORTED as of #127. The notification SSE client (`services/sse.ts`) opens a
 * raw `fetch` outside `ApiService.request` — it has to, because that method
 * buffers a JSON body and an event stream never ends — and it must resolve its
 * URL against exactly the same base. A second literal `'/api'` there would be
 * a same-origin assumption that silently breaks the day `VITE_API_BASE_URL` is
 * set, in the one code path that fails by going quiet rather than by erroring.
 */
export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

interface RequestOptions extends RequestInit {
  skipAuth?: boolean;
  /**
   * How to read a SUCCESSFUL response body. Defaults to `'json'`.
   *
   * `'json'` unwraps the `{ data }` envelope the API's `TransformInterceptor`
   * puts around every JSON route. `'blob'` hands back the raw bytes untouched,
   * and exists for exactly one shape of route: one that answers with BYTES
   * rather than an envelope. `POST /api/ai/speech/synthesize` streams audio
   * (`docs/specs/voice.md` §9), and `response.json()` over an MP3 throws on the
   * first byte — so the choice has to be made HERE, before the body is read,
   * rather than by a caller trying to recover afterwards from a body that has
   * already been consumed.
   */
  responseType?: 'json' | 'blob';
}

class ApiService {
  private accessToken: string | null = null;
  private refreshPromise: Promise<boolean> | null = null;

  setAccessToken(token: string | null) {
    this.accessToken = token;
  }

  getAccessToken(): string | null {
    return this.accessToken;
  }

  private async request<T>(
    endpoint: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const { skipAuth = false, responseType = 'json', ...fetchOptions } = options;

    const headers: HeadersInit = {
      ...fetchOptions.headers,
    };

    // Only set Content-Type for requests with a body (Fastify 5 is strict about this)
    //
    // ...EXCEPT FOR A `FormData` BODY, WHICH MUST CARRY NO CONTENT-TYPE AT ALL.
    // A multipart request is only parseable if the header names the boundary
    // string that separates its parts — `multipart/form-data; boundary=…` — and
    // only the browser knows that string, because only the browser generated
    // it. It fills the header in itself, but ONLY when we have not already set
    // one. Overriding it with `application/json` produces a request no server
    // can parse: Fastify's multipart plugin never sees a file, and the failure
    // surfaces as a confusing complaint about a missing field rather than as
    // the header problem it actually is. `POST /api/ai/speech/transcribe`
    // (`docs/specs/voice.md` §9) is the first route in this app to send one.
    if (fetchOptions.body && !isFormData(fetchOptions.body)) {
      (headers as Record<string, string>)['Content-Type'] = 'application/json';
    }

    if (!skipAuth && this.accessToken) {
      (headers as Record<string, string>)['Authorization'] = `Bearer ${this.accessToken}`;
    }

    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
      ...fetchOptions,
      headers,
      credentials: 'include', // Include cookies for refresh token
    });

    if (response.status === 401 && !skipAuth) {
      // Try to refresh token (only once, avoid infinite loops)
      const refreshed = await this.refreshToken();
      if (refreshed) {
        // Update authorization header with new token and retry ONCE.
        //
        // BUILT FROM THE HEADERS THE FIRST ATTEMPT ACTUALLY SENT, not from a
        // second hand-written literal. The literal this replaced hard-coded
        // `Content-Type: application/json`, so a multipart upload that hit an
        // expired access token — the ordinary case after fifteen idle minutes —
        // would be retried with a JSON content type over a multipart body and
        // fail in a way the first attempt never could.
        //
        // THE `FormData` BODY ITSELF SURVIVES THE RETRY. `fetchOptions.body` is
        // a `FormData` object, not a consumed `ReadableStream`: `fetch`
        // serializes it afresh on each send, and the `Blob` parts inside it are
        // re-readable. (A caller passing a raw stream as `body` could NOT be
        // retried — that is why nothing in this file does.)
        const retryHeaders: HeadersInit = {
          ...headers,
          'Authorization': `Bearer ${this.accessToken}`,
        };

        const retryResponse = await fetch(`${API_BASE_URL}${endpoint}`, {
          ...fetchOptions,
          headers: retryHeaders,
          credentials: 'include',
        });

        if (!retryResponse.ok) {
          const error = await retryResponse.json().catch(() => ({}));
          throw new ApiError(
            error.message || 'Request failed',
            retryResponse.status,
            error.code,
            error.details,
          );
        }

        return this.parseResponse<T>(retryResponse, responseType);
      }
      throw new ApiError('Unauthorized', 401);
    }

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new ApiError(
        error.message || 'Request failed',
        response.status,
        error.code,
        error.details,
      );
    }

    return this.parseResponse<T>(response, responseType);
  }

  /**
   * Read a successful response body, once, the way the caller asked for.
   *
   * One method rather than the two identical copies this replaced (the ordinary
   * path and the post-refresh retry), because a body can only be read once and
   * the two copies drifting is a bug that shows up only on the retry — i.e.
   * only after a token expires, which is exactly when nobody is watching.
   */
  private async parseResponse<T>(
    response: Response,
    responseType: 'json' | 'blob',
  ): Promise<T> {
    // Handle 204 No Content
    if (response.status === 204) {
      return undefined as T;
    }

    if (responseType === 'blob') {
      // No envelope to unwrap and nothing to interpret: these are bytes.
      return (await response.blob()) as T;
    }

    const data = await response.json();
    return data.data ?? data;
  }

  async refreshToken(): Promise<boolean> {
    // If a refresh is already in progress, wait for it
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    // Start a new refresh
    this.refreshPromise = this.doRefreshToken();

    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  private async doRefreshToken(): Promise<boolean> {
    try {
      const response = await fetch(`${API_BASE_URL}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
      });

      if (!response.ok) {
        this.accessToken = null;
        return false;
      }

      const responseData = await response.json();
      // Unwrap the { data: { accessToken } } structure from TransformInterceptor
      const tokenData = responseData.data ?? responseData;

      // Validate that we actually got a token
      if (!tokenData.accessToken || typeof tokenData.accessToken !== 'string') {
        this.accessToken = null;
        return false;
      }

      this.accessToken = tokenData.accessToken;
      return true;
    } catch {
      this.accessToken = null;
      return false;
    }
  }

  // Generic methods
  get<T>(endpoint: string, options?: RequestOptions) {
    return this.request<T>(endpoint, { ...options, method: 'GET' });
  }

  post<T>(endpoint: string, body?: unknown, options?: RequestOptions) {
    return this.request<T>(endpoint, {
      ...options,
      method: 'POST',
      body: serializeBody(body),
    });
  }

  put<T>(endpoint: string, body?: unknown, options?: RequestOptions) {
    return this.request<T>(endpoint, {
      ...options,
      method: 'PUT',
      body: serializeBody(body),
    });
  }

  patch<T>(endpoint: string, body?: unknown, options?: RequestOptions) {
    return this.request<T>(endpoint, {
      ...options,
      method: 'PATCH',
      body: serializeBody(body),
    });
  }

  delete<T>(endpoint: string, options?: RequestOptions) {
    return this.request<T>(endpoint, { ...options, method: 'DELETE' });
  }
}

/**
 * `body instanceof FormData`, guarded for an environment without the global.
 *
 * Guarded rather than bare because this module is imported by tests and by any
 * future non-browser consumer, where a bare `instanceof` against an undefined
 * global is a `ReferenceError` on a line whose whole job is to answer "no".
 */
function isFormData(body: unknown): body is FormData {
  return typeof FormData !== 'undefined' && body instanceof FormData;
}

/**
 * Turn a caller's body into something `fetch` can send.
 *
 * `FormData` PASSES THROUGH UNTOUCHED, and that is the entire reason this
 * function exists. `JSON.stringify(someFormData)` is not an error — it is
 * `"{}"` — so a multipart upload sent down the JSON path fails SILENTLY, with a
 * perfectly well-formed request body containing none of the file it was
 * supposed to carry.
 *
 * The falsy check is the pre-existing behaviour, preserved deliberately: a
 * `post(url)` with no body must send no body.
 */
function serializeBody(body: unknown): BodyInit | undefined {
  if (!body) return undefined;
  if (isFormData(body)) return body;
  return JSON.stringify(body);
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const api = new ApiService();

// Import types
import type {
  AllowlistResponse,
  AllowedEmailEntry,
  UsersResponse,
  UserListItem,
  DeviceActivationInfo,
  DeviceAuthorizationResponse,
  PersonalAccessToken,
  PatCreatedResponse,
  PatDurationUnit,
  EmailSettings,
  EmailSettingsInput,
  EmailTestResult,
  AiSettings,
  AiSettingsInput,
  AiModelCatalog,
  AiTestResult,
  AiKeyStatus,
  AiStatus,
  AiUsage,
  SynthesizeResponse,
  SpeechVoicesResponse,
  TranscribeResponse,
  NotificationEventDef,
  AppNotification,
  NotificationListResponse,
  UnreadCountResponse,
  JourneyProfileResponse,
  UpdateJourneyProfileInput,
  JourneyHome,
  JourneyStage,
  CivicsAdminScope,
  CivicsAnswerCorrection,
  CivicsAnswerCorrectionResult,
  CivicsDynamicAnswerPage,
  CivicsCategory,
  CivicsQuestionDetail,
  CivicsQuestionListResponse,
  CreatePracticeSessionInput,
  PracticeAttempt,
  PracticeAttemptResult,
  PracticeSession,
  PracticeSessionDetail,
  PracticeSessionPage,
  PracticeSessionState,
  PracticeQueue,
  RecordPracticeAttemptInput,
  ProgressMastery,
  ReadinessSnapshotResponse,
  ReadinessHistoryResponse,
  CreateInterviewInput,
  InterviewDebrief,
  InterviewDetail,
  InterviewPage,
  InterviewState,
  RealtimeSessionResponse,
  RealtimeToolCallInput,
  RealtimeToolCallResponse,
  EngagementSummary,
  AccountDataSummary,
  AccountResetScope,
  AccountResetResult,
  EnglishAttemptResult,
  EnglishNextResponse,
  EnglishProgress,
  EnglishSegmentKind,
  RecordEnglishAttemptInput,
} from '../types';

// Allowlist API
/**
 * Sort keys `GET /api/allowlist` accepts, mirroring
 * `allowlistQuerySchema.sortBy` (`apps/api/src/allowlist/dto/allowlist-query.dto.ts`).
 */
export type AllowlistSortField = 'email' | 'addedAt' | 'claimedAt';

export async function getAllowlist(params?: {
  page?: number;
  pageSize?: number;
  search?: string;
  status?: 'all' | 'pending' | 'claimed';
  sortBy?: AllowlistSortField;
  sortOrder?: 'asc' | 'desc';
}): Promise<AllowlistResponse> {
  const searchParams = new URLSearchParams();
  if (params?.page) searchParams.set('page', String(params.page));
  if (params?.pageSize) searchParams.set('pageSize', String(params.pageSize));
  if (params?.search) searchParams.set('search', params.search);
  if (params?.status) searchParams.set('status', params.status);
  if (params?.sortBy) searchParams.set('sortBy', params.sortBy);
  if (params?.sortOrder) searchParams.set('sortOrder', params.sortOrder);

  return api.get<AllowlistResponse>(`/allowlist?${searchParams}`);
}

export async function addToAllowlist(
  email: string,
  notes?: string,
): Promise<AllowedEmailEntry> {
  return api.post<AllowedEmailEntry>('/allowlist', { email, notes });
}

export async function removeFromAllowlist(id: string): Promise<void> {
  await api.delete<void>(`/allowlist/${id}`);
}

// Users API
/**
 * Sort keys `GET /api/users` accepts, mirroring `userListQuerySchema.sortBy`
 * (`apps/api/src/users/dto/user-list-query.dto.ts`). Typed rather than
 * `string` so a DataTable column declaring `sortable` against a field the
 * endpoint would reject is a compile error, not a 400 at runtime.
 */
export type UserSortField = 'email' | 'createdAt' | 'updatedAt';

export async function getUsers(params?: {
  page?: number;
  pageSize?: number;
  search?: string;
  role?: string;
  isActive?: boolean;
  sortBy?: UserSortField;
  sortOrder?: 'asc' | 'desc';
}): Promise<UsersResponse> {
  const searchParams = new URLSearchParams();
  if (params?.page) searchParams.set('page', String(params.page));
  if (params?.pageSize) searchParams.set('pageSize', String(params.pageSize));
  if (params?.search) searchParams.set('search', params.search);
  if (params?.role) searchParams.set('role', params.role);
  if (params?.isActive !== undefined)
    searchParams.set('isActive', String(params.isActive));
  if (params?.sortBy) searchParams.set('sortBy', params.sortBy);
  if (params?.sortOrder) searchParams.set('sortOrder', params.sortOrder);

  return api.get<UsersResponse>(`/users?${searchParams}`);
}

export async function updateUser(
  id: string,
  data: { displayName?: string; isActive?: boolean },
): Promise<UserListItem> {
  return api.patch<UserListItem>(`/users/${id}`, data);
}

export async function updateUserRoles(
  id: string,
  roles: string[],
): Promise<UserListItem> {
  return api.put<UserListItem>(`/users/${id}/roles`, { roles });
}

// Device Activation API
export async function getDeviceActivationInfo(
  userCode: string,
): Promise<DeviceActivationInfo> {
  return api.get<DeviceActivationInfo>(`/auth/device/activate?code=${userCode}`);
}

export async function authorizeDevice(
  userCode: string,
  approve: boolean,
): Promise<DeviceAuthorizationResponse> {
  return api.post<DeviceAuthorizationResponse>('/auth/device/authorize', {
    userCode,
    approve,
  });
}

// Personal Access Tokens API
export async function getPersonalAccessTokens(): Promise<PersonalAccessToken[]> {
  return api.get<PersonalAccessToken[]>('/pat');
}

export async function createPersonalAccessToken(data: {
  name: string;
  durationValue: number;
  durationUnit: PatDurationUnit;
}): Promise<PatCreatedResponse> {
  return api.post<PatCreatedResponse>('/pat', data);
}

export async function revokePersonalAccessToken(id: string): Promise<void> {
  await api.delete<void>(`/pat/${id}`);
}

// Email settings API — issue #124, epic #109.
//
// Three calls, one controller (`system_settings:read` to read,
// `system_settings:write` to save or test), and the ONLY place in the web app
// that names these endpoints. The page and its hook speak in `EmailSettings`
// terms; if the API's routes or field names move, this block plus the types in
// `types/index.ts` are the entire reconciliation surface.
//
// The payloads are FLAT — `sesRegion`, `smtpHost`, `smtpPort` and friends are
// siblings, not members of `ses: {…}` / `smtp: {…}` sub-objects. See the note
// in `types/index.ts`; getting this wrong compiles cleanly and fails only at
// runtime, which is why it is written down in both places.

export async function getEmailSettings(): Promise<EmailSettings> {
  return api.get<EmailSettings>('/email-settings');
}

/**
 * Replace the stored email settings.
 *
 * PUT rather than PATCH because this is one small document edited on one
 * screen: a per-field merge would let a half-saved provider switch (SMTP host
 * written, SES region not) exist as a state nothing in the UI can show. The
 * one field with merge semantics is `smtpPassword`, and those semantics live
 * in the API (blank preserves — see `EmailSettingsInput`), not in a patch
 * document.
 *
 * `expectedVersion` becomes `If-Match`, the same optimistic-concurrency
 * mechanism `useSystemSettings` uses against `/system-settings`, because the
 * API offers it here too and a settings row with a version counter and no
 * caller checking it is a lost-update waiting to happen: two admins on this
 * page, and the second save silently discards the first with nothing on either
 * screen to show it. A mismatch is a 409, which the hook turns into a reload
 * plus a message rather than an overwrite.
 *
 * PASSED THROUGH AS-IS, INCLUDING ZERO. `0` is the API's way of asserting "I
 * believe nothing is stored yet", so the check is `=== undefined` and never a
 * truthiness test — `if (expectedVersion)` would drop the guard on exactly the
 * first save, where two admins configuring a fresh deployment collide.
 */
export async function updateEmailSettings(
  input: EmailSettingsInput,
  expectedVersion?: number,
): Promise<EmailSettings> {
  return api.put<EmailSettings>('/email-settings', input, {
    headers:
      expectedVersion === undefined
        ? undefined
        : { 'If-Match': String(expectedVersion) },
  });
}

/**
 * Send a test message to the CALLER'S OWN address, using the SAVED settings.
 *
 * No recipient parameter, deliberately: a free-text "send to" box on an
 * authenticated admin form is a send-arbitrary-mail endpoint wearing a
 * diagnostic hat (#124's own rejected alternative). The caller's identity is
 * already on the request, so the API resolves the recipient itself.
 *
 * RESOLVES ON FAILURE. A provider that refuses the message still produces a
 * 200 carrying `{ success: false, error }`; only a transport or authorization
 * failure rejects. Callers MUST branch on `result.success`.
 */
export async function sendTestEmail(): Promise<EmailTestResult> {
  return api.post<EmailTestResult>('/email-settings/test');
}

/**
 * The notification event registry — `GET /api/notifications/events` (#124).
 *
 * AUTHENTICATED, NOT ADMIN-GATED. Every signed-in user reads this; it is what
 * `/settings/notifications` renders its matrix against, and that page belongs
 * to every role. A `system_settings:read` reflex here would leave a Viewer with
 * a preferences page and no rows in it.
 *
 * THE WEB APP DOES NOT KEEP A COPY OF THIS LIST, deliberately. `mandatory` is a
 * security flag, and a second declaration of a security flag is a second place
 * for it to be wrong; a duplicated registry would also break epic #109's
 * headline promise that adding a notification costs ONE registry entry. The
 * consequence is that the preferences page renders whatever the server serves,
 * including events added after this build shipped.
 *
 * The response is ORDERED and the order is meaningful — it is the order the
 * preferences UI should render. Do not sort it.
 */
export async function getNotificationEvents(): Promise<NotificationEventDef[]> {
  return api.get<NotificationEventDef[]>('/notifications/events');
}

// Notification centre API — issue #127, epic #109.
//
// The four REST calls behind the bell. The fifth endpoint of this controller —
// `GET /api/notifications/stream` — is deliberately NOT here: it is an
// unbounded `text/event-stream` and `ApiService.request` awaits `response.json()`,
// which on a stream that never ends never resolves. It lives in
// `services/notificationStream.ts` on top of the fetch-based SSE client.
//
// NOT ONE OF THESE CALLS NAMES A USER, in a path, a query or a body. Every one
// operates on the authenticated caller's own rows, resolved server-side from
// the JWT (`@CurrentUser('id')`). There is no `?userId=` to add here, and
// adding one would not work: the API has no parameter for it, by design — see
// the header of `apps/api/src/notifications/notifications.controller.ts`.

/**
 * A page of the caller's notifications, newest first.
 *
 * THE DURABLE SURFACE. This is correct whether or not the user ever granted
 * browser-notification permission and whether or not the SSE stream was
 * connected when a notification was raised, which is why the centre is built on
 * it and the native toast is decoration on top.
 *
 * `unreadOnly` is sent as the STRING `'true'`/`'false'`, matching the API's
 * schema exactly. It is an explicit enum there rather than a coerced boolean
 * because `z.coerce.boolean()` follows JS truthiness and would turn the string
 * `'false'` into `true`, inverting the filter — so the spelling here is
 * load-bearing rather than stylistic.
 */
export async function getNotifications(params?: {
  page?: number;
  pageSize?: number;
  unreadOnly?: boolean;
}): Promise<NotificationListResponse> {
  const searchParams = new URLSearchParams();
  if (params?.page) searchParams.set('page', String(params.page));
  if (params?.pageSize) searchParams.set('pageSize', String(params.pageSize));
  // `!== undefined`, not truthiness: `false` is a meaningful value to send.
  if (params?.unreadOnly !== undefined) {
    searchParams.set('unreadOnly', params.unreadOnly ? 'true' : 'false');
  }

  return api.get<NotificationListResponse>(`/notifications?${searchParams}`);
}

/**
 * The badge number.
 *
 * A DEDICATED ENDPOINT, not something counted out of a page of
 * `getNotifications`: a count taken from a page silently caps at `pageSize`, so
 * a user with 30 unread would see "20" and never learn otherwise. Call it on
 * mount and again on every SSE (re)connect.
 */
export async function getUnreadNotificationCount(): Promise<UnreadCountResponse> {
  return api.get<UnreadCountResponse>('/notifications/unread-count');
}

/**
 * Mark one notification read.
 *
 * RETURNS THE NEW UNREAD COUNT, which is the whole reason this is worth a round
 * trip: the caller already holds the row it just marked, so the count is the
 * only thing it cannot compute for itself. DO NOT follow this with a call to
 * `getUnreadNotificationCount` — that is the two-round-trip shape the API was
 * built to avoid.
 *
 * Idempotent server-side; marking an already-read notification succeeds and
 * leaves the original `readAt` alone. A 404 means "no such notification FOR
 * THIS USER" — an id belonging to somebody else is indistinguishable from one
 * that does not exist, deliberately, so the endpoint cannot be used to probe
 * for valid ids.
 */
export async function markNotificationRead(id: string): Promise<UnreadCountResponse> {
  return api.post<UnreadCountResponse>(`/notifications/${id}/read`);
}

/**
 * Clear the badge in one call, returning the resulting count.
 *
 * The count is REPORTED, not assumed to be zero: a notification arriving
 * between the update and the count is reflected honestly rather than hidden
 * behind a hardcoded `0`. Callers must use the returned number and never
 * `setUnreadCount(0)`.
 */
export async function markAllNotificationsRead(): Promise<UnreadCountResponse> {
  return api.post<UnreadCountResponse>('/notifications/read-all');
}

/** Re-exported for consumers that only import from this module. */
export type { AppNotification };

// =============================================================================
// AI configuration (epic #25)
// =============================================================================

/**
 * The admin AI configuration — `GET /api/ai-settings` (#30).
 *
 * `system_settings:read`, the same string the registry card declares. The
 * response carries `apiKeyStatus` (masked, non-secret) and never the key: it
 * is unreadable through the API by design.
 */
export async function getAiSettings(): Promise<AiSettings> {
  return api.get<AiSettings>('/ai-settings');
}

/**
 * Replace the AI configuration — `PUT /api/ai-settings` (#30).
 *
 * PUT rather than PATCH, for the same reason email settings are: one small
 * document edited on one screen, where a per-field merge could leave a
 * half-saved state (a provider selected, its models not) that nothing in the
 * UI can show.
 *
 * `apiKey` is WRITE-ONLY and BLANK PRESERVES. The caller OMITS the field
 * entirely when the admin did not retype the key — the API treats omitted,
 * `null` and `''` identically, but omitting is what the request visibly says,
 * and a reviewer reading the network tab on an ordinary save sees no key field
 * at all.
 *
 * `If-Match` is sent unconditionally, with `0` meaning "I believe nothing is
 * stored yet", so even a first save is guarded rather than being the one
 * unprotected write.
 */
export async function updateAiSettings(
  input: AiSettingsInput,
  expectedVersion?: number,
): Promise<AiSettings> {
  return api.put<AiSettings>('/ai-settings', input, {
    headers:
      expectedVersion === undefined
        ? undefined
        : { 'If-Match': String(expectedVersion) },
  });
}

/**
 * The bindable model catalog and the role registry — `GET /api/ai-settings/models`
 * (#31).
 *
 * TWO THINGS IN ONE CALL, and the roles come back even when the catalog could
 * not be fetched: they are code, not provider data, so a missing key has no
 * bearing on them. Withholding them would leave the page unable to render the
 * controls that explain what is wrong.
 *
 * `showAll` is the escape hatch — no generation floor, every family, including
 * ids the API did not recognise. It exists because model naming is not ours to
 * control, and a filter that cannot be switched off eventually locks an admin
 * out of selecting a model that exists.
 */
export async function getAiModelCatalog(options?: {
  role?: string;
  showAll?: boolean;
}): Promise<AiModelCatalog> {
  const params = new URLSearchParams();
  if (options?.role) params.set('role', options.role);
  // Only ever the literal 'true'. The API engages the hatch on that string
  // alone, so `?showAll=false` correctly does nothing.
  if (options?.showAll) params.set('showAll', 'true');

  const query = params.toString();
  return api.get<AiModelCatalog>(`/ai-settings/models${query ? `?${query}` : ''}`);
}

/**
 * Test the saved server configuration — `POST /api/ai-settings/test` (#32).
 *
 * `system_settings:WRITE`, not read: it causes the system to originate an
 * outbound request on the organisation's credential.
 *
 * ANSWERS 200 EVEN WHEN THE TEST FAILED. Read `success`; a resolved promise
 * means the endpoint answered, never that the key works.
 */
export async function testAiConnection(): Promise<AiTestResult> {
  return api.post<AiTestResult>('/ai-settings/test');
}

/**
 * The caller's OWN stored key — `GET /api/ai/key` (#35).
 *
 * Authenticated, no permissions: every user owns their own credentials, and
 * gating this would leave a Viewer unable to use the app at all. There is no
 * parameter naming a user, here or on the server.
 */
export async function getAiKeyStatus(): Promise<AiKeyStatus> {
  return api.get<AiKeyStatus>('/ai/key');
}

/**
 * Save or replace the caller's own key — `PUT /api/ai/key` (#35).
 *
 * The value is sent VERBATIM, untrimmed. A key whose surrounding whitespace is
 * significant is a real key, and a user pasting from a developer console is
 * exactly who a silent trim bites — with an authentication failure that has no
 * visible cause.
 */
export async function setAiKey(apiKey: string): Promise<AiKeyStatus> {
  return api.put<AiKeyStatus>('/ai/key', { apiKey });
}

/**
 * Remove the caller's own key — `DELETE /api/ai/key` (#35).
 *
 * The only way to erase one, deliberately separate from the save so that
 * destroying a credential is always asked for by name. Idempotent.
 *
 * NOTE THE CONSEQUENCE: removing the key re-arms the first-run gate, so the
 * user is returned to `/setup/ai-key`. A page offering this must say so.
 */
export async function deleteAiKey(): Promise<AiKeyStatus> {
  return api.delete<AiKeyStatus>('/ai/key');
}

/**
 * Test the caller's own key — `POST /api/ai/key/test` (#35).
 *
 * REACHABILITY, NOT VALIDITY: it checks that each wired role's bound model is
 * actually reachable on this key, and reports PER ROLE. The admin binds model
 * ids using the server key, and a personal key may sit in a different
 * organisation with no access to them — a check that only asked "is this key
 * valid" would pass for a key that cannot run a single request the app makes.
 *
 * Answers 200 even on failure. Read `success`, and `authenticated` to tell a
 * bad key from a good key with no model access.
 */
export async function testAiKey(): Promise<AiTestResult> {
  return api.post<AiTestResult>('/ai/key/test');
}

/**
 * Whether AI is available to the caller — `GET /api/ai/status` (#36).
 *
 * TWO INDEPENDENT FACTS. `userKeyConfigured === false` hard-blocks;
 * `systemReady === false` does not block at all. Never derive a single "ready"
 * from them — that is exactly how a user blocked by missing ADMIN
 * configuration ends up being told to add a key they already have.
 *
 * Cheap by design (no provider round trip server-side), but still a request:
 * callers must not fire it per render.
 */
export async function getAiStatus(): Promise<AiStatus> {
  return api.get<AiStatus>('/ai/status');
}

/**
 * The caller's own recorded usage — `GET /api/ai/usage` (#37).
 *
 * RECORDED USAGE, NOT A BILL. Token counts are not dollars, and
 * `callsWithUnknownUsage` counts calls whose consumption was never reported.
 * The authoritative figure is the user's own OpenAI dashboard.
 */
export async function getAiUsage(days?: number): Promise<AiUsage> {
  const query = days === undefined ? '' : `?days=${days}`;
  return api.get<AiUsage>(`/ai/usage${query}`);
}

// =============================================================================
// Speech — the caller's own voice, on the caller's own key (epic #58 / E9)
// =============================================================================
//
// Both routes are `@Auth()` with no permissions and no user-id parameter
// (`docs/specs/voice.md` §10): every learner practises with their own voice on
// their own key, and there is no "use voice" privilege in this product's
// authorization model.
//
// NEITHER FUNCTION PERSISTS ANYTHING. Audio travels up, text comes back, and
// the `Blob` is the caller's to drop the moment the promise settles —
// `docs/specs/voice.md` §4: "Transcribe, keep the text, discard the buffer."

/**
 * Turn one recording into text — `POST /api/ai/speech/transcribe` (#99).
 *
 * MULTIPART, WHICH IS WHY THIS DOES NOT LOOK LIKE ITS NEIGHBOURS. The body is a
 * `FormData` carrying one audio part; `ApiService.request` deliberately leaves
 * `Content-Type` unset for it so the browser can name its own boundary. See the
 * long note at the top of this file — sending JSON's content type over a
 * multipart body is unparseable at the other end.
 *
 * THREE SHAPES, ALL OF THEM HTTP 200, AND THE CALLER MUST SWITCH ON `status`
 * (issue #277). `ok` carries the transcript; `unavailable` means no call was
 * attempted (an unbound `transcribe`, the master switch off, no key of the
 * caller's own) and is NOT an error; `failed` means the call happened and
 * produced nothing usable. `docs/specs/voice.md` §9 spends the 200 on all three
 * deliberately, so this function does not throw for any of them and a
 * destructure straight off the promise — `const { text } = await …` — is
 * exactly the bug this signature now makes uncompilable.
 *
 * THE RESPONSE CARRIES NO AUDIO, in either direction of interpretation: nothing
 * comes back but the fields of one of those three members, and nothing is
 * stored anywhere by making this call. On the `ok` member `confidence` is
 * `number | null` and **null means unknown, never zero** — see
 * `SpeechTranscriptionOk`, where getting that backwards is spelled out as the
 * thing that marks a good answer `misheard`.
 *
 * NOT A GRADE AND NOT AN ANSWER. What comes back on `ok` is what the recognizer
 * heard, and `docs/specs/voice.md` §3 requires the learner to confirm it before
 * anything is graded on it.
 *
 * A genuine transport failure — 401, a malformed request, a dropped
 * connection — still REJECTS with `ApiError`, unchanged. The union is about the
 * 200-with-a-cause path only, and a caller needs both: one is a thing to retry,
 * the other is a thing to explain.
 *
 * @param blob  the recording, held in memory only for this call's duration.
 * @param opts.fileName  what to call the part. Providers key their decoder off
 *   the extension, so it must match the blob's own type rather than be a fixed
 *   `audio.webm` that lies about an mp4.
 * @param opts.signal  aborts the upload. A learner who navigates away mid-send
 *   should not be billed for the transcription of an answer nobody will read.
 */
export async function transcribeAudio(
  blob: Blob,
  opts: { fileName?: string; signal?: AbortSignal } = {},
): Promise<TranscribeResponse> {
  const form = new FormData();
  // One file part, named `audio`. NOT an arbitrary name: the endpoint iterates
  // the parts and REJECTS any file field it was not expecting (see
  // `AUDIO_FIELD` in `apps/api/src/ai/ai-speech.controller.ts`), rather than
  // taking whatever arrives first. That is the safer server, and it makes this
  // string load-bearing — a rename here is a 400 for every learner.
  form.append('audio', blob, opts.fileName ?? defaultAudioFileName(blob));

  return api.post<TranscribeResponse>('/ai/speech/transcribe', form, {
    signal: opts.signal,
  });
}

/**
 * Speak one piece of text — `POST /api/ai/speech/synthesize` (#99).
 *
 * THE PREMIUM UPGRADE, NEVER THE DEFAULT. `docs/specs/voice.md` §2 (decision 1)
 * makes the browser's own `speechSynthesis` the default text-to-speech: it
 * needs no binding, no key and no per-call cost, so "hear this question aloud"
 * works on a fresh install where nobody has configured anything. This route is
 * the optional, provider-hosted, better-sounding upgrade on top — reached only
 * when an admin has bound the `speak` role AND the learner asked for it.
 *
 * ANSWERS BYTES *OR* JSON, BOTH UNDER HTTP 200, AND `Content-Type` IS THE ONLY
 * THING THAT TELLS THEM APART. That is not a quirk of this client: it is the
 * contract on `AiSpeechController.synthesize`, which spends the 200 on an
 * `unavailable`/`failed` outcome for the same reason `transcribe` does (§9) —
 * a `speak`-unbound deployment is a correctly configured deployment, not a
 * fault to be signalled with a status code.
 *
 * So the request still asks for a `Blob` (the success path is audio and must
 * not be routed through `JSON.parse`), and this function then INSPECTS THE BLOB
 * IT GOT: a JSON media type means the body is the same
 * `{ data: { status, … } }` envelope every other endpoint answers with, read
 * back out of the blob and returned as the `unavailable`/`failed` member.
 * Issue #277: before this, a JSON envelope was handed straight to an
 * `<audio>` element, which "worked" only because the resulting play error
 * landed in a `catch` that fell back to the browser voice — the right outcome
 * reached for the wrong reason, and one refactor away from silence.
 *
 * NOTHING IN HERE THROWS FOR AN AI REASON. A body that is not valid JSON, or
 * parses to something with no recognisable `status`, resolves to a `failed`
 * member rather than rejecting: every caller of this function treats any
 * non-`ok` result as "use the browser voice", so this function becoming the
 * thing that breaks playback would be strictly worse than any answer it could
 * give. A genuine non-2xx (401, a network failure) still rejects with
 * `ApiError`, unchanged.
 */
export async function synthesizeSpeech(
  text: string,
  opts: {
    signal?: AbortSignal;
    /**
     * The PROVIDER's own voice id, e.g. `alloy` — from
     * {@link listSpeechVoices}, or from the learner's stored
     * `user_settings.voice.preferredVoice`.
     *
     * OMITTED, NEVER SENT EMPTY. `aiSynthesizeRequestSchema` is `.strict()`
     * with `voice` optional, so an absent key means "let the provider choose"
     * while `voice: ''` is a 400 — which is why the key is built conditionally
     * below rather than always spread. A learner who has expressed no
     * preference is the normal case, and it must not be a bad request.
     */
    voice?: string;
  } = {},
): Promise<SynthesizeResponse> {
  const blob = await api.post<Blob>(
    '/ai/speech/synthesize',
    { text, ...(opts.voice ? { voice: opts.voice } : {}) },
    { responseType: 'blob', signal: opts.signal },
  );

  // `application/json`, `application/json; charset=utf-8`, and whatever else a
  // proxy decides to append. Matched on the prefix rather than on equality for
  // that reason; anything else is audio and is the caller's to play.
  if (!blob.type.toLowerCase().startsWith('application/json')) {
    return { status: 'ok', audio: blob };
  }

  return parseSynthesisEnvelope(blob);
}

/**
 * Read a non-`ok` synthesis result back out of the JSON blob it arrived in.
 *
 * Separate from its caller so the defensive branches are readable rather than
 * nested three deep inside a function whose happy path is one line. Every exit
 * is a `SynthesizeResponse`; there is no `throw` anywhere in it, deliberately —
 * see the caller's doc comment.
 */
async function parseSynthesisEnvelope(blob: Blob): Promise<SynthesizeResponse> {
  /** What a body we could not make sense of resolves to. */
  const unreadable: SynthesizeResponse = {
    status: 'failed',
    // Not a code the API ever sends. It says where the confusion happened,
    // which is the only useful thing to log about a body like this — and it is
    // never shown to a learner, exactly as the API's own `error` is not.
    errorCode: 'malformed_response',
    error: 'The speech response could not be read.',
  };

  try {
    const payload: unknown = JSON.parse(await blob.text());
    // The standard envelope: the interesting object is under `data`. Some
    // shapes arrive unwrapped, so try the payload itself as well rather than
    // insisting on a wrapper that is not load-bearing here.
    const candidate =
      payload && typeof payload === 'object' && 'data' in payload
        ? (payload as { data: unknown }).data
        : payload;

    if (!candidate || typeof candidate !== 'object') return unreadable;

    const status = (candidate as { status?: unknown }).status;
    // Only the two non-`ok` members can arrive as JSON — an `ok` synthesis is
    // audio, by definition. A JSON body claiming `ok` is therefore as
    // unreadable as one claiming nothing.
    if (status === 'unavailable' || status === 'failed') {
      return candidate as SynthesizeResponse;
    }

    return unreadable;
  } catch {
    return unreadable;
  }
}

/**
 * The voices this deployment can speak in — `GET /api/ai/speech/voices` (#283).
 *
 * WHY THIS IS FETCHED RATHER THAN IMPORTED FROM A CONSTANT. The accepted voice
 * ids belong to the AI provider, so a copy in `src/config` would be correct the
 * day it was written and silently wrong the day the provider added or renamed a
 * voice — and a test asserting the copy matches the server is DETECTION rather
 * than prevention, since the two can still disagree in a working tree, in a
 * branch, and in any build where the test is not run. That is the same argument
 * `ai-model-roles.ts` makes for serving the model-role registry over an
 * endpoint.
 *
 * NOT A UNION, AND NOT AN AI CALL. Unlike {@link transcribeAudio} and
 * {@link synthesizeSpeech} there is no `status` to switch on: this reads static
 * provider data, spends no key, and has no `unavailable` state to report.
 *
 * AN EMPTY `voices`, OR `speakBound: false`, IS NOT AN ERROR — see
 * `SpeechVoicesResponse`. Offer the browser's own voices and say nothing about
 * what is missing; a learner hears the question either way. A genuine transport
 * failure (401, a dropped connection) still rejects with `ApiError`.
 */
export async function listSpeechVoices(
  opts: { signal?: AbortSignal } = {},
): Promise<SpeechVoicesResponse> {
  return api.get<SpeechVoicesResponse>('/ai/speech/voices', {
    signal: opts.signal,
  });
}

/**
 * A file name whose extension matches the blob's own MIME type.
 *
 * Speech-to-text providers dispatch on the extension, so a fixed `audio.webm`
 * over a Safari-recorded mp4 is rejected as a corrupt webm — a failure that
 * reads as "your recording was bad" on the one browser where nothing was wrong
 * with it.
 *
 * Exported so this mapping can be asserted directly: the multipart part name it
 * produces does not survive the test stack's realm crossing, so a round-trip
 * assertion over it would be testing the harness rather than this decision.
 */
export function defaultAudioFileName(blob: Blob): string {
  const subtype = blob.type.split(';')[0]?.split('/')[1] ?? '';
  const extension =
    subtype === 'mpeg' ? 'mp3' : /^[a-z0-9]+$/i.test(subtype) ? subtype : 'webm';
  return `answer.${extension}`;
}

// =============================================================================
// Journey — the learner profile (epic #50)
// =============================================================================

/**
 * The caller's own profile plus the two reference lists — `GET /api/journey/profile`.
 *
 * `@Auth()` with no permissions: every learner owns their own profile, and the
 * server resolves them from the JWT — there is no parameter here or on the
 * server that could name anybody else.
 *
 * THREE THINGS IN ONE RESPONSE ON PURPOSE. The orientation form renders one
 * control set out of all three, and fetching them separately would mean three
 * round trips whose answers can disagree plus three loading states for one
 * form.
 *
 * CHEAP, BUT STILL A REQUEST. `LearnerProfileContext` calls this ONCE on
 * mount; a caller firing it per navigation would put a request storm behind a
 * first-run screen a new learner cannot get past.
 *
 * NOTE THAT THIS GET WRITES ON ITS FIRST CALL for a given user — the server
 * upserts the profile row lazily, so a first login gets defaults rather than a
 * 404 on the very first screen it sees.
 */
export async function getJourneyProfile(): Promise<JourneyProfileResponse> {
  return api.get<JourneyProfileResponse>('/journey/profile');
}

/**
 * Save orientation or a later profile edit — `PUT /api/journey/profile`.
 *
 * A MERGE UNDER A `PUT`: an absent key leaves its field untouched, and only an
 * explicit `interviewDate: null` clears a booked date.
 *
 * SEND `filingDate`, NOT `testVersionCode`. The server resolves which civics
 * test a filing date selects (the cutoff exists in exactly one place, on the
 * server), and a request carrying both fields is rejected with a 400.
 *
 * Answers with the SAME payload `getJourneyProfile` returns, so a caller can
 * push the result straight into `LearnerProfileContext` instead of spending a
 * second round trip re-reading what it was just told.
 */
export async function updateJourneyProfile(
  input: UpdateJourneyProfileInput,
): Promise<JourneyProfileResponse> {
  return api.put<JourneyProfileResponse>('/journey/profile', input);
}

/**
 * The home screen's own payload — `GET /api/journey/home` (#65, #74).
 *
 * SEPARATE FROM `getJourneyProfile`, and not merged into it. The two answer
 * different questions: the profile is the learner's stored answers (what the
 * orientation form edits), while this is the server's *reading* of them — the
 * recommendation, the countdown and the goal placeholder — recomputed against
 * the server's clock on every load. `journey-shell.md` §6.1 keeps them apart
 * for the reason `docs/specs/ai-settings.md` §5 keeps `userKeyConfigured` and
 * `systemReady` apart: different audiences, different cache lifetimes.
 *
 * `daysUntilInterview` ARRIVES COMPUTED. Nothing downstream may re-derive it
 * from `interviewDate` — see the field's own note in `types/index.ts`.
 */
export async function getJourneyHome(): Promise<JourneyHome> {
  return api.get<JourneyHome>('/journey/home');
}

/**
 * The stage registry — `GET /api/journey/stages` (#65, #74).
 *
 * THE EIGHT STAGES ARE NEVER DECLARED IN THE WEB APP. This function is the
 * only way the browser learns what stages exist, what they are called and what
 * order they come in; there is deliberately no array in `config/` to fall back
 * on, because a fallback IS the duplicate registry `journey-shell.md` §6
 * rejects — copies can disagree in a working tree, in a branch, and in any
 * build where the agreement test does not run.
 *
 * `@Auth()` with no permission: every learner needs it to render their own
 * stage.
 */
export async function getJourneyStages(): Promise<JourneyStage[]> {
  return api.get<JourneyStage[]>('/journey/stages');
}

// =============================================================================
// Civics — the admin dynamic-answer surface (#126, epic #51)
// =============================================================================
//
// `system_settings:read` on the GET and `system_settings:write` on the PUT —
// the strings `civics-admin.controller.ts` enforces, reused rather than
// invented (`civics-content.md` §9). The learner-facing `/api/civics/*` routes
// are a different controller with the opposite posture (`@Auth()`, no
// permission) and are not called from here.
// =============================================================================

/**
 * A page of `national`- and `state`-scope questions with their OPEN answers.
 *
 * `none`-scope questions are not listed and are not addressable through this
 * surface at all.
 *
 * THE QUERY IS A STRICT OBJECT SERVER-SIDE: a misremembered parameter is a 400
 * rather than a filter that silently did nothing, so every key set here has to
 * be one `civicsDynamicAnswerQuerySchema` declares.
 */
export async function getCivicsDynamicAnswers(params?: {
  page?: number;
  pageSize?: number;
  testVersionCode?: string;
  dynamicScope?: CivicsAdminScope;
  stateCode?: string;
}): Promise<CivicsDynamicAnswerPage> {
  const searchParams = new URLSearchParams();
  if (params?.page) searchParams.set('page', String(params.page));
  if (params?.pageSize) searchParams.set('pageSize', String(params.pageSize));
  if (params?.testVersionCode) searchParams.set('testVersionCode', params.testVersionCode);
  if (params?.dynamicScope) searchParams.set('dynamicScope', params.dynamicScope);
  if (params?.stateCode) searchParams.set('stateCode', params.stateCode);

  return api.get<CivicsDynamicAnswerPage>(`/civics/dynamic-answers?${searchParams}`);
}

/**
 * Correct one dynamic answer — `PUT /api/civics/dynamic-answers`.
 *
 * `PUT`, and NOT an update. The request declares what the answer for a slot IS;
 * underneath, the open row is closed and a new one is opened in one
 * transaction. There is no route that takes an answer id, because a row a
 * learner may already have been graded against is not editable by anybody
 * through any surface.
 *
 * The response carries BOTH rows, and a caller must render it that way: showing
 * only `current` would read exactly like the in-place edit the lifecycle
 * refuses to perform.
 */
export async function correctCivicsDynamicAnswer(
  input: CivicsAnswerCorrection,
): Promise<CivicsAnswerCorrectionResult> {
  return api.put<CivicsAnswerCorrectionResult>('/civics/dynamic-answers', input);
}

// Civics content — the read surface (epic #51, API #111)
// =============================================================================
//
// Three calls, one controller, and the ONLY place in the web app that names
// these endpoints. Every route is `@Auth()` with NO permission: civics content
// is the core product material every authenticated learner reads, and gating it
// would leave a Viewer — the default role every new account gets — unable to
// study, which is the entire product.
//
// -----------------------------------------------------------------------------
// THE LEARNER'S TEST VERSION IS NEVER SENT, AND THAT IS DELIBERATE
// -----------------------------------------------------------------------------
//
// `GET /api/civics/questions` takes an OPTIONAL `testVersionCode`, and omitting
// it does not mean "every version": the API falls back to the caller's own
// `learner_profiles.test_version_code`. So the browser sends nothing, and the
// answer is correct for this learner by construction — there is no version
// picker on `/learn`, because there is no question a learner could answer by
// choosing one. A client that helpfully passed the code it read out of the
// profile context would be a second copy of a decision the server already owns,
// wrong the moment a learner's filing date moves them between banks.
//
// The categories route is the exception, and only because the version is in its
// PATH; `/learn` reads that code from `LearnerProfileContext`, which has already
// loaded the profile once for the whole session.
//
// -----------------------------------------------------------------------------
// THERE IS NO `stateCode` PARAMETER, HERE OR ON THE SERVER
// -----------------------------------------------------------------------------
//
// Answer resolution reads the caller's state from their own profile row. The
// query DTO is a `z.strictObject`, so adding `?stateCode=TX` here would be a
// 400 rather than a silently-honoured parameter — a client written against a
// misremembered contract fails loudly instead of quietly memorising Texas's
// governor.
// =============================================================================

/**
 * One version's categories, in the order the official material uses.
 *
 * An unknown version code is a 404, not an empty list — "this version does not
 * exist" and "this version has no content loaded yet" are different facts.
 */
export async function getCivicsCategories(
  testVersionCode: string,
): Promise<CivicsCategory[]> {
  return api.get<CivicsCategory[]>(
    `/civics/versions/${encodeURIComponent(testVersionCode)}/categories`,
  );
}

/**
 * A page of question summaries — `number`, `prompt`, `categoryId`,
 * `seniorEligible`, `dynamicScope`. **No answers**: those are resolved per
 * caller and belong on the detail route.
 *
 * `seniorEligible` is an EXPLICIT filter with no implicit default from the
 * caller's own `seniorExemption`. A learner claiming the 65/20 accommodation is
 * still entitled to browse the full bank, and a list that silently shrank to 20
 * questions with nothing saying why would be the same unexplained gap the spec
 * rejects for `state`-scope questions.
 */
export async function getCivicsQuestions(params?: {
  page?: number;
  pageSize?: number;
  categoryId?: string;
  seniorEligible?: boolean;
}): Promise<CivicsQuestionListResponse> {
  const searchParams = new URLSearchParams();
  if (params?.page) searchParams.set('page', String(params.page));
  if (params?.pageSize) searchParams.set('pageSize', String(params.pageSize));
  if (params?.categoryId) searchParams.set('categoryId', params.categoryId);
  // `!== undefined`, not truthiness: `false` is a meaningful value to send.
  if (params?.seniorEligible !== undefined) {
    searchParams.set('seniorEligible', params.seniorEligible ? 'true' : 'false');
  }

  const query = searchParams.toString();
  return api.get<CivicsQuestionListResponse>(
    `/civics/questions${query ? `?${query}` : ''}`,
  );
}

/**
 * One question, with its answers already resolved for THIS caller.
 *
 * CALLERS MUST BRANCH ON `answerResolution`. A `state`-scope question asked by
 * a learner with no state set resolves 200 with `answers: []`,
 * `verifiedAt: null` and `answerResolution: 'state_required'` — never a 404,
 * never another state's answer, never a guess.
 */
export async function getCivicsQuestion(
  id: string,
): Promise<CivicsQuestionDetail> {
  return api.get<CivicsQuestionDetail>(`/civics/questions/${id}`);
}

// =============================================================================
// Practice — sessions, attempts and the self-mark (epic #52, API #73)
// =============================================================================
//
// Six calls, one controller, and the ONLY place in the web app that names these
// endpoints. Every route is `@Auth()` with NO permission and resolves the
// learner from the token: a learner's own practice history is exactly as
// private, and exactly as unconditionally theirs to act on, as their own
// journey profile or their own AI key (`practice-sessions.md` §10).
//
// -----------------------------------------------------------------------------
// NO ROUTE HERE TAKES A USER ID, A TEST VERSION OR A STATE CODE
// -----------------------------------------------------------------------------
//
// Every one of those is resolved server-side from the caller's own
// `learner_profiles` row — which questions are in the pool, which answers are
// current for them, whether the 65/20 accommodation applies. The same reasoning
// the civics block above gives at length: a browser that "helpfully" sent the
// values it happens to hold would be a second copy of a decision the server
// owns, wrong the moment a filing date moves a learner between banks.
//
// -----------------------------------------------------------------------------
// THE CLIENT REPORTS WHAT HAPPENED. IT NEVER REPORTS THE VERDICT.
// -----------------------------------------------------------------------------
//
// `RecordPracticeAttemptInput` has no `outcome`, no `correct` and no
// `gradingMethod`, and the API's own DTO carries a compile-time proof that it
// never will. Grading is `matchAnswer` run on the server against the answers
// resolved at that instant. The one route by which a learner's own judgement
// enters the evidence table is `selfMarkPracticeAttempt` below, which is a
// separate call precisely so it can be recorded as `gradingMethod: 'self'` and
// weighed differently by E5 — an asserted pass must never be indistinguishable
// from a verified one.
// =============================================================================

/**
 * Start a session — `POST /api/practice/sessions`.
 *
 * Returns the session together with its FIRST QUESTION, PROMPT ONLY. There is
 * no second call to fetch the question, and there must not be one: the whole
 * point of `PracticeQuestion` is that the answers are not in the payload that
 * carries the prompt.
 *
 * Any session still `in_progress` for this learner is closed (`abandoned`)
 * first, keeping every attempt it already produced. That is why "start Quick 5"
 * is safe to offer as a single click from three different places — there is no
 * "you already have a session open" state for a caller to reconcile.
 *
 * A 409 means there is nothing available to practise for this selection; a 400
 * means the caller has no resolved test version, i.e. unfinished setup rather
 * than a failure. Callers render both as prose, never as a stack trace.
 */
export async function createPracticeSession(
  input: CreatePracticeSessionInput,
): Promise<PracticeSessionState> {
  return api.post<PracticeSessionState>('/practice/sessions', input);
}

/**
 * The caller's own sessions, newest first — `GET /api/practice/sessions`.
 *
 * There are deliberately no filters server-side: "recent sessions" is the one
 * question this endpoint answers, and an unknown query parameter is a 400
 * rather than a filter that silently did nothing.
 */
export async function getPracticeSessions(params?: {
  page?: number;
  pageSize?: number;
}): Promise<PracticeSessionPage> {
  const searchParams = new URLSearchParams();
  if (params?.page) searchParams.set('page', String(params.page));
  if (params?.pageSize) searchParams.set('pageSize', String(params.pageSize));

  const query = searchParams.toString();
  return api.get<PracticeSessionPage>(
    `/practice/sessions${query ? `?${query}` : ''}`,
  );
}

/**
 * One session, its attempts, and what comes next —
 * `GET /api/practice/sessions/:id`.
 *
 * THIS IS THE ONLY SOURCE OF TRUTH FOR BOTH THE SESSION SCREEN AND THE SUMMARY
 * SCREEN. Neither reads anything out of navigation state, so a reload mid-
 * session resumes from the server with no attempt lost, and a summary revisited
 * from Recent sessions a month later renders identically to the one shown the
 * moment it was finished.
 *
 * Somebody else's session is a 404, not a 403 — confirming that an id names a
 * real session would itself be the leak.
 */
export async function getPracticeSession(
  id: string,
): Promise<PracticeSessionDetail> {
  return api.get<PracticeSessionDetail>(`/practice/sessions/${id}`);
}

/**
 * Answer one question and be graded —
 * `POST /api/practice/sessions/:id/attempts`.
 *
 * Writes exactly one `practice_attempts` row and returns it with
 * `acceptedAnswers`, the next prompt-only question, and progress counted from
 * the persisted rows. One attempt per question per session: a repeat is a 409,
 * because answering a question again is a NEW session.
 */
export async function recordPracticeAttempt(
  sessionId: string,
  input: RecordPracticeAttemptInput,
): Promise<PracticeAttemptResult> {
  return api.post<PracticeAttemptResult>(
    `/practice/sessions/${sessionId}/attempts`,
    input,
  );
}

/**
 * "I was right — the matcher just didn't recognise it" —
 * `POST /api/practice/sessions/:id/attempts/:attemptId/self-mark`.
 *
 * Flips a recorded `incorrect` or `skipped` attempt to `correct` with
 * `gradingMethod: 'self'`.
 *
 * TWO REFUSALS A CALLER MUST RESPECT RATHER THAN RETRY:
 *
 *   * **409 when the attempt was not `revealed`.** The claim being made is "my
 *     answer matched the accepted one", and that is only checkable against the
 *     accepted one — not against the learner's memory of what they think it
 *     was. `PracticeSessionPage` therefore offers the control exactly where the
 *     endpoint accepts it; see that file's header for the whole reasoning.
 *   * **400 when the matcher already graded it `correct`.** There is nothing to
 *     grant, and overwriting `exact` with `self` would DOWNGRADE the record
 *     from a verified match to a learner's own claim.
 *
 * Idempotent otherwise: a second call returns the same state.
 */
export async function selfMarkPracticeAttempt(
  sessionId: string,
  attemptId: string,
): Promise<PracticeAttempt> {
  return api.post<PracticeAttempt>(
    `/practice/sessions/${sessionId}/attempts/${attemptId}/self-mark`,
    {},
  );
}

/**
 * Finish a session — `POST /api/practice/sessions/:id/complete`.
 *
 * Every number in the returned `summary` is computed from the attempt rows that
 * were actually written; nothing the client sent contributes to it. Idempotent
 * — completing an already-completed session returns the stored summary and does
 * NOT move `completedAt`, so the moment a learner finished stays the moment
 * they finished. An abandoned session is a 409: it was closed by a later
 * session start and has no completion to record.
 */
export async function completePracticeSession(
  id: string,
): Promise<PracticeSession> {
  return api.post<PracticeSession>(`/practice/sessions/${id}/complete`, {});
}

/**
 * The caller's queue counts — `GET /api/practice/queue` (#78, epic #54).
 *
 * Read-only: it reports what a session started right now would draw from
 * (`mastery/selector.ts`'s bucket order), it never creates one. A 400 means
 * the caller has no resolved test version — unfinished setup, exactly like
 * `createPracticeSession`'s own 400, and rendered the same way: as prose, not
 * a stack trace.
 */
export async function getPracticeQueue(): Promise<PracticeQueue> {
  return api.get<PracticeQueue>('/practice/queue');
}

// =============================================================================
// Progress — `GET /api/progress/mastery` (issue #94, epic #54 / E5 "Memory")
// =============================================================================

/**
 * The caller's own coverage and mastery, by category — `GET /api/progress/mastery`.
 *
 * `@Auth()` with no permissions, no parameters: exactly the same posture
 * `getJourneyProfile`/`getPracticeSessions` already take, for the same reason
 * — every learner owns their own mastery data, resolved from the JWT. A 400
 * means the caller has no resolved test version yet (unfinished setup), the
 * same shape `createPracticeSession` already documents.
 */
export async function getProgressMastery(): Promise<ProgressMastery> {
  return api.get<ProgressMastery>('/progress/mastery');
}

// =============================================================================
// Readiness — `GET /api/readiness`, `GET /api/readiness/history`
// (issues #139/#142, epic #55 / E6 "Readiness and Progress")
// =============================================================================

/**
 * The caller's latest readiness snapshot — `GET /api/readiness`.
 *
 * `@Auth()` with no permissions, no parameters: the same posture
 * `getProgressMastery`/`getJourneyHome` already take, for the same reason —
 * every learner owns their own readiness data, resolved from the JWT. Lazily
 * computed and persisted server-side if none exists yet or the latest is
 * stale (`docs/specs/readiness-model.md` §6) — this call never triggers that
 * computation itself, it only reads the result.
 */
export async function getReadiness(): Promise<ReadinessSnapshotResponse> {
  return api.get<ReadinessSnapshotResponse>('/readiness');
}

/**
 * The caller's own snapshot history, newest first — `GET /api/readiness/history`.
 *
 * `page`/`pageSize` passed exactly as `getPracticeSessions` passes its own —
 * the one query-parameter shape this API already standardized on for a
 * newest-first list. An unknown parameter is a 400 server-side, so nothing
 * beyond these two is ever sent.
 */
export async function getReadinessHistory(params?: {
  page?: number;
  pageSize?: number;
}): Promise<ReadinessHistoryResponse> {
  const searchParams = new URLSearchParams();
  if (params?.page) searchParams.set('page', String(params.page));
  if (params?.pageSize) searchParams.set('pageSize', String(params.pageSize));

  const query = searchParams.toString();
  return api.get<ReadinessHistoryResponse>(
    `/readiness/history${query ? `?${query}` : ''}`,
  );
}

// =============================================================================
// Engagement — `GET /api/engagement/summary`
// (issue #138, epic #56 / E7 "Habit")
// =============================================================================

/**
 * The caller's daily goal, streak and freeze budget — `GET /api/engagement/summary`.
 *
 * `@Auth()` with no permissions, no parameters: the same posture
 * `getReadiness`/`getProgressMastery`/`getJourneyHome` already take, for the
 * same reason — every learner owns their own engagement data, resolved from
 * the JWT, and no route parameter or query field names a user.
 *
 * The server settles the freeze budget on this read
 * (`docs/specs/habit-streaks.md` §4.6) exactly as `GET /api/readiness` lazily
 * computes a snapshot; this call never performs that work itself, it only
 * reads the result.
 */
export async function getEngagementSummary(): Promise<EngagementSummary> {
  return api.get<EngagementSummary>('/engagement/summary');
}

// =============================================================================
// Mock interview — start it, read it, finish it
// (issue #140, epic #57 / E8 "Mock interview")
// =============================================================================
//
// Four calls, one per JSON route the interviews controller serves. The fifth
// thing this feature does — taking a turn — is not here, because it is not
// JSON: `POST /api/interviews/:id/turns` answers with `text/event-stream` and
// lives in `services/interviewStream.ts`, beside the frame decoder, exactly as
// the explain stream does.
//
// `getInterviews` is issue #145's addition. This block used to say the history
// list was "deliberately not bound yet"; it is bound now, because the debrief
// screen it feeds exists. §12 states why the endpoint is there at all rather
// than leaving it to be inferred: a debrief that existed only as a one-time
// response to the `complete` call that produced it could not answer "did I do
// better on my second mock interview than my first", which is a real question
// this product should be able to answer.
//
// Every route is `@Auth()` with NO permission and resolves the learner from the
// token, the same posture the practice, readiness and engagement blocks above
// take, for the same reason: a learner's own interview history is exactly as
// unconditionally theirs as their own practice attempts. Somebody else's
// interview is a 404, not a 403 — confirming that an id names a real interview
// would itself be the leak.
//
// -----------------------------------------------------------------------------
// NO CALL HERE SENDS A TEST VERSION, A SENIOR FLAG OR A STATE CODE
// -----------------------------------------------------------------------------
//
// All three are resolved server-side from the caller's own `learner_profiles`
// row and frozen onto the interview at creation. `CreateInterviewInput` has one
// field, and the API's DTO carries a compile-time proof that no bank-shaped or
// identity-shaped field can be added to it. A browser that "helpfully" sent the
// values it happens to hold would be claiming an accommodation the profile does
// not grant — `mock-interview.md` calls that the most expensive lie this
// product could tell, because the learner would be told they passed a test they
// were never given.
// =============================================================================

/**
 * Start an interview — `POST /api/interviews`.
 *
 * Returns the interview together with the officer's OPENING TURN, so the
 * screen that follows has something to render before it asks for anything.
 * There is no second call to fetch the greeting.
 *
 * `transcriptRetained` is the learner's own per-interview choice, made before
 * the interview starts and never offered again mid-interview — there is
 * nothing to retain yet at the moment it is asked, which is the point
 * (`mock-interview.md` §8.1, and §15's rejected "retention as a user setting").
 *
 * A 400 means the caller has no resolved test version — unfinished setup rather
 * than a failure, and rendered as prose exactly like `createPracticeSession`'s
 * own 400.
 */
export async function createInterview(
  input: CreateInterviewInput = {},
): Promise<InterviewState> {
  return api.post<InterviewState>('/interviews', input);
}

/**
 * Resume an interview, or re-read a finished one — `GET /api/interviews/:id`.
 *
 * THE ONLY SOURCE OF TRUTH FOR THE INTERVIEW SCREEN, for the same reason
 * `getPracticeSession` is for the practice screen: a reload, a second tab or a
 * dropped connection resumes at the same place with every recorded turn intact,
 * because resuming IS this request. Nothing is carried through navigation
 * state and no turn is buffered in the browser.
 *
 * `debrief` is null until the interview is `completed`, and no shape on this
 * response carries a per-question outcome before then.
 */
export async function getInterview(id: string): Promise<InterviewDetail> {
  return api.get<InterviewDetail>(`/interviews/${id}`);
}

/**
 * Finish the interview and get the debrief —
 * `POST /api/interviews/:id/complete`.
 *
 * The first moment any performance information exists where the learner can
 * see it. Also triggers a readiness recompute server-side, which is why the
 * response carries the new score and its delta rather than the client asking
 * for them separately.
 *
 * IDEMPOTENT: completing an already-completed interview returns the identical
 * stored debrief and recomputes nothing, so a double-tap cannot write a second
 * readiness snapshot for one interview. That is what makes it safe to call from
 * an end control that is reachable in every phase, including mid-stream.
 *
 * A 409 means the interview was abandoned and has no completion to record.
 */
export async function completeInterview(id: string): Promise<InterviewDebrief> {
  return api.post<InterviewDebrief>(`/interviews/${id}/complete`, {});
}

/**
 * The caller's own interviews, newest first — `GET /api/interviews` (#145).
 *
 * The same `page`/`pageSize` shape `getPracticeSessions` above sends, against
 * the same convention on the server. There are deliberately NO FILTERS to pass:
 * the query DTO is a `z.strictObject`, so an unknown parameter — `?userId=`
 * included — is a 400 naming it rather than a filter that silently did nothing.
 *
 * Each row is a header: `status`, `startedAt`, `completedAt`, `civicsAsked`,
 * `civicsCorrect` and `passedCivics`. Per-question detail lives behind
 * `getInterview`, which is what the debrief screen reads.
 */
export async function getInterviews(params?: {
  page?: number;
  pageSize?: number;
}): Promise<InterviewPage> {
  const searchParams = new URLSearchParams();
  if (params?.page) searchParams.set('page', String(params.page));
  if (params?.pageSize) searchParams.set('pageSize', String(params.pageSize));

  const query = searchParams.toString();
  return api.get<InterviewPage>(`/interviews${query ? `?${query}` : ''}`);
}

/**
 * Preview what a data reset would touch — `GET /api/account/data-summary`
 * (#270).
 *
 * Read-only: the server runs `count`, never `delete`. This is what the
 * "Danger zone" screen renders before the caller commits to anything, and
 * where the two confirmation phrases come from — the web never hardcodes
 * either, it reads `phrases` off this response.
 */
export async function getAccountDataSummary(): Promise<AccountDataSummary> {
  return api.get<AccountDataSummary>('/account/data-summary');
}

/**
 * Erase the caller's own data — `POST /api/account/reset` (#270).
 * IRREVERSIBLE.
 *
 * `scope` picks how much: `data` keeps the stored AI key, `data_and_key`
 * erases that too. `confirmationPhrase` must match the scope's exact phrase
 * from `getAccountDataSummary`, re-verified server-side before anything is
 * deleted — a disabled button on the client is a convenience, not the
 * control. A mismatch is a 400 and nothing is deleted.
 */
export async function resetAccountData(
  scope: AccountResetScope,
  confirmationPhrase: string,
): Promise<AccountResetResult> {
  return api.post<AccountResetResult>('/account/reset', {
    scope,
    confirmationPhrase,
  });
}

// =============================================================================
// The realtime voice interview — mint and relay (issue #159, epic #60 / E11)
// =============================================================================
//
// Two calls, and between them the browser's ENTIRE authority over a spoken
// interview. Everything else on this transport — which question is next, what
// the officer says, whether an answer was right, whether a phase is over — is
// decided server-side and reaches the browser only as a string to hand onward.
//
// -----------------------------------------------------------------------------
// THE LEARNER'S API KEY IS NOT IN THIS FILE, AND CANNOT BE
// -----------------------------------------------------------------------------
//
// `docs/specs/realtime-interview.md` §12's second locked decision. The mint
// returns an ephemeral secret the browser uses to open its own connection to
// the provider; the learner's own key never leaves the API process on any code
// path. There is no request here that could ask for one and no response shape
// that could carry one — see the `Realtime*` types in `types/index.ts`.
// =============================================================================

/**
 * Mint one ephemeral realtime session for this interview —
 * `POST /api/interviews/:id/realtime-session`.
 *
 * NO REQUEST BODY, deliberately: the officer's instructions, the tools the
 * model may call and the session's lifetime are all the server's, built from
 * this interview's own state. A body would be the first field through which a
 * caller could ask for a session that is not this interview's.
 *
 * ALL THREE OUTCOMES ARE HTTP 200 — read `status`. A non-2xx would be
 * flattened into generic failure handling and the `cause`, the one fact an
 * `unavailable` response exists to carry, would never reach the screen. On
 * `unavailable` or `failed` the caller conducts the interview in text, with
 * the same interview id and no loss of progress (§7).
 *
 * SAFE TO CALL AGAIN while the interview is `in_progress`: the secret is short
 * -lived by design, and a re-mint resolves the interview's CURRENT engine state
 * — so a dropped connection resumes at whatever question the engine says comes
 * next, never at the first one.
 */
export async function createRealtimeSession(
  id: string,
): Promise<RealtimeSessionResponse> {
  return api.post<RealtimeSessionResponse>(
    `/interviews/${id}/realtime-session`,
    // An empty object rather than nothing, so the request carries the JSON
    // content type every other POST in this file does. The route accepts no
    // fields; sending `{}` is how "there is nothing to configure" travels.
    {},
  );
}

/**
 * Relay one tool call from the realtime session to the engine —
 * `POST /api/interviews/:id/realtime/tool-calls`.
 *
 * THE BROWSER IS A RELAY AND NOTHING MORE. It forwards the call the model
 * emitted and hands the result back over the same data channel. It does not
 * interpret the result, does not grade, does not choose a question, and does
 * not decide whether a phase is over — the whole reason this route exists is
 * that those decisions are the engine's (§4).
 *
 * A REFUSAL IS A 200 WITH AN `instruction`, NOT AN ERROR. `status: 'rejected'`
 * means the interview's own state did not permit the call; the `instruction`
 * field says what the model should do instead, and relaying it verbatim is
 * what gets the interview moving again. Treating it as a failure would leave
 * the officer waiting on a tool result that never arrives — a live
 * conversation that has silently stopped, with nothing on screen to say so.
 */
export async function sendRealtimeToolCall(
  id: string,
  call: RealtimeToolCallInput,
): Promise<RealtimeToolCallResponse> {
  return api.post<RealtimeToolCallResponse>(
    `/interviews/${id}/realtime/tool-calls`,
    call,
  );
}

// =============================================================================
// English — reading and writing (issue #136, epic #59 / E10)
// =============================================================================

/**
 * The next sentence for one segment — `GET /api/english/next?kind=…`.
 *
 * `@Auth()` with no permissions and no user id: the same posture
 * `getPracticeQueue`/`getProgressMastery` already take, for the same reason —
 * every learner owns their own English history, resolved from the JWT.
 *
 * SELECTION IS THE SERVER'S, AND IT IS DETERMINISTIC. Untried sentences first,
 * then the ones most recently missed, then partials, then passes. A client that
 * picked its own sentence out of a list would undo that ordering silently, and
 * there is no endpoint that would let it: this returns ONE sentence.
 *
 * `sentence: null` is an honest absence, NOT a 404 — the request was valid and
 * the answer is that no sentences are loaded for this segment. Render it as
 * prose; there is nothing for the learner to fix.
 */
export async function getNextEnglishSentence(
  kind: EnglishSegmentKind,
): Promise<EnglishNextResponse> {
  return api.get<EnglishNextResponse>(`/english/next?kind=${kind}`);
}

/**
 * Submit one reading or writing attempt — `POST /api/english/attempts`.
 *
 * THE CALLER NEVER SENDS THE VERDICT. There is no `outcome`, `wer` or `diff`
 * field on the request; the server normalises both sides, aligns them word by
 * word, and decides. `kind` is read from the sentence rather than from the
 * body, so there is nothing here for a client to get wrong about which segment
 * it is in.
 *
 * READ `status`, NOT THE HTTP CODE — both arms are 200.
 *
 *   * `scored` wrote exactly one `english_attempts` row. `attemptId` and
 *     `outcome` are that row's.
 *   * `misheard` wrote **NOTHING**. The recogniser reported low confidence on a
 *     reading attempt that did not score `correct`, and
 *     `docs/specs/english-test.md` §3 requires that this leave no trace: a
 *     transcript we do not believe is not weak evidence of a reading skill, it
 *     is none. The diff still comes back so the learner can see what was heard.
 *     **Never render it as a failure** — offer the retry instead.
 *
 * This is a deliberate divergence from practice, where `misheard` is a
 * `failureCause` on a row that IS written. Both are right for their own table;
 * a caller that shares code between them must not share this branch.
 */
export async function recordEnglishAttempt(
  input: RecordEnglishAttemptInput,
): Promise<EnglishAttemptResult> {
  return api.post<EnglishAttemptResult>('/english/attempts', input);
}

/**
 * The caller's own reading and writing history — `GET /api/english/progress`.
 *
 * Three grains of one evidence set: per sentence, per USCIS vocabulary
 * category, and per segment. No parameters — "my English progress" is the one
 * question it answers, and the query DTO rejects anything else rather than
 * silently ignoring it.
 */
export async function getEnglishProgress(): Promise<EnglishProgress> {
  return api.get<EnglishProgress>('/english/progress');
}
