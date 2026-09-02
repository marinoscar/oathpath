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
    const { skipAuth = false, ...fetchOptions } = options;

    const headers: HeadersInit = {
      ...fetchOptions.headers,
    };

    // Only set Content-Type for requests with a body (Fastify 5 is strict about this)
    if (fetchOptions.body) {
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
        // Update authorization header with new token and retry ONCE
        const retryHeaders: HeadersInit = {
          'Content-Type': 'application/json',
          ...fetchOptions.headers,
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

        if (retryResponse.status === 204) {
          return undefined as T;
        }

        const data = await retryResponse.json();
        return data.data ?? data;
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

    // Handle 204 No Content
    if (response.status === 204) {
      return undefined as T;
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
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  put<T>(endpoint: string, body?: unknown, options?: RequestOptions) {
    return this.request<T>(endpoint, {
      ...options,
      method: 'PUT',
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  patch<T>(endpoint: string, body?: unknown, options?: RequestOptions) {
    return this.request<T>(endpoint, {
      ...options,
      method: 'PATCH',
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  delete<T>(endpoint: string, options?: RequestOptions) {
    return this.request<T>(endpoint, { ...options, method: 'DELETE' });
  }
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
  NotificationEventDef,
  AppNotification,
  NotificationListResponse,
  UnreadCountResponse,
  JourneyProfileResponse,
  UpdateJourneyProfileInput,
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
