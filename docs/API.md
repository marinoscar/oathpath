# API Reference

## Base URL

- **Development**: http://localhost:3535/api
- **Production**: https://yourdomain.com/api

## Authentication

All endpoints require JWT Bearer token authentication unless explicitly marked as **Public**.

**Authorization Header:**
```
Authorization: Bearer <access_token>
```

Access tokens are short-lived (15 minutes by default). Use the refresh token flow to obtain new access tokens.

## Response Format

### Success Response

```json
{
  "data": <response_data>,
  "meta": {
    "timestamp": "2024-01-01T00:00:00.000Z"
  }
}
```

### Error Response

```json
{
  "statusCode": 400,
  "message": "Human readable error message",
  "error": "BadRequest"
}
```

For validation errors:
```json
{
  "statusCode": 400,
  "message": ["Field validation error 1", "Field validation error 2"],
  "error": "BadRequest"
}
```

## Pagination

Endpoints returning lists support pagination with the following query parameters:

| Parameter | Type | Default | Max | Description |
|-----------|------|---------|-----|-------------|
| `page` | number | 1 | - | Page number (1-indexed) |
| `pageSize` | number | 20 | 100 | Items per page |

**Paginated Response Format:**
```json
{
  "data": [...],
  "meta": {
    "total": 150,
    "page": 1,
    "pageSize": 20,
    "totalPages": 8
  }
}
```

---

## Endpoints

### Authentication

#### GET /auth/providers
**Public endpoint** - List enabled OAuth providers.

**Response:**
```json
{
  "data": {
    "providers": [
      {
        "name": "google",
        "enabled": true
      }
    ]
  }
}
```

---

#### GET /auth/google
**Public endpoint** - Initiate Google OAuth flow. Redirects to Google consent screen.

**Response:** HTTP 302 redirect to Google

---

#### GET /auth/google/callback
**Public endpoint** - OAuth callback handler (called by Google).

**Query Parameters:**
- `code` (string) - Authorization code from Google
- `state` (string, optional) - CSRF protection state

**Response:** HTTP 302 redirect to frontend with access token in query parameter
- Sets HttpOnly refresh token cookie
- Redirects to `/auth/callback?accessToken=<token>`

**Error Cases:**
- Email not in allowlist → Redirects to `/auth/error?error=not_authorized`
- OAuth failure → Redirects to `/auth/error?error=oauth_failed`

---

#### GET /auth/me
**Requires Authentication** - Get current user profile.

**Response:**
```json
{
  "id": "uuid",
  "email": "user@example.com",
  "displayName": "John Doe",
  "profileImageUrl": "https://...",
  "isActive": true,
  "roles": [
    {
      "id": "uuid",
      "name": "admin",
      "description": "Administrator with full access"
    }
  ],
  "permissions": ["users:read", "users:write", "system_settings:read", ...]
}
```

---

#### POST /auth/refresh
**Public endpoint** - Refresh access token using refresh token cookie.

**Request:** No body required (uses HttpOnly cookie)

**Response:**
```json
{
  "accessToken": "new_jwt_access_token",
  "expiresIn": 900
}
```

Sets new refresh token in HttpOnly cookie (token rotation).

**Error Cases:**
- 401 Unauthorized - Missing or invalid refresh token
- 403 Forbidden - User is disabled

---

#### POST /auth/logout
**Requires Authentication** - Logout and revoke refresh token.

**Request:** No body required

**Response:** HTTP 204 No Content
- Clears refresh token cookie
- Revokes refresh token in database

---

#### POST /auth/logout-all
**Requires Authentication** - Logout from all devices and revoke all refresh tokens.

**Request:** No body required

**Response:** HTTP 204 No Content
- Clears refresh token cookie
- Revokes ALL refresh tokens for the current user across all devices

**Use Case:** Security feature to force re-authentication on all sessions (e.g., after password change or suspected compromise).

---

### Device Authorization (RFC 8628)

The Device Authorization Flow enables input-constrained devices (CLI tools, IoT devices, Smart TVs) to obtain user authorization. See [DEVICE-AUTH.md](DEVICE-AUTH.md) for comprehensive guide and integration examples.

#### POST /auth/device/code
**Public endpoint** - Generate device code pair to initiate device authorization flow.

**Request Body:**
```json
{
  "clientInfo": {
    "name": "My CLI Tool",
    "version": "1.0.0",
    "platform": "linux"
  }
}
```

**Fields:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `clientInfo` | object | No | Optional metadata about client device |
| `clientInfo.name` | string | No | Application name |
| `clientInfo.version` | string | No | Application version |
| `clientInfo.platform` | string | No | Platform identifier |

**Response:**
```json
{
  "data": {
    "deviceCode": "a4f3b8c9d2e1f5a6b7c8d9e0f1a2b3c4",
    "userCode": "ABCD-1234",
    "verificationUri": "http://localhost:3535/device",
    "verificationUriComplete": "http://localhost:3535/device?code=ABCD-1234",
    "expiresIn": 900,
    "interval": 5
  }
}
```

**Response Fields:**
| Field | Type | Description |
|-------|------|-------------|
| `deviceCode` | string | Opaque code for device polling (keep secret) |
| `userCode` | string | Human-readable code for user entry (XXXX-XXXX format) |
| `verificationUri` | string | URL where user should authorize |
| `verificationUriComplete` | string | URL with user code pre-filled |
| `expiresIn` | number | Code lifetime in seconds (default: 900) |
| `interval` | number | Minimum polling interval in seconds (default: 5) |

---

#### POST /auth/device/token
**Public endpoint** - Poll for authorization status and obtain tokens when approved.

**Request Body:**
```json
{
  "deviceCode": "a4f3b8c9d2e1f5a6b7c8d9e0f1a2b3c4"
}
```

**Response (200 OK - Authorized):**
```json
{
  "data": {
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "refreshToken": "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6",
    "tokenType": "Bearer",
    "expiresIn": 900
  }
}
```

**Error Responses (400 Bad Request):**

While authorization is pending:
```json
{
  "error": "authorization_pending",
  "error_description": "User has not yet authorized this device"
}
```

Device polling too frequently:
```json
{
  "error": "slow_down",
  "error_description": "Polling too frequently. Please slow down."
}
```

Code has expired:
```json
{
  "error": "expired_token",
  "error_description": "The device code has expired"
}
```

User denied authorization:
```json
{
  "error": "access_denied",
  "error_description": "User denied the authorization request"
}
```

**Error Response (401 Unauthorized):**

Invalid device code:
```json
{
  "error": "invalid_grant",
  "error_description": "Invalid device code"
}
```

**Usage:**
1. Device requests code from `/auth/device/code`
2. Device displays `userCode` and `verificationUri` to user
3. Device polls this endpoint every `interval` seconds
4. User visits verification page and approves device
5. Polling returns tokens when approved

---

#### GET /auth/device/activate
**Requires Authentication** - Get activation page information and validate user code.

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `code` | string | No | User verification code to validate |

**Request (No Code):**
```http
GET /auth/device/activate
Authorization: Bearer <token>
```

**Response (No Code):**
```json
{
  "data": {
    "verificationUri": "http://localhost:3535/device"
  }
}
```

**Request (With Code):**
```http
GET /auth/device/activate?code=ABCD-1234
Authorization: Bearer <token>
```

**Response (With Valid Code):**
```json
{
  "data": {
    "verificationUri": "http://localhost:3535/device",
    "userCode": "ABCD-1234",
    "clientInfo": {
      "name": "My CLI Tool",
      "version": "1.0.0",
      "platform": "linux"
    },
    "expiresAt": "2024-01-01T12:15:00.000Z"
  }
}
```

**Error Cases:**
- 404 Not Found - Invalid user code
- 400 Bad Request - Code has expired or already been processed

---

#### POST /auth/device/authorize
**Requires Authentication** - Approve or deny device authorization request.

**Request Body:**
```json
{
  "userCode": "ABCD-1234",
  "approve": true
}
```

**Fields:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `userCode` | string | Yes | User code from the device |
| `approve` | boolean | Yes | true to approve, false to deny |

**Response:**
```json
{
  "data": {
    "success": true,
    "message": "Device authorized successfully"
  }
}
```

**Error Cases:**
- 404 Not Found - Invalid user code
- 400 Bad Request - Code has expired or already been processed

---

#### GET /auth/device/sessions
**Requires Authentication** - List current user's approved device sessions.

**Query Parameters:**
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `page` | number | No | 1 | Page number |
| `limit` | number | No | 10 | Items per page |

**Response:**
```json
{
  "data": {
    "sessions": [
      {
        "id": "uuid-1234",
        "userCode": "ABCD-1234",
        "status": "approved",
        "clientInfo": {
          "name": "My CLI Tool",
          "version": "1.0.0",
          "platform": "linux"
        },
        "createdAt": "2024-01-01T12:00:00.000Z",
        "expiresAt": "2024-01-01T12:15:00.000Z"
      }
    ],
    "total": 5,
    "page": 1,
    "limit": 10
  }
}
```

**Use Case:** View all devices that have been authorized to access the account.

---

#### DELETE /auth/device/sessions/:id
**Requires Authentication** - Revoke a specific device session.

**Parameters:**
- `id` (UUID) - Session ID to revoke

**Response:**
```json
{
  "data": {
    "success": true,
    "message": "Device session revoked successfully"
  }
}
```

**Error Cases:**
- 404 Not Found - Session not found or doesn't belong to current user

**Use Case:** Revoke access for lost or compromised devices.

---

### Test Authentication (Development/Test Only)

**Security Notice:** These endpoints are completely disabled in production. They exist solely to enable automated E2E testing without requiring real OAuth credentials.

#### POST /auth/test/login
**Development/Test Only** - Authenticate as a test user without OAuth.

**Availability:** Only when `NODE_ENV !== 'production'`

**Request Body:**
```json
{
  "email": "test@test.local",
  "role": "admin",
  "displayName": "Test Admin"
}
```

**Fields:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `email` | string | Yes | Email address for test user |
| `role` | enum | No | Role to assign: `admin`, `contributor`, `viewer` (default: `viewer`) |
| `displayName` | string | No | Display name for the user |

**Response:** HTTP 302 redirect to `/auth/callback?token=<accessToken>&expiresIn=900`
- Sets HttpOnly refresh token cookie (same as OAuth flow)
- Creates user if not exists, assigns specified role

**Error Cases:**
- 403 Forbidden - Endpoint disabled (production environment)
- 400 Bad Request - Invalid email or role

**Use Case:** Playwright E2E tests use this endpoint to authenticate without Google OAuth.

---

### Users

**All user endpoints require Admin role (`users:read` or `users:write` permissions)**

#### GET /users
List all users with pagination and filtering.

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `page` | number | 1 | Page number |
| `pageSize` | number | 20 | Items per page (max 100) |
| `search` | string | - | Search by email or display name |
| `isActive` | boolean | - | Filter by active status |
| `role` | string | - | Filter by role name |
| `sortBy` | enum | `createdAt` | Sort field: `email`, `createdAt`, `updatedAt` |
| `sortOrder` | enum | `desc` | Sort order: `asc`, `desc` |

**Response:**
```json
{
  "data": [
    {
      "id": "uuid",
      "email": "user@example.com",
      "displayName": "John Doe",
      "profileImageUrl": "https://...",
      "providerDisplayName": "John Doe",
      "providerProfileImageUrl": "https://lh3.googleusercontent.com/...",
      "isActive": true,
      "createdAt": "2024-01-01T00:00:00.000Z",
      "roles": [
        {
          "id": "uuid",
          "name": "contributor"
        }
      ]
    }
  ],
  "meta": {
    "total": 50,
    "page": 1,
    "pageSize": 20,
    "totalPages": 3
  }
}
```

**Note:** `providerDisplayName` and `providerProfileImageUrl` may be null if not available from OAuth provider.

---

#### GET /users/:id
Get user by ID.

**Parameters:**
- `id` (UUID) - User ID

**Response:**
```json
{
  "id": "uuid",
  "email": "user@example.com",
  "displayName": "John Doe",
  "profileImageUrl": "https://...",
  "providerDisplayName": "John Doe",
  "providerProfileImageUrl": "https://lh3.googleusercontent.com/...",
  "isActive": true,
  "createdAt": "2024-01-01T00:00:00.000Z",
  "updatedAt": "2024-01-01T00:00:00.000Z",
  "roles": [
    {
      "id": "uuid",
      "name": "contributor",
      "description": "Standard user capabilities"
    }
  ],
  "identities": [
    {
      "provider": "google",
      "providerEmail": "user@example.com"
    }
  ]
}
```

**Note:** `providerDisplayName` and `providerProfileImageUrl` may be null if not available from OAuth provider.

**Error Cases:**
- 404 Not Found - User not found

---

#### PATCH /users/:id
Update user properties (activation status, display name).

**Requires:** `users:write` permission

**Parameters:**
- `id` (UUID) - User ID

**Request Body:**
```json
{
  "isActive": false,
  "displayName": "New Name"
}
```

**Fields:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `isActive` | boolean | No | Activate or deactivate user |
| `displayName` | string | No | Update user's display name |

**Response:**
```json
{
  "id": "uuid",
  "email": "user@example.com",
  "displayName": "New Name",
  "isActive": false,
  "roles": [
    {
      "id": "uuid",
      "name": "viewer"
    }
  ]
}
```

**Error Cases:**
- 404 Not Found - User not found

---

#### PUT /users/:id/roles
Update user roles (replaces all current roles).

**Requires:** `rbac:manage` permission

**Parameters:**
- `id` (UUID) - User ID

**Request Body:**
```json
{
  "roleNames": ["admin", "contributor"]
}
```

**Fields:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `roleNames` | string[] | Yes | Array of role names to assign (min: 1) |

**Response:**
```json
{
  "id": "uuid",
  "email": "user@example.com",
  "displayName": "John Doe",
  "isActive": true,
  "roles": [
    {
      "id": "uuid",
      "name": "admin",
      "description": "Administrator with full access"
    },
    {
      "id": "uuid",
      "name": "contributor",
      "description": "Standard user capabilities"
    }
  ]
}
```

**Validation Rules:**
- Cannot remove own admin role (prevents accidental lockout)
- At least one role must be assigned
- Role names must exist in the system

**Error Cases:**
- 400 Bad Request - Invalid role names, empty array, or attempting to remove own admin role
- 401 Unauthorized - Not authenticated
- 403 Forbidden - Missing `rbac:manage` permission
- 404 Not Found - User not found

---

### Allowlist

**All allowlist endpoints require Admin role (`allowlist:read` or `allowlist:write` permissions)**

The allowlist restricts application access to pre-authorized email addresses. Users must have their email in the allowlist before they can complete OAuth login.

#### GET /allowlist
List allowlisted emails with pagination, filtering, and sorting.

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `page` | number | 1 | Page number |
| `pageSize` | number | 20 | Items per page (max 100) |
| `search` | string | - | Search by email |
| `status` | enum | `all` | Filter by status: `all`, `pending`, `claimed` |
| `sortBy` | enum | `addedAt` | Sort by: `email`, `addedAt`, `claimedAt` |
| `sortOrder` | enum | `desc` | Sort order: `asc`, `desc` |

**Response:**
```json
{
  "data": [
    {
      "id": "uuid",
      "email": "user@example.com",
      "addedBy": {
        "id": "uuid",
        "email": "admin@example.com"
      },
      "addedAt": "2024-01-01T00:00:00.000Z",
      "claimedBy": {
        "id": "uuid",
        "email": "user@example.com",
        "displayName": "John Doe"
      },
      "claimedAt": "2024-01-02T00:00:00.000Z",
      "notes": "New team member"
    },
    {
      "id": "uuid",
      "email": "pending@example.com",
      "addedBy": {
        "id": "uuid",
        "email": "admin@example.com"
      },
      "addedAt": "2024-01-03T00:00:00.000Z",
      "claimedBy": null,
      "claimedAt": null,
      "notes": null
    }
  ],
  "meta": {
    "total": 100,
    "page": 1,
    "pageSize": 20,
    "totalPages": 5
  }
}
```

**Note:** `addedBy` object contains only `id` and `email` (no `displayName`). `claimedBy` object contains `id`, `email`, and `displayName` when not null.

**Status Filters:**
- `all` - All allowlist entries
- `pending` - Emails not yet claimed by a user (claimedBy is null)
- `claimed` - Emails claimed by registered users (claimedBy is not null)

---

#### POST /allowlist
Add email to allowlist.

**Requires:** `allowlist:write` permission

**Request Body:**
```json
{
  "email": "newuser@example.com",
  "notes": "Marketing team member - starts next week"
}
```

**Fields:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `email` | string | Yes | Valid email address (case-insensitive) |
| `notes` | string | No | Optional notes about this user |

**Response:**
```json
{
  "id": "uuid",
  "email": "newuser@example.com",
  "addedBy": {
    "id": "uuid",
    "email": "admin@example.com"
  },
  "addedAt": "2024-01-01T00:00:00.000Z",
  "claimedBy": null,
  "claimedAt": null,
  "notes": "Marketing team member - starts next week"
}
```

**Note:** `addedBy` object contains only `id` and `email` (no `displayName`).

**Error Cases:**
- 409 Conflict - Email already exists in allowlist
- 400 Bad Request - Invalid email format

---

#### DELETE /allowlist/:id
Remove email from allowlist.

**Requires:** `allowlist:write` permission

**Parameters:**
- `id` (UUID) - Allowlist entry ID

**Response:** HTTP 204 No Content

**Error Cases:**
- 404 Not Found - Allowlist entry not found
- 400 Bad Request - Cannot remove entry that has been claimed by a user

**Note:** Entries that have been claimed (user has logged in) cannot be removed. This prevents accidentally removing access for existing users.

---

### Settings

#### GET /user-settings
**Requires Authentication** - Get current user's settings.

**Response:**
```json
{
  "theme": "light",
  "profile": {
    "displayName": "John Doe",
    "useProviderImage": true,
    "customImageUrl": null
  },
  "updatedAt": "2024-01-01T00:00:00.000Z",
  "version": 1
}
```

**Fields:**
| Field | Type | Description |
|-------|------|-------------|
| `theme` | enum | UI theme: `light`, `dark`, `system` |
| `profile.displayName` | string \| null | User's display name override |
| `profile.useProviderImage` | boolean | Whether to use OAuth provider's profile image |
| `profile.customImageUrl` | string \| null | Custom profile image URL |
| `updatedAt` | string | ISO 8601 timestamp of last update |
| `version` | number | Version number for optimistic concurrency control |

---

#### PUT /user-settings
**Requires Authentication** - Replace all user settings.

**Request Body:**
```json
{
  "theme": "dark",
  "profile": {
    "displayName": "Jane Doe",
    "useProviderImage": false,
    "customImageUrl": "https://example.com/avatar.jpg"
  }
}
```

**Response:**
```json
{
  "theme": "dark",
  "profile": {
    "displayName": "Jane Doe",
    "useProviderImage": false,
    "customImageUrl": "https://example.com/avatar.jpg"
  },
  "updatedAt": "2024-01-01T12:00:00.000Z",
  "version": 2
}
```

**Note:** This replaces the entire settings object. Use PATCH for partial updates.

---

#### PATCH /user-settings
**Requires Authentication** - Partially update user settings.

**Request Body:**
```json
{
  "theme": "dark"
}
```

**Request Headers (Optional):**
```
If-Match: 1
```

**Response:**
```json
{
  "theme": "dark",
  "profile": {
    "displayName": "John Doe",
    "useProviderImage": true,
    "customImageUrl": null
  },
  "updatedAt": "2024-01-01T12:00:00.000Z",
  "version": 2
}
```

**Optimistic Concurrency Control:**
- Include `If-Match: <version>` header to ensure settings haven't been modified by another request
- Returns **409 Conflict** if version mismatch detected
- Prevents lost updates in concurrent scenarios

**Note:** This performs a shallow merge with existing settings.

---

#### GET /system-settings
**Requires:** `system_settings:read` permission (Admin only)

Get system-wide settings.

**Response:**
```json
{
  "ui": {
    "allowUserThemeOverride": true
  },
  "security": {
    "jwtAccessTtlMinutes": 15,
    "refreshTtlDays": 14
  },
  "features": {},
  "updatedAt": "2024-01-01T00:00:00.000Z",
  "updatedBy": {
    "id": "uuid",
    "email": "admin@example.com"
  },
  "version": 1
}
```

**Fields:**
| Field | Type | Description |
|-------|------|-------------|
| `ui.allowUserThemeOverride` | boolean | Allow users to override system theme |
| `security.jwtAccessTtlMinutes` | number | **Read-only.** JWT access token TTL in minutes, read from the `JWT_ACCESS_TTL_MINUTES` deploy-time environment variable — not stored settings, and not writable through this API |
| `security.refreshTtlDays` | number | **Read-only.** Refresh token TTL in days, read from the `JWT_REFRESH_TTL_DAYS` deploy-time environment variable — not stored settings, and not writable through this API |
| `features` | object | Feature flags (extensible) |
| `updatedAt` | string | ISO 8601 timestamp of last update |
| `updatedBy` | object | User who last updated settings |
| `version` | number | Version number for optimistic concurrency control |

---

#### PUT /system-settings
**Requires:** `system_settings:write` permission (Admin only)

Replace all system settings.

**Request Body:**
```json
{
  "ui": {
    "allowUserThemeOverride": true
  },
  "features": {}
}
```

`security` is not part of the request body — it is a read-only, server-derived
block (see the GET fields table above). Sending it is not an error; the global
`ZodValidationPipe` silently strips unknown keys, so it has no effect.

**Response:**
```json
{
  "ui": {
    "allowUserThemeOverride": true
  },
  "security": {
    "jwtAccessTtlMinutes": 15,
    "refreshTtlDays": 14
  },
  "features": {},
  "updatedAt": "2024-01-01T12:00:00.000Z",
  "updatedBy": {
    "id": "uuid",
    "email": "admin@example.com"
  },
  "version": 2
}
```

---

#### PATCH /system-settings
**Requires:** `system_settings:write` permission (Admin only)

Partially update system settings.

**Request Body:**
```json
{
  "ui": {
    "allowUserThemeOverride": false
  }
}
```

**Request Headers (Optional):**
```
If-Match: 1
```

**Response:**
```json
{
  "ui": {
    "allowUserThemeOverride": false
  },
  "security": {
    "jwtAccessTtlMinutes": 15,
    "refreshTtlDays": 14
  },
  "features": {},
  "updatedAt": "2024-01-01T12:00:00.000Z",
  "updatedBy": {
    "id": "uuid",
    "email": "admin@example.com"
  },
  "version": 2
}
```

**Optimistic Concurrency Control:**
- Include `If-Match: <version>` header to ensure settings haven't been modified by another request
- Returns **409 Conflict** if version mismatch detected
- Prevents lost updates when multiple admins modify settings concurrently

---

### AI Configuration

Two scopes, and the distinction matters for every endpoint below.

The **server** key (`/ai-settings`) is administrator-held. It is used only to
fetch the model catalog and to prove connectivity — **it never runs a user's
request**. Every inference call runs on the **calling user's own key**
(`/ai/key`), so each user sees and pays for their own consumption.

Neither key is ever returned by any endpoint, in any shape. Both live encrypted
in the credential store; the read paths return a masked, non-secret `hint` and
carry compile-time proofs that no secret-bearing field can be added to them.

#### GET /ai-settings
**Requires `system_settings:read`** — the AI configuration plus a masked
description of the stored server key.

**Response:**
```json
{
  "provider": "openai",
  "enabled": true,
  "models": { "tutor": "gpt-5.4", "grader": "gpt-5.4-mini", "realtime": null,
              "transcribe": null, "speak": null, "embed": null },
  "minModelGeneration": 5.4,
  "apiKeyStatus": {
    "configured": true,
    "hint": "••••x9fQ",
    "updatedAt": "2026-08-01T00:00:00.000Z",
    "updatedByUserId": "…"
  },
  "settingsError": null,
  "version": 3,
  "updatedAt": "2026-08-01T00:00:00.000Z",
  "updatedBy": { "id": "…", "email": "admin@example.com" }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `provider` | enum \| null | `null` is "no provider chosen" — a real state, not an absent key |
| `enabled` | boolean | Master switch. A separate axis, so AI can be turned off without losing the configuration |
| `models` | object | Role key → model id. `null` means the role is not bound |
| `minModelGeneration` | number | The generation floor, applied to the **text families only** |
| `apiKeyStatus` | object | Whether a key is stored, its mask, and provenance. **Never the key** |
| `settingsError` | string \| null | Why a stored row would not parse. **Field paths only, never values** |
| `version` | number | Optimistic-concurrency token; send back as `If-Match` |

---

#### PUT /ai-settings
**Requires `system_settings:write`** — replace the AI configuration.

`apiKey` is **write-only**, and **blank preserves**: omit it (or send it empty)
to keep the stored key. There is no way to erase a key through this endpoint —
that is a separate control.

Selecting a provider while no key is stored **and** none is submitted returns
**409**, rather than saving a configuration that cannot do anything and letting
the admin discover it from an empty model dropdown.

**Request Headers (Optional):** `If-Match: 3` — use `0` to assert nothing is
stored yet.

---

#### GET /ai-settings/models
**Requires `system_settings:read`** — the classified model catalog **and** the
model-role registry, in one response.

The roles come back **even when the catalog could not be fetched**: they are
code, not provider data, so a missing key has no bearing on them.

| Query | Description |
|-------|-------------|
| `role` | Restrict to the capability family this role needs. Unknown roles are ignored, not rejected |
| `family` | Restrict to one family directly. `role` takes precedence |
| `showAll` | `true` disables the generation floor and includes every family, including unrecognised ids |

`notConfigured: true` means no server key is stored — the state of every fresh
install, and **not** an error. A provider refusal arrives in `error`, verbatim
and redacted, with HTTP 200.

The generation floor applies to the **text families only**: transcription, TTS
and embedding models use entirely different naming, so a numeric floor would
empty those lists rather than filter them. A model whose generation cannot be
parsed is **not dropped** — it appears under `showAll`.

---

#### POST /ai-settings/test
**Requires `system_settings:write`** — not `:read`. It causes the system to
originate an outbound request on the organisation's credential, and looking is
not calling.

**There is no target parameter.** It tests the saved configuration; a free-text
model id would make this a call-arbitrary-endpoint primitive.

**Returns HTTP 200 even when the test failed.** A refused connection is a
successful diagnosis, and this API's error envelope suppresses detail in
production — read `success`, and show `error`, which carries the provider's
verbatim message with any credential redacted.

`authenticated` is reported **separately** from `success`: a key that
authenticates but cannot reach a bound model is a different problem with a
different fix, and told only "the test failed" an admin would replace a
perfectly good key.

Every attempt is audited, including pre-flight refusals. The master switch is
honoured — testing while AI is off reports that rather than calling out.

---

### AI (Per User)

**Every route below is caller-scoped and takes no user id**, in the path, the
query, or the body. The credential address is resolved from the authenticated
session, so no user can read, write, test or delete another's key by any input —
**and neither can an administrator**. That is enforced structurally rather than
by a permission check.

All are `@Auth()` with **no permissions**: every authenticated user owns their
own credentials, and gating them would leave a Viewer unable to use the app at
all, since a user without a key is blocked from the product.

#### GET /ai/key
Whether **you** have a key saved, its masked hint, and when it last changed.
**The key itself is never returned — not even to its owner.** A lost key is
replaced from OpenAI, not read back from here.

#### PUT /ai/key
Save or replace **your** key. Stored **byte-for-byte, untrimmed** — a key whose
surrounding whitespace is significant is a real key, and altering it would
produce an authentication failure with no visible cause. Blank preserves.

#### DELETE /ai/key
The only way to erase a stored key, deliberately separate from `PUT`.
**Idempotent** — removing when nothing is stored is a success, not a 404.
Removing your key re-arms the first-run gate.

#### POST /ai/key/test
**Reachability, not validity.** Authenticates your key, then checks that each
wired role's bound model is actually reachable on it, and reports **per role**.

The administrator binds model ids using the *server* key; your key may sit in a
different organisation or tier with no access to those models. A check that only
asked "is this key valid" would pass for a key that cannot run a single request
this application makes.

Returns 200 on failure, as the admin test does.

#### GET /ai/status
**Two independent facts, and deliberately no combined flag:**

| Field | Meaning |
|-------|---------|
| `userKeyConfigured` | You have a key saved. `false` **hard-blocks** you into the key setup screen |
| `systemReady` | Provider configured, master switch on, and every wired **text** role (`tutor`, `grader`) bound. `false` does **not** block you. `transcribe`/`speak` unbound never affects this flag — see [`docs/specs/voice.md`](specs/voice.md#1-the-degradation-rule) §1 |
| `enabled` | The master switch, so a message can name the control that is off |
| `providerConfigured` | Whether a provider has been chosen |
| `unboundRoles` | Wired roles with no model bound, by key. Names only |

Merging the first two would tell a user blocked by missing *administrator*
configuration to add a key they already have.

Cheap by design: **no outbound provider call is ever made on this path**,
because the client consults it on every navigation and a provider outage must
not lock every user out of an application that has nothing wrong with it.

#### GET /ai/usage
**Recorded usage, not a bill.** Token counts are not dollars, this application
carries no price table, and `callsWithUnknownUsage` counts calls whose
consumption was never reported — a call that fails mid-stream records nothing
rather than zero, because zero would be a claim. The authoritative figure is
your own OpenAI dashboard.

| Query | Description |
|-------|-------------|
| `days` | Window size. Defaults to 30, clamped to 1–365. An unparseable value falls back to the default rather than erroring |

Returns totals plus breakdowns by model and by the role each call served.

---

### AI Speech

Issue #95, epic #58 (E9 "Voice foundation"). Two routes, both `@Auth()` with
**no permissions and no user-id parameter** — the caller is always resolved
from `@CurrentUser('id')`, exactly like every other route in this section:
every authenticated learner speaks with their own voice on their own key, and
gating either route would leave a Viewer unable to practice at all.

**Binding `transcribe` or `speak` is entirely optional and never affects
`systemReady`.** See
[`docs/specs/voice.md`](specs/voice.md#1-the-degradation-rule) §1 for why, and
[`docs/runbooks/configuring-voice.md`](runbooks/configuring-voice.md) for what
each role costs and controls. Both routes run inference on the **caller's**
own key, so usage lands on that learner's own `GET /ai/usage`, under
`roleKey: 'transcribe'` / `roleKey: 'speak'` — never on the server credential.

**Both responses are discriminated unions on `status`, and both are always
HTTP 200** — `ok` (transcribe only), `unavailable` (`{ cause, role }`), or
`failed` (`{ errorCode, error }`). A non-2xx here would discard the one fact
either response exists to carry: *why* no answer or no audio was produced,
which a caller (`AiNotReady`-style UI) needs to render correctly. `cause` is
one of `no_user_key` / `ai_disabled` / `role_unbound` /
`capability_unsupported` — the same four values every other AI feature in
this application uses (`docs/specs/ai-evaluation.md` §4).

#### POST /ai/speech/transcribe
Multipart upload, one audio file in the `audio` field (optional
`languageHint`, ISO-639-1, and `durationSeconds` fields). Turns the
recording into text **on your own key** and returns
`{ status: 'ok', text, confidence }` — confidence is `null` when the
recogniser did not report one, and that means *unknown*, never zero.

**Nothing is graded here, and nothing is stored.** No practice attempt is
written, and the recording is never persisted anywhere — not in object
storage, not on disk, not in a log — it exists for the length of the
provider call and is then dropped. The transcript is meant to be shown to
the learner to confirm or correct **before** it is submitted as a practice
answer.

Capped at **10 MB and 120 seconds**, both enforced before any provider call
is made — an oversized or overlong upload is a 400 and costs nothing.

#### POST /ai/speech/synthesize
`{ text: string, voice?: string, format?: string }`, `text` capped at 1000
characters. On success, streams back audio bytes with the provider's own
`Content-Type` (e.g. `audio/mpeg`). When there is no audio, the response is
`application/json` carrying `unavailable`/`failed` as above — **told apart
from the audio case by `Content-Type`, not by status code**, since both are
HTTP 200.

This is an upgrade over the browser's built-in `speechSynthesis`, which is
the default everywhere and needs no configuration — an unbound `speak` is
not a degraded state and nothing renders a warning for it.

---

### Journey

Issue #65, epic #50. Everything behind the learner's own onboarding, home
screen, and stage registry. Design rationale lives in
[`docs/specs/journey-shell.md`](specs/journey-shell.md) — this section covers
only the wire contract.

**Every route below is `@Auth()` with no permissions**, and every route is
caller-scoped: the learner is resolved from the authenticated session, never
from a path, query, or body parameter, so there is no input that could name
another user's profile. Every authenticated user owns their own learner
profile, and `RequireOrientation` hard-blocks an unoriented learner on the
web, so gating these routes with a permission would leave the gated role
unable to clear the gate at all — the same reasoning `/ai/key` above is gated
on nothing.

#### GET /journey/profile
The caller's own `learner_profiles` row, plus the two reference lists the
orientation form needs to render: every civics test version, and the 56 US
states and territories.

**This `GET` writes on its first call for a user.** A learner with no
`learner_profiles` row yet has one upserted at every column default
(`stage: "uncertain"`, no state, no test version) rather than being sent a
404 on the first screen of a first login.

**Response:**
```json
{
  "data": {
    "profile": {
      "stage": "uncertain",
      "interviewDate": null,
      "stateCode": null,
      "testVersionCode": null,
      "seniorExemption": false,
      "dailyGoalMinutes": 5,
      "explanationLanguage": "en",
      "timezone": "UTC",
      "orientationCompletedAt": null
    },
    "testVersions": [
      {
        "code": "v2008",
        "label": "2008 Civics Test",
        "questionsAsked": 10,
        "passThreshold": 6,
        "seniorQuestionsAsked": 10,
        "seniorPassThreshold": 6,
        "filedFrom": null
      }
    ],
    "states": [
      { "code": "CA", "name": "California" }
    ]
  }
}
```

The response is `{ profile, testVersions, states }` — **never a bare
profile** — because one orientation form renders all three together, and
fetching them as three separate round trips could let a test version added
between two calls disagree with what the form validates against.

---

#### PUT /journey/profile
Apply an orientation or settings save to the caller's own profile. Both
`/setup/journey` (orientation) and `/settings/journey` write here.

**Every field is optional and merges: an absent key leaves that field
unchanged.** The one exception is `interviewDate`, where an explicit `null`
clears a booked interview — the one field where clearing has to be
expressible.

**Request Body (all fields optional):**
```json
{
  "interviewDate": "2026-03-15",
  "stateCode": "CA",
  "filingDate": "2025-09-01",
  "seniorExemption": false,
  "dailyGoalMinutes": 15,
  "explanationLanguage": "en",
  "timezone": "America/Los_Angeles"
}
```

| Field | Description |
|-------|-------------|
| `interviewDate` | `YYYY-MM-DD`, or explicit `null` to clear it |
| `stateCode` | One of the 56 US state/territory codes; uppercased before validation |
| `testVersionCode` | A known `civics_test_versions.code` — mutually exclusive with `filingDate` |
| `filingDate` | `YYYY-MM-DD`. The **server** resolves the applicable test version from this date; the browser never learns the cutoff rule |
| `seniorExemption` | Self-attested 65/20 accommodation |
| `dailyGoalMinutes` | Integer, 1–480 |
| `explanationLanguage` | A well-formed BCP-47 tag (structure checked, not registry membership) |
| `timezone` | An IANA zone name `Intl` can format in |

**`filingDate` and `testVersionCode` are alternatives — sending both is a
400.** Unknown state code, unknown test version, a malformed timezone or
language tag, or a `dailyGoalMinutes` outside 1–480 is also a 400.

**Orientation completion is inferred server-side, never a client flag.**
There is no `completeOrientation` parameter to send: once the merged profile
holds a test version, a state, a timezone, a daily goal and an explanation
language, the server sets `orientationCompletedAt` and moves `stage` from
`uncertain` to `oriented`, once. A later save that re-supplies the same
fields changes neither again. There is likewise no `stage` field in the
request — the transition is a consequence, never something a caller
requests.

**Response:** the same shape as `GET /journey/profile`, reflecting the write.

Every successful call records an `audit_events` row with
`action: "journey:profile_update"`, `targetType: "learner_profile"`, and
`meta: { fields: string[], orientationCompleted: boolean }` — the names of
the fields that changed, never their values, since this profile can hold
where a learner lives and when their naturalization interview is.

---

#### GET /journey/home
The caller's home-screen data: where they are, how long they have, and the
one thing to do next.

**Response:**
```json
{
  "data": {
    "stage": "oriented",
    "interviewDate": "2026-03-15",
    "daysUntilInterview": 12,
    "interviewPast": false,
    "dailyGoal": { "minutes": 15, "tracked": false },
    "nextAction": {
      "kind": "interview_countdown",
      "title": "12 days until your interview",
      "reason": "Practice is the closest thing to the real interview. A few questions today, and the day itself will feel familiar.",
      "path": "/practice"
    }
  }
}
```

| Field | Description |
|-------|-------------|
| `daysUntilInterview` | Whole **calendar** days in the learner's own timezone, computed through `Clock`, not an elapsed-milliseconds division. Negative once the date has passed; `null` when no interview is booked |
| `interviewPast` | Sent as its own fact rather than left for a client to derive from a negative count. Today is NOT past |
| `dailyGoal.tracked` | Literally `false` for the whole of this release — nothing measures practice time yet, and there is deliberately no `minutesToday`: a displayed `0` would be indistinguishable from a learner who did nothing today |
| `nextAction` | Produced by a pure function over the profile — no model call — so two consecutive loads return the same answer |

`nextAction.kind` is one of five values today — `orientation`,
`interview_countdown`, `review`, `practice`, `explore` — each mapping to one
fixed, non-redirecting route (`apps/api/src/journey/next-action.ts`'s
`NEXT_ACTION_PATHS`). `practice` (issue #81, epic #52 / E3) and `review`
(issue #82, epic #54 / E5) were both added after this release's original
three; the interview stage (E8) still widens this set further.

`review` is produced only by `apps/api/src/journey/study-coach.ts`'s
`recommendStudyAction` — never by this route's own recommender directly —
when the caller has `dueCount + lapsedCount > 0` question(s) waiting (the
same `due`/`weak` counts `GET /practice/queue` below reports). Ranked between
`interview_countdown` and `practice`:

```json
{
  "kind": "review",
  "title": "Review 4 questions.",
  "reason": "You have 4 questions ready to review — reviewing what you've already learned keeps it from slipping.",
  "path": "/practice"
}
```

`path` is `/practice` for `interview_countdown`, `review`, and `practice`
alike — three kinds naming one destination, not three routes — and the
Practice page reads `nextAction.kind` itself to decide how to bias what it
shows. See [`docs/specs/memory-model.md`](specs/memory-model.md) §6 for the
full decision (including why the fire condition and the reason text's number
are always the same sum, never `dueCount` alone).

---

#### GET /journey/stages
The eight journey stages, in journey order, with the display copy the UI
renders. Readable by any authenticated user.

**Response:**
```json
{
  "data": [
    {
      "key": "uncertain",
      "label": "Just starting",
      "description": "You're just getting started — that's the whole point of being here."
    }
  ]
}
```

This describes what stages *exist*; it says nothing about which one the
caller is in — that is `profile.stage` from `GET /journey/profile`. The two
are separate endpoints because they have different audiences (the registry
is static; a learner's own stage is not) and different cache lifetimes.

---

### Civics

Epic #51. The versioned, provenance-tracked USCIS civics question bank both
test versions read from. Design rationale — the three-table shape, the
partial-unique-index invariant, the dynamic-answer close-then-open lifecycle,
and the resolution rules below — lives in
[`docs/specs/civics-content.md`](specs/civics-content.md); this section covers
only the wire contract. Operational guidance (which path to use for a content
change, re-seeding) lives in
[`docs/runbooks/updating-civics-content.md`](runbooks/updating-civics-content.md).

**Every route below is `@Auth()` with no permissions**, and none accepts a
caller-supplied user id or state code: `state_code` and `senior_exemption`
always come from the caller's own `learner_profiles` row via
`@CurrentUser('id')`, the identical structural rule `/journey/*` holds to.
Civics content is core product material every authenticated learner reads;
gating it would leave the default Viewer role unable to study at all.

#### GET /civics/versions
Every `civics_test_versions` row.

**Response:**
```json
{
  "data": [
    {
      "code": "v2008",
      "label": "2008 Civics Test",
      "questionsAsked": 10,
      "passThreshold": 6,
      "seniorQuestionsAsked": 10,
      "seniorPassThreshold": 6,
      "contentHash": "3f9c1a…"
    }
  ]
}
```

`contentHash` is a sha256 over the content file the loader last applied —
`null` before any content has been loaded for that version. It answers "does
this environment's database match exactly the content file in git." It is
**not** a hash of the official USCIS source document (that lives in the
content file's own provenance block).

---

#### GET /civics/versions/:code/categories
A version's categories, in `sortOrder` (not alphabetical — Government
precedes History precedes Integrated Civics in the official material).

**Parameters:**
- `code` (string) — a test version code, e.g. `v2008` or `v2025`

**Response:**
```json
{
  "data": [
    { "id": "uuid", "section": "AMERICAN GOVERNMENT", "code": "principles_of_american_democracy", "name": "Principles of American Democracy", "sortOrder": 0 }
  ]
}
```

**Error Cases:**
- 404 Not Found — unknown version code (distinct from "this version has no
  categories loaded yet")

---

#### GET /civics/questions
Paginated question summaries. **No answers** — those are per-caller and
belong on the detail route.

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `page` | number | 1 | Page number |
| `pageSize` | number | 20 | Items per page (max 100) |
| `testVersionCode` | string | — | Restrict to one version. **Omitting it does not mean "every version"** — it falls back to the caller's own resolved `learner_profiles.test_version_code`. Only a caller who has not finished orientation (no resolved version) sees the whole bank |
| `categoryId` | uuid | — | Restrict to one category |
| `seniorEligible` | boolean | — | Restrict to the 65/20 subset or its complement. Explicit filter only — a learner claiming the accommodation is still entitled to browse the full bank |

An unrecognized query parameter is a **400** (`z.strictObject`) rather than
silently ignored — there is deliberately no `userId` or `stateCode` parameter
here.

**Response:**
```json
{
  "data": [
    {
      "id": "uuid",
      "number": 20,
      "prompt": "Who is one of your state's U.S. Senators now?",
      "categoryId": "uuid",
      "testVersionCode": "v2008",
      "seniorEligible": true,
      "dynamicScope": "state"
    }
  ],
  "meta": { "total": 100, "page": 1, "pageSize": 20 }
}
```

---

#### GET /civics/questions/:id
One question, with its answer(s) already resolved for the caller.

**Parameters:**
- `id` (uuid) — question id

**Response:**
```json
{
  "data": {
    "id": "uuid",
    "number": 43,
    "prompt": "Who is the Speaker of the House of Representatives now?",
    "categoryId": "uuid",
    "testVersionCode": "v2008",
    "seniorEligible": false,
    "dynamicScope": "national",
    "category": { "id": "uuid", "section": "AMERICAN GOVERNMENT", "code": "system_of_government", "name": "System of Government", "sortOrder": 1 },
    "answerResolution": "resolved",
    "resolvedForStateCode": null,
    "verifiedAt": "2026-01-15T00:00:00.000Z",
    "answers": [
      { "id": "uuid", "text": "John R. Roe", "sort": 0, "stateCode": null, "verifiedAt": "2026-01-15T00:00:00.000Z", "sourceNote": "U.S. House of Representatives, Office of the Clerk — retrieved 2026-01-15" }
    ]
  }
}
```

How `answers` is populated depends on `dynamicScope`:
- `none` — every simultaneously correct alternative, in slot order (e.g.
  "Name one branch of the government" returns three).
- `national` — the single current answer.
- `state` — the single current answer for the caller's own state.

**`answerResolution: "state_required"` is the case a client must handle.** A
`state`-scope question asked by a learner with no `state_code` set returns
the question with `answers: []` and `verifiedAt: null` — **never** a 404,
never a guess, never another state's answer. Render a prompt to set their
state.

**Error Cases:**
- 404 Not Found — unknown question id

---

#### POST /civics/questions/:id/explain
Issue #120, E4 (epic #53). Streams a tutor's explanation of the answer to one
question, **for this caller**, generated on **their own** stored AI key.
`@Auth()`, no permissions — every authenticated learner owns their own
explanations, and no route accepts a user id or state code (both resolve from
the caller's own `learner_profiles` row, the same resolution
`GET /civics/questions/{id}` uses). See
[`docs/specs/ai-evaluation.md`](specs/ai-evaluation.md) for the dispatch and
grounding design; this section documents the wire contract only.

**Grounded, never consulted.** The question and the answers currently correct
for this learner are read from the database and handed to the model as fact;
it is asked what they *mean*, never what they *are*. That is what keeps a
question whose answer changed after the model's training cutoff — who is
President, who is your governor — from being explained as whoever the model
remembers.

**Language** is the caller's own `explanationLanguage` (their learner
profile), defaulting to `en`. There is no language parameter — a
per-request override would let a request disagree with the person's own
saved setting.

**Transport.** `200 text/event-stream`, hand-written rather than Nest's
`@Sse()` (which hard-codes GET, and this route takes a body). The native
`EventSource` cannot send an `Authorization` header and only ever issues a
GET, so a client must use a fetch-based SSE reader — see
`apps/web/src/services/explainStream.ts`. A `?token=` query parameter is
deliberately unsupported: a bearer token in a URL lands in the nginx access
log, browser history and `Referer`. Disconnecting aborts the upstream call —
inference runs on the learner's own key, so an abandoned stream is money
generating text no one will read — and the usage row is still written, from
`BaseAiProvider.stream`'s own `finally`.

**Parameters:**
- `id` (uuid) — question id

**Request Body** (optional; `POST` with no body is the ordinary call):
```json
{ "focus": "I always mix up the branches" }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `focus` | string, trimmed, max 200 chars | No | What the learner finds confusing, in their own words. Treated strictly as data in the prompt, never as an instruction. |

`z.strictObject` — an unknown key is a 400 naming it. There is no `stateCode`,
`userId`, or `language` field; sending one is rejected rather than ignored.

**Response.** An open `text/event-stream`. An opening `: connected` comment
flushes the headers immediately (dropped by clients, never dispatched as a
frame), then any number of `delta` frames, then **exactly one terminal frame,
always last** — a client that never sees one should treat the connection as
still open, not as failed.

| Frame (`event:`) | `data` | Terminal? | Meaning |
|---|---|---|---|
| `delta` | `{"text": "…"}` | No | One chunk of the explanation. Never empty. Any number may arrive. |
| `done` | `{"usage": {"promptTokens": 212, "completionTokens": 96, "totalTokens": 308}}` | Yes | The explanation is whole. `usage` fields may individually be `null` — never `0` for an unknown count. |
| `unavailable` | `{"cause": "no_user_key" \| "ai_disabled" \| "role_unbound" \| "capability_unsupported"}` | Yes | No call was attempted — the caller has no stored key, or an administrator has not finished configuring AI. **Not a failure**: render the shared "AI is not set up" state, not an error. See `ai-evaluation.md` §4 for what each cause means and why they are checked in that order. |
| `state_required` | `{"answerResolution": "state_required"}` | Yes | A `state`-scope question asked by a learner with no state set. **No model is called** — guessing a state would teach a confident, memorable, wrong governor. Echoes the same discriminator `GET /civics/questions/{id}` returns, so the client renders the prompt it already has. Not an `unavailable` cause — see `civics-explain.service.ts`'s `CivicsExplainFrame` for why this is deliberately a separate, fifth terminal frame rather than a member of that closed four-value set. |
| `error` | `{"errorCode": "…", "error": "…"}` | Yes | The call was attempted and did not produce a usable answer. Deltas already delivered were really received; the explanation is not whole and must not be presented as one. |

Example stream:
```
: connected

event: delta
data: {"text":"The Constitution "}

event: delta
data: {"text":"is the supreme law "}

event: done
data: {"usage":{"promptTokens":212,"completionTokens":96,"totalTokens":308}}

```

**Error Cases:**
- 404 Not Found — unknown question id (thrown, and resolved, before the
  stream opens — an unknown id is an ordinary 404 JSON envelope, never a
  stream that opens and immediately breaks)

---

### Civics Admin

Issue #117. Corrects `national`- and `state`-scope answers at runtime — the
election-result / officeholder-change path.
[`docs/runbooks/updating-civics-content.md`](runbooks/updating-civics-content.md)
explains when to use this versus a content PR. `none`-scope (static) answers
are **not** addressable through this surface at all — those change only
through a reviewed content PR and a re-seed.

**Gate: `system_settings:read` to view, `system_settings:write` to correct —
reused from `system-settings.controller.ts`, never a `civics:*` pair.**

#### GET /civics/dynamic-answers
**Requires `system_settings:read`.** Every `national`- and `state`-scope
question with the answer that is currently **open** for it (`effectiveTo:
null`) — the row a correction would close. The page is over **questions**,
not answer rows: a `state`-scope question carries up to 56 answers (one per
state/territory) as one editable unit, and `total` counts questions.

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `page` | number | 1 | Page number |
| `pageSize` | number | 20 | Items per page (max 100) |
| `testVersionCode` | string | — | Restrict to one version. Omitted means both — an administrator has no "own" version |
| `dynamicScope` | enum | — | `national` or `state`. There is no `none` value — a static question is not addressable here |
| `stateCode` | string | — | Narrow a `state` question's answers to one state. Does **not** drop `national` questions from the page |

**Response:**
```json
{
  "data": [
    {
      "questionId": "uuid",
      "testVersionCode": "v2008",
      "number": 43,
      "prompt": "Who is the Speaker of the House of Representatives now?",
      "categoryId": "uuid",
      "dynamicScope": "national",
      "answers": [
        { "id": "uuid", "text": "John R. Roe", "sort": 0, "stateCode": null, "verifiedAt": "2027-01-03T00:00:00.000Z", "effectiveFrom": "2027-01-03T00:00:00.000Z", "effectiveTo": null, "sourceNote": "…" }
      ],
      "missingStateCodes": []
    }
  ],
  "meta": { "total": 15, "page": 1, "pageSize": 20 }
}
```

**`missingStateCodes`** names any state/territory in scope of the request
with no open answer — the gap this surface makes visible: a `state`-scope
question missing a row for e.g. Wyoming means Wyoming's learners currently
see an unanswerable question.

---

#### PUT /civics/dynamic-answers
**Requires `system_settings:write`.** Records a new answer for one slot (one
question, and for a `state`-scope question one state). **Closes** the
currently open row (`effectiveTo` set to this correction's `effectiveFrom`)
and **opens** a new one, in a single transaction — never an in-place edit of
an existing row's `text`.

**Request Body:**
```json
{
  "questionId": "uuid",
  "stateCode": null,
  "text": "John R. Roe",
  "sourceNote": "U.S. House of Representatives, Office of the Clerk — history.house.gov, retrieved 2027-01-03",
  "effectiveFrom": "2027-01-03"
}
```

**Fields:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `questionId` | uuid | Yes | The question whose answer is being corrected |
| `stateCode` | string | Only for `state`-scope questions | Required for `state` scope, rejected for `national` (both checked server-side, since a schema cannot see the question's scope) |
| `text` | string | Yes | The new accepted answer, verbatim |
| `sourceNote` | string | Yes | The citation — **required on every correction**, no exceptions |
| `effectiveFrom` | string (`YYYY-MM-DD` or ISO-8601) | No | The real-world date the new answer became correct, from the same citation. Omitted, the server clock is the stated fallback — the honest value when no precise date is knowable |

Not accepted, by design: `verifiedAt` (always stamped `Clock.now()` at write
time — it records that a human, the caller, confirmed the text just now),
`sort` (the correction writes into the slot the open row already occupies),
and `effectiveTo` (derived, so the two rows stay contiguous with no gap or
overlap).

**Response:**
```json
{
  "data": {
    "questionId": "uuid",
    "testVersionCode": "v2008",
    "number": 43,
    "prompt": "Who is the Speaker of the House of Representatives now?",
    "categoryId": "uuid",
    "dynamicScope": "national",
    "stateCode": null,
    "previous": { "id": "uuid", "text": "Jane Q. Doe", "sort": 0, "stateCode": null, "verifiedAt": "2026-01-15T00:00:00.000Z", "effectiveFrom": "2023-01-07T00:00:00.000Z", "effectiveTo": "2027-01-03T00:00:00.000Z", "sourceNote": "…" },
    "current": { "id": "uuid", "text": "John R. Roe", "sort": 0, "stateCode": null, "verifiedAt": "2027-01-03T00:00:00.000Z", "effectiveFrom": "2027-01-03T00:00:00.000Z", "effectiveTo": null, "sourceNote": "…" }
  }
}
```

`previous` is `null` only when the slot had no open row at all (content that
was never loaded for that state — the gap `missingStateCodes` reports).
Returning the closed row, rather than only the new value, is deliberate: a
response that showed only the new answer would read exactly like the
in-place edit this design refuses to perform.

**Every accepted correction writes an `audit_events` row**,
`action: "civics:dynamic_answer_update"`, carrying the question id, the
`stateCode` (or `null`), the **old and new `text` in full**, both
`sourceNote`s, and the real-world `effectiveFrom` used. Unlike
`journey:profile_update` (which redacts every field value because a learner's
profile is private), this action records the full diff — civics content is
public exam material, so the diff itself is what a reviewer needs.

**Error Cases:**
- 400 Bad Request — a `none`-scope `questionId`, a `stateCode` on a
  `national` question, a missing `stateCode` on a `state` question, a missing
  `sourceNote`, or an `effectiveFrom` earlier than the answer being replaced
- 404 Not Found — unknown question id

---

### English

Issue #136, epic #59 (E10 "Reading and writing tests"). The naturalization
interview's other two segments: one sentence read aloud and scored on word
accuracy, one sentence heard and typed back. Design rationale — where the
sentences come from and why they are composed rather than transcribed, the
word-error-rate thresholds, the accent rule, the dictation-not-display rule,
and the readiness formula — lives in
[`docs/specs/english-test.md`](specs/english-test.md); this section covers
only the wire contract.

**Every route below is `@Auth()` with no permissions**, and every route is
caller-scoped: the learner is resolved from `@CurrentUser('id')`, never from
a path, query, or body parameter. Every authenticated learner owns their own
reading and writing attempts, exactly as they own their own practice
attempts, so gating these routes would leave the default Viewer role unable
to practise reading and writing at all. This module adds **no permission
string**.

**A sentence is shared content; an attempt is not.** `english_sentences` has
no owner — every learner reads the same bank, exactly as they read the same
civics questions — so an unknown sentence id is a **404 because it genuinely
does not exist**, not because it belongs to somebody else. Attempt rows are
private, and they are protected structurally rather than by a check: **no
route here accepts an attempt id at all.** There is no read-one-attempt
endpoint, no self-mark, and no update, so cross-user access has no
expressible request.

**Scoring is deterministic and identical for both segments.** Both the
sentence and what the learner produced are normalised through the same
pipeline civics answers use, then aligned **word by word**. The error
**count** is checked first and the word-error rate only bounds the
single-error case:

| Condition | Outcome |
|---|---|
| `errors === 0` | `correct` |
| `errors === 1` and `wer <= 0.34` | `correct` |
| otherwise, `wer <= 0.50` | `partial` |
| otherwise | `incorrect` |

One word wrong is not a failure; two words wrong is not reading the
sentence. A flat threshold cannot say that, because the sentences run 3 to 8
words after normalisation: one error in a 3-word sentence is `0.333`, while
two errors in an 8-word sentence is only `0.250` — a smaller rate for the
worse mistake. There is **no AI grader rung here**, unlike Practice.

#### GET /english/next
The next sentence for one segment. **Selection is deterministic** — no
randomness anywhere — and weighted by bucket, in this order:

1. **untried** — no attempt row for that sentence, ever; by composed order
2. **failed** — most recent outcome `incorrect`; oldest attempt first
3. **partial** — most recent outcome `partial`; oldest attempt first
4. **passed** — most recent outcome `correct`; oldest attempt first

So every sentence is seen before any is repeated, and a sentence that was
missed comes back before one that was passed. Only the **newest vocabulary
revision** present is drawn from. The sentence behind the caller's single
most recent attempt of that segment is skipped, **unless it is the only
candidate** — being handed back the sentence just submitted (and just shown
the answer to) measures nothing, but rendering "no sentences available" over
a bank that has one would be a worse lie than a repeat.

**Query Parameters:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `kind` | yes | `reading` or `writing`. No default: whichever one was chosen, a client that forgot the parameter would silently practise the wrong skill and record evidence under the wrong segment |

**Response:**
```json
{
  "data": {
    "sentence": {
      "id": "uuid",
      "kind": "reading",
      "version": "v1",
      "ordinal": 1,
      "text": "Who was the first President?",
      "vocabTags": ["PEOPLE", "QUESTION WORDS"],
      "wordCount": 5
    }
  }
}
```

`sentence` is `null` when no sentences are loaded for that segment — an
honest absence, not a 404: the request was valid and the answer is that the
bank is empty.

| Field | Description |
|-------|-------------|
| `version` | The **vocabulary-list revision** this sentence was composed and validated against — never a version of its own text. A client can tell that a bank it cached has been superseded |
| `vocabTags` | The USCIS vocabulary categories this sentence's own words resolve to, **derived** by the content loader from the same word-by-word validation pass, never hand-authored |
| `wordCount` | The **scorer's** own token count, not a space split: "President of the United States" is one token after normalisation, so a client counting words itself would show a number the outcome was not computed against |

**`text` is returned for the writing segment too, and the writing screen must
never render it.** Dictation defaults to the browser's own
`window.speechSynthesis`, which takes a string, in the browser — so the
client must hold the text to say it at all, on every deployment, with no AI
key, no admin configuration and no per-call cost. The "never shown" rule is
an invariant of the **screen**, not of the wire; withholding `text` here
would leave server-side synthesis (an optional, admin-bound upgrade) as the
only way to hear a writing sentence.

#### POST /english/attempts
Scores one submission and, unless the reading transcript was not trusted,
records it as one `english_attempts` row.

**Request Body:**
```json
{
  "sentenceId": "uuid",
  "responseText": "Who was the first President?",
  "asrConfidence": 0.92,
  "replayCount": 0
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `sentenceId` | yes | The sentence being attempted. Its `kind` and its text — the scoring reference — both come from that row |
| `responseText` | yes | What was actually produced: exactly what was typed (writing), or the **confirmed** transcript (reading), never the raw recogniser output. Max 2000 characters. An empty string is accepted and scores honestly as `incorrect` |
| `asrConfidence` | no | **Reading only**, `0`–`1`. **Absent means the recogniser reported none — it is never `0`.** Sending it on a writing attempt is a 400 |
| `replayCount` | no | **Writing only.** How many times the dictated sentence was replayed. Defaults to `0`, **gates nothing**, and has no server-side limit. A non-zero count on a reading attempt is a 400 — a reading sentence is shown, not dictated |

**The client never sends the verdict.** There is no `outcome`, `wer`,
`diffOps`, `errors`, `kind`, `userId` or `answeredAt` field on this request,
and unknown keys are rejected with a 400 naming them rather than dropped.

**Response** — a discriminated union on `status`, **always HTTP 200**:

```json
{
  "data": {
    "status": "scored",
    "attemptId": "uuid",
    "outcome": "correct",
    "sentenceId": "uuid",
    "kind": "writing",
    "text": "We pay taxes.",
    "responseText": "we pay taxes",
    "wer": 0,
    "errors": 0,
    "substitutions": 0,
    "deletions": 0,
    "insertions": 0,
    "referenceTokenCount": 3,
    "diff": [
      { "kind": "match", "reference": "we", "hypothesis": "we", "referenceIndex": 0 }
    ],
    "normalizedReference": "we pay taxes",
    "normalizedHypothesis": "we pay taxes",
    "answeredAt": "2026-09-04T12:00:00.000Z",
    "asrConfidence": null,
    "replayCount": 0
  }
}
```

```json
{
  "data": {
    "status": "misheard",
    "sentenceId": "uuid",
    "kind": "reading",
    "text": "Who was the first President?",
    "responseText": "hoo woz the ferst prezident",
    "wer": 0.8,
    "errors": 4,
    "diff": [],
    "asrConfidence": 0.42,
    "confidenceThreshold": 0.6
  }
}
```

**`misheard` means NO ROW WAS WRITTEN AT ALL** — not an `incorrect` row, not
a flagged row, nothing. It occurs when all four hold: the sentence is
`reading`, a confidence was reported, it is **strictly below** `0.6`, and the
score was not `correct`. The learner is offered a retry, and only the retry
produces evidence. Note what each condition excludes: a **`null` or absent**
confidence is *unknown*, and unknown is **not** low — a transcript from a
model that reports no confidence is scored and recorded normally; `0.6`
exactly is trusted; and a low-confidence transcript that scored `correct`
anyway is recorded, because whatever the recogniser's misgivings, the words
it produced were the sentence.

This is a deliberate divergence from Practice, where a mishearing is a
`failureCause` on a row that **is** written. A civics attempt records what
the learner *knew*, so even a mistrusted transcript is evidence an attempt
happened; a reading attempt records whether they produced an exact sequence
of words, computed over that transcript itself — so a transcript we do not
believe is not weak evidence of a reading skill, it is none.

**A mishearing is not a client error**, which is why it is a 200: the request
was well formed, and the response carries the diff and the WER so the retry
screen can show what was heard. A 4xx would route all of that into a
client's generic error handling.

**`text` on the response is the reveal.** On a writing attempt this is the
first time the learner sees the sentence they were dictated, beside their own
words and the diff between them.

**Error Cases:**
- 400 Bad Request — `asrConfidence` on a writing attempt, a non-zero
  `replayCount` on a reading attempt, an out-of-range `asrConfidence`, an
  unknown key, or a response over 2000 characters
- 404 Not Found — no such sentence

#### GET /english/progress
The caller's own history with the English bank, at three grains. Scoped to
the current vocabulary revision — the same bank `GET /english/next` draws
from, resolved by the same function, so the two can never disagree about
which sentences exist.

**Response:**
```json
{
  "data": {
    "sentences": [
      {
        "sentenceId": "uuid",
        "kind": "writing",
        "text": "We pay taxes.",
        "ordinal": 1,
        "vocabTags": ["CIVICS"],
        "attempts": 2,
        "bestOutcome": "correct",
        "lastOutcome": "partial",
        "lastWer": 0.33,
        "lastAnsweredAt": "2026-09-04T12:00:00.000Z"
      }
    ],
    "vocabTags": [
      { "tag": "CIVICS", "sentencesTotal": 8, "sentencesAttempted": 5, "sentencesPassed": 3, "attempts": 11 }
    ],
    "byKind": [
      {
        "kind": "reading",
        "sentencesTotal": 18,
        "sentencesAttempted": 4,
        "sentencesPassed": 3,
        "attempts": 6,
        "averageWer": 0.14,
        "version": "v1"
      }
    ]
  }
}
```

| Field | Description |
|-------|-------------|
| `sentences` | **Every** sentence in the current bank, attempted or not — a never-tried sentence appears with `attempts: 0` and null outcomes, because "never tried" is the fact a coverage screen most needs |
| `bestOutcome` / `lastOutcome` | Best-ever and most-recent, reported separately because they answer different questions: passing a sentence in March and slipping on it yesterday is not the same as never having passed it |
| `vocabTags` | The same evidence rolled up by USCIS vocabulary category. A sentence counts toward **every** tag it carries, so these totals deliberately sum to more than the bank size — the question each row answers is "of the sentences exercising this category, how many has this learner got right" |
| `byKind` | Always both segments, present even with no attempts |
| `byKind[].averageWer` | The mean word-error rate across that segment's attempts, or **`null`** — never `0` — when there are none: a mean of zero is a perfect record, the exact opposite of no record |

Attempts against a **superseded** revision are not counted here (they are
neither deleted nor invalidated — they simply describe sentences nobody is
offered any more), so `sentencesAttempted` can never exceed
`sentencesTotal`.

---

### Practice

Issue #73, epic #52 (E3). The practice loop: open a session, be asked a
question, answer it, be graded, and see a summary. Grading is a two-rung
ladder — deterministic string matching first, then (E4, epic #53) a
semantic AI grader on a miss — described below the attempts route; design
rationale for the loop itself — the two-table shape, the normalisation
pipeline, the answer-snapshot lifecycle, and self-mark — lives in
[`docs/specs/practice-sessions.md`](specs/practice-sessions.md), and the
grading ladder's own design lives in
[`docs/specs/ai-evaluation.md`](specs/ai-evaluation.md) §6. This section
covers only the wire contract.

**Every route below is `@Auth()` with no permissions**, and every route is
caller-scoped: the learner is resolved from `@CurrentUser('id')`, never from
a path, query, or body parameter. Every authenticated user owns their own
practice history, exactly as they own their own learner profile or their own
AI key, so gating these routes would leave the default Viewer role unable to
practise at all.

**A session (or an attempt inside one) belonging to another learner is a
404, not a 403.** Confirming that an id names a real session would itself be
the leak — from the caller's position, another learner's session genuinely
does not exist.

**The question shape returned by session creation and by every `nextQuestion`
carries no accepted answers**, on purpose: it is `{ id, number, prompt,
categoryId, dynamicScope }` and nothing else — no `answers`, no
`acceptedAnswers`, not even an empty array standing in for "not yet". This is
a product constraint before it is a security one: recognizing an answer that
arrived in the same payload as the prompt is not recall, and the whole point
of practice is to make the learner produce an answer rather than recognise
one. The answers become legitimate the instant an attempt is graded — they
arrive on `POST .../attempts` as `acceptedAnswers`, never before.

#### POST /practice/sessions
Starts a session and returns it together with its first question, **prompt
only**.

**Request Body:**
```json
{
  "kind": "quick",
  "categoryId": null,
  "plannedCount": 5
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `kind` | `"quick"` \| `"category"` | Yes | The two kinds this epic wires. `review`, `weak`, `mixed` exist in the database enum for E5's spaced-repetition scheduler and are **rejected here** — a 400 naming the field |
| `categoryId` | uuid | Only for `kind: "category"` | **Required** when `kind` is `"category"`, **rejected** (400) otherwise — a `quick` session carrying one would otherwise silently ignore the only filter the client asked for |
| `plannedCount` | integer, 1–20 | No (default 5) | How many questions this session intends to ask. Clamped down to the number actually available for the selection, so "4 of 5" on the summary screen is always honest |

**Any session still `in_progress` for this learner is closed first** —
`status: "abandoned"` — keeping every attempt it already produced. At most
one session is open at a time.

**Response:**
```json
{
  "data": {
    "session": {
      "id": "uuid",
      "kind": "quick",
      "status": "in_progress",
      "testVersionCode": "v2008",
      "categoryId": null,
      "plannedCount": 5,
      "startedAt": "2026-09-02T14:00:00.000Z",
      "completedAt": null,
      "summary": null
    },
    "nextQuestion": {
      "id": "uuid",
      "number": 20,
      "prompt": "Who is one of your state's U.S. Senators now?",
      "categoryId": "uuid",
      "dynamicScope": "state"
    },
    "progress": { "answered": 0, "planned": 5 }
  }
}
```

**Error Cases:**
- 400 Bad Request — invalid body (see table above), or the caller has not
  finished orientation, so no test version is resolved
- 404 Not Found — unknown `categoryId` for this test version
- 409 Conflict — no questions are available to practise for this selection
  (e.g. a `category` session over a category the learner has fully exhausted)

---

#### GET /practice/sessions
The caller's own sessions, newest first, paginated.

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `page` | number | 1 | Page number |
| `pageSize` | number | 20 | Items per page (max 100) |

There are deliberately no filters — `?status=`, `?kind=`, `?userId=`
included — a 400 naming the parameter. "Recent sessions, newest first" is
the one question this endpoint answers.

**Response:**
```json
{
  "data": [
    {
      "id": "uuid",
      "kind": "quick",
      "status": "completed",
      "testVersionCode": "v2008",
      "categoryId": null,
      "plannedCount": 5,
      "startedAt": "2026-09-01T14:00:00.000Z",
      "completedAt": "2026-09-01T14:06:00.000Z",
      "summary": {
        "plannedCount": 5,
        "answered": 5,
        "correct": 4,
        "partial": 0,
        "incorrect": 1,
        "skipped": 0,
        "selfMarked": 1,
        "revealed": 1,
        "hintUsed": 0,
        "totalDurationMs": 42000,
        "timedAttempts": 5
      },
      "answeredCount": 5,
      "correctCount": 4
    }
  ],
  "meta": { "total": 12, "page": 1, "pageSize": 20 }
}
```

`answeredCount`/`correctCount` are counted live from the attempt rows on
every request, not read from the stored `summary` (which is `null` until a
session is `completed`) — a session abandoned after three of five still
reports three.

---

#### GET /practice/sessions/:id
Resume or review one session: every attempt recorded against it, and — while
it is still `in_progress` with attempts remaining — the next unanswered
question, prompt only. A `completed` or `abandoned` session returns
`nextQuestion: null`.

**Parameters:**
- `id` (uuid) — session id

**Response:**
```json
{
  "data": {
    "session": { "...": "same shape as POST /practice/sessions" },
    "nextQuestion": null,
    "progress": { "answered": 5, "planned": 5 },
    "attempts": [
      {
        "id": "uuid",
        "sessionId": "uuid",
        "questionId": "uuid",
        "question": {
          "id": "uuid",
          "number": 43,
          "prompt": "Who is the Speaker of the House of Representatives now?",
          "categoryId": "uuid",
          "dynamicScope": "national"
        },
        "source": "practice",
        "inputMode": "typed",
        "promptMode": "read",
        "responseText": "jane q doe",
        "outcome": "correct",
        "gradingMethod": "exact",
        "revealed": false,
        "hintUsed": false,
        "durationMs": 8400,
        "failureCause": null,
        "aiFeedback": null,
        "aiUsageEventId": null,
        "answeredAt": "2026-09-01T14:01:00.000Z",
        "answerSnapshot": {
          "resolvedAt": "2026-09-01T14:01:00.000Z",
          "answerResolution": "resolved",
          "resolvedForStateCode": null,
          "answers": [
            {
              "id": "uuid",
              "text": "Jane Q. Doe",
              "sort": 0,
              "stateCode": null,
              "verifiedAt": "2026-05-01T00:00:00.000Z"
            }
          ]
        }
      }
    ]
  }
}
```

Attempts are oldest first — the order they were answered in.

**The AI grading rung (issue #116, E4).** Three fields carry rung 2's
output — `failureCause`, `aiFeedback`, `aiUsageEventId` — and they are
**null together on every deterministically graded attempt**, which is the
normal case, not a degraded one: a match, a skip, and a miss whose grading
call was `unavailable` or `failed` all keep `gradingMethod: "exact"` with all
three null. `gradingMethod: "self"` never produces them either. Only
`gradingMethod: "ai"` populates them, and does so together — a row carrying
some of the three would be one whose `failureCause` cannot be traced to the
call that produced it. See [`docs/specs/ai-evaluation.md`](specs/ai-evaluation.md)
§6 for the ladder that decides when a grader is even called.

| Field | Type | Description |
|---|---|---|
| `failureCause` | string \| null | Why the response missed. One of `not_known`, `not_recalled`, `expression`, `misheard`, `nervous`, `unknown` — or `null`. `null` on a `correct` verdict (nothing failed, so nothing to explain) as well as on every non-AI-graded attempt. **`null` and `"unknown"` are different answers**: `null` means no grader ran; `"unknown"` means one ran and honestly could not classify the miss. `misheard` and `nervous` are declared in the enum but never produced by this ladder — they need E9's transcription confidence and E8's interview timing respectively; a model that names one is coerced to `"unknown"` before persistence. |
| `aiFeedback` | object \| null | The grader's full structured verdict, verbatim — `{"verdict": "correct" \| "partial" \| "incorrect", "failureCause": "…", "feedback": "…"}` — the same object validated against the grading schema, stored whole rather than as the `feedback` sentence alone. `null` on every non-AI-graded attempt. Never the prompt, never a raw model completion. |
| `aiUsageEventId` | uuid \| null | The `ai_usage_events` row this grading call wrote. `null` both when no grader ran and when the row write itself failed — the graded evidence is never held back for its own accounting. |

Example of an AI-graded attempt (`gradingMethod: "ai"`, `outcome: "correct"`
from rung 2 despite `matchAnswer` missing on rung 1):
```json
{
  "outcome": "correct",
  "gradingMethod": "ai",
  "failureCause": null,
  "aiFeedback": {
    "verdict": "correct",
    "failureCause": "unknown",
    "feedback": "Congress is accepted — nice work phrasing it your own way."
  },
  "aiUsageEventId": "uuid"
}
```

**`answerSnapshot` is frozen at grading time and never re-resolved.** It
holds exactly the accepted answers as `civics/answer-resolution.ts` returned
them the instant this attempt was graded — not a live join against
`civics_answers`. A `national`- or `state`-scope answer's text can change
later (an officeholder leaves office and the row is closed and replaced, per
[`docs/specs/civics-content.md`](specs/civics-content.md) §4); if this route
re-resolved answers at read time, a debrief opened a year later would show a
learner who answered correctly being told they were wrong, for a question
whose answer has simply since changed. `answerResolution: "state_required"`
with an empty `answers` array is the one other value it takes — a
`state`-scope question graded for a learner with no `stateCode` set at the
time, recorded `skipped`, never `incorrect`. Note what the snapshot does
**not** carry: which answer matched, or by which rule. Both are exactly
recoverable at any time by re-running the pure `matchAnswer`
(`docs/specs/practice-sessions.md` §7.1) over `responseText` and this frozen
`answers` list, so the response you see on the graded-attempt call below
(`matchedAnswerId`/`rule`, folded into `outcome`/`gradingMethod` on the
stored row) is never duplicated a second time inside the JSON document.

**Error Cases:**
- 404 Not Found — no such session for this caller (including a session that
  belongs to a different learner)

---

#### POST /practice/sessions/:id/attempts
Grades one response and writes one `practice_attempts` row — the evidence
every later epic (mastery, readiness, streaks) reads.

**Rung 1 is deterministic and has no AI in it.** The response is compared
against the question's currently accepted answers, first raw and
case-sensitive, then after a documented seven-step normalisation (case,
filler openings like "I think it's", possessives and punctuation, `U.S.` →
`United States`, leading articles, number words to digits — the full table
is `docs/specs/practice-sessions.md` §7). There is no fuzzy matching within
this rung: a near miss is `incorrect` here.

**Rung 2 (E4, epic #53) escalates a rung-1 miss to the `grader` AI role**,
on the caller's own key, asking whether the response *means* one of the
accepted answers even though it did not match one as a string — a
paraphrase or non-idiomatic phrasing the exact matcher cannot recognise.
The self-mark route below remains the learner's recourse for a rung-2 miss
too. See the response shape below for what a rung-2 verdict adds to the
row, and [`docs/specs/ai-evaluation.md`](specs/ai-evaluation.md) §6 for the
full ladder, including why an unavailable or failed grading call falls back
to rung 1's result rather than erroring the request.

**Parameters:**
- `id` (uuid) — session id

**Request Body:**
```json
{
  "questionId": "uuid",
  "responseText": "jane q doe",
  "skipped": false,
  "revealed": false,
  "hintUsed": false,
  "durationMs": 8400
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `questionId` | uuid | Yes | Must belong to this session's test version (and category, if it has one) — otherwise 400 |
| `responseText` | string (max 2000 chars) | No | The learner's raw, unmodified input. Rejected together with `skipped: true` — a skip carries no text |
| `skipped` | boolean | No (default `false`) | The learner moved on without answering. Recorded as `outcome: "skipped"`, `responseText: null` — a skip is real evidence, not a dropped request |
| `revealed` | boolean | No (default `false`) | The learner saw the accepted answer for this question. Changes no `outcome` by itself; it is the precondition for self-mark below |
| `hintUsed` | boolean | No (default `false`) | The learner opened a hint before submitting. Changes no `outcome` |
| `durationMs` | integer ≥ 0 | No | Milliseconds from question shown to submit. **Omit, never send `0`**, when the client cannot measure it — `0` would claim the learner answered instantly |

There is no `outcome`, `gradingMethod`, or any other verdict field in this
body — the client reports what happened, never the result. There is also no
`selfMarkCorrect` flag: self-mark is a distinct, later call against the
attempt this creates (below), never a value asserted in the same request
that creates it.

**Response:**
```json
{
  "data": {
    "attempt": { "...": "same shape as one attempts[] row above" },
    "acceptedAnswers": [
      { "id": "uuid", "text": "Jane Q. Doe", "sort": 0, "stateCode": null, "verifiedAt": "2026-05-01T00:00:00.000Z" }
    ],
    "nextQuestion": null,
    "progress": { "answered": 5, "planned": 5 }
  }
}
```

`acceptedAnswers` is shown here for the **first time** — this is the moment
it is earned, because the attempt is already recorded. It is the same list
frozen into `attempt.answerSnapshot.answers`, so the screen and the
permanent record cannot disagree. `nextQuestion` is prompt-only and `null`
once the planned count is reached.

**Error Cases:**
- 400 Bad Request — invalid body, or a question outside this session's test
  version or category
- 404 Not Found — no such session for this caller, or no such question
- 409 Conflict — the session is not `in_progress`, or this question was
  already answered in it (one attempt per question per session — answering
  it again means starting a new session)

---

#### POST /practice/sessions/:id/attempts/:attemptId/self-mark
"I was right — the matcher just didn't recognise it." Flips a recorded
`incorrect` or `skipped` attempt to `outcome: "correct"`, `gradingMethod:
"self"`.

**This is its own route, and its own `gradingMethod`, so the two stay
distinguishable forever.** Deterministic matching will never accept a real
paraphrase or an unanticipated synonym, so without this a learner who
genuinely knew the answer would simply be told they were wrong. But a
self-mark must never be indistinguishable from a verified match: it counts
as correct going forward, and `gradingMethod: "self"` is the fact a later
mastery computation reads to weigh it less than an `exact` or `ai` match.
That is precisely why it can never be a field on the attempts body above —
folding it into the same write would make "was it right" and "how do we
know" inseparable on the one row that has to carry both facts independently.

**Parameters:**
- `id` (uuid) — session id
- `attemptId` (uuid) — attempt id (resolved only within this caller's own
  session — an attempt id can never be probed on its own)

**Request Body:** none.

**Response:**
```json
{
  "data": {
    "id": "uuid",
    "sessionId": "uuid",
    "questionId": "uuid",
    "question": { "...": "prompt-only question shape" },
    "source": "practice",
    "inputMode": "typed",
    "promptMode": "read",
    "responseText": "the house",
    "outcome": "correct",
    "gradingMethod": "self",
    "revealed": true,
    "hintUsed": false,
    "durationMs": 12000,
    "failureCause": null,
    "aiFeedback": null,
    "aiUsageEventId": null,
    "answeredAt": "2026-09-01T14:02:00.000Z",
    "answerSnapshot": { "...": "unchanged from when the attempt was created" }
  }
}
```

**Reveal the accepted answer first — a 409 otherwise.** The claim being made
is "my answer matched the accepted one," which is only checkable against the
accepted one, not against the learner's memory of what they think it was.

**Idempotent**: a second call on an already self-marked attempt returns the
same state, unchanged.

**Error Cases:**
- 400 Bad Request — the attempt was already graded `correct` by `exact`
  matching — there is nothing to grant, and overwriting `exact` with `self`
  would downgrade a verified match to a learner's own claim
- 404 Not Found — no such session for this caller, or no such attempt in it
- 409 Conflict — the accepted answer has not been revealed yet

---

#### POST /practice/sessions/:id/complete
Sets `status: "completed"`, stamps `completedAt`, and persists a `summary`
computed entirely from the session's own `practice_attempts` rows — nothing
the client sends contributes to it.

**Parameters:**
- `id` (uuid) — session id

**Request Body:** none.

**Response:**
```json
{
  "data": {
    "id": "uuid",
    "kind": "quick",
    "status": "completed",
    "testVersionCode": "v2008",
    "categoryId": null,
    "plannedCount": 5,
    "startedAt": "2026-09-01T14:00:00.000Z",
    "completedAt": "2026-09-01T14:06:00.000Z",
    "summary": {
      "plannedCount": 5,
      "answered": 5,
      "correct": 4,
      "partial": 0,
      "incorrect": 1,
      "skipped": 0,
      "selfMarked": 1,
      "revealed": 1,
      "hintUsed": 0,
      "totalDurationMs": 42000,
      "timedAttempts": 5
    }
  }
}
```

`totalDurationMs` is `null` — never `0` — when no attempt reported a
duration; `timedAttempts` says how many attempts it covers, so a partial
total can never be read as a complete one.

**Idempotent**: completing an already-`completed` session returns the stored
summary unchanged and does not move `completedAt`. The moment a learner
finished stays the moment they finished.

**Error Cases:**
- 404 Not Found — no such session for this caller
- 409 Conflict — the session is `abandoned` (it was closed by a later
  session start and has no completion to record)

---

#### GET /practice/queue
Issue #78, epic #54 (E5 "Memory"). Counts for the Practice page's picker —
how many questions are due, struggling, new (by category), still in
progress, or mastered — for the caller's own resolved test version. A
**read-only counts endpoint**; it does not create a session.

Every count comes from `apps/api/src/practice/mastery/selector.ts`'s
`classifyMasteryBucket` — the same function `POST /practice/sessions` uses
to order a `quick` or `category` session's questions — so this endpoint can
never disagree with what starting a session right now would actually
select. Scoped identically to session creation: the caller's own test
version, and `seniorEligible` only under the 65/20 accommodation. Full
design: [`docs/specs/memory-model.md`](specs/memory-model.md) §5.

**Request Body:** none.

**Response:**
```json
{
  "data": {
    "testVersionCode": "v2025",
    "total": 128,
    "due": 4,
    "weak": 2,
    "new": {
      "total": 92,
      "byCategory": [
        { "categoryId": "uuid", "categoryName": "American Government", "newCount": 40 }
      ]
    },
    "learning": 26,
    "mastered": 4
  }
}
```

| Field | Description |
|-------|-------------|
| `total` | The whole bank's size for this test version, under the same `seniorEligible` scoping session creation uses |
| `due` | `state IN (review, lapsed)` with `dueAt` already passed |
| `weak` | A `lapsed` question (any `dueAt`), or a `learning`/`review` question with repeated lapses or a broken correct streak |
| `new.total` / `new.byCategory` | Never-attempted questions (or `state: 'new'`), broken down by category so the picker can show where coverage is thinnest |
| `learning` | Ordinary in-progress questions — attempted, not due, not struggling, not yet mastered (`mastery/selector.ts`'s internal `steady` bucket, under this endpoint's own `learning` field name) |
| `mastered` | Verified questions — the pool the selector samples from, least-recently-attempted first, once everything else is exhausted |

There is deliberately **no `kind: 'review' | 'weak' | 'mixed'` session** this
endpoint's counts feed into yet — those three `PracticeSessionKind` values
stay declared in the database enum and unwired in `POST /practice/sessions`
(see that route's own `kind` table above). A learner acts on these counts
today by starting an ordinary `quick` or `category` session, which the
mastery-aware ordering already serves due and weak content from first.

**Error Cases:**
- 400 Bad Request — the caller has not finished orientation, so no test
  version is resolved

---

### Interviews

Issue #133 (routes) / #145 (list), epic #57 (E8 "Mock interview — text
mode"). A scripted, deterministic rehearsal of the civics portion of the
naturalization interview: the engine decides the phase, the question, the
grade and the stop; the `tutor` role only supplies the officer's wording.
Design rationale — the phase sequence, the seeded question selection, the
pass rule, the engine/model boundary and its failure mode, the PII
stance — lives in
[`docs/specs/mock-interview.md`](specs/mock-interview.md); this section
covers only the wire contract.

**Every route below is `@Auth()` with no permissions, and no new permission
string is added**, for the identical reason the Journey, Practice,
Progress, Readiness and Engagement sections above all give in turn: no
route accepts a user id from anywhere but the authenticated session, so
there is no "read another learner's interview" permission to add in the
first place. Every authenticated learner owns their own interview history
exactly as they own their own practice attempts, their own learner profile,
and their own readiness snapshots.

**An interview belonging to another learner is a 404, not a 403.**
Confirming that an id names a real interview would itself be the leak —
from the caller's position, another learner's interview genuinely does not
exist.

**Test version and the senior accommodation are resolved from the caller's
own `learner_profiles` row, never from the request.** There is no
`testVersionCode` and no `seniorExemption` field on `POST /interviews`; both
are read from the profile and then frozen onto the interview row, so
editing the profile mid-interview cannot change the rule the interview is
graded against.

**`transcriptRetained` defaults to `false`.** It is a per-interview choice
made once, at creation, never a standing setting. With it off, the
interview still records everything that *happened* — every turn, in order,
in its phase, naming the question asked, plus every outcome, grading method
and frozen answer snapshot — and does not record what the learner *said*:
applicant turn text is stored empty, `responseText` is `null`, and the AI
grader's written feedback is omitted entirely. The learner is still graded
on their real words in memory; only the record of them is withheld. See
`docs/specs/mock-interview.md` §8 for the full retention design, and
[`docs/SECURITY-ARCHITECTURE.md`](SECURITY-ARCHITECTURE.md) for the
retention table restated as a security posture.

**No turn response, and no field on the resume payload, carries a verdict,
a score, or a hint before the interview is completed.** The engine knows
whether an answer was correct the instant it grades it and uses that to
choose the next question and to run the early stop, entirely server-side;
`POST /interviews/{id}/complete` is the first moment any of it is visible to
the learner.

**`POST /interviews/{id}/complete` is idempotent.** Completing an
already-completed interview returns the identical stored debrief and
recomputes nothing — a double-tap never writes a second readiness snapshot
for one interview.

#### POST /interviews
Opens a new interview and returns it together with the officer's opening
turn (the `smalltalk` phase's greeting and non-scored opener).

**Request Body:**
```json
{ "transcriptRetained": false }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `transcriptRetained` | boolean | No (default `false`) | Whether this interview keeps the learner's own words. See the retention note above. |

**Response:**
```json
{
  "data": {
    "interview": {
      "id": "uuid",
      "mode": "text",
      "status": "in_progress",
      "testVersionCode": "v2025",
      "seniorExemption": false,
      "transcriptRetained": false,
      "startedAt": "2026-09-02T14:00:00.000Z",
      "completedAt": null,
      "civicsAsked": 0,
      "civicsCorrect": 0,
      "passedCivics": false
    },
    "officerTurns": [
      {
        "id": "uuid",
        "turnIndex": 0,
        "role": "officer",
        "phase": "smalltalk",
        "questionId": null,
        "text": "Good morning. Thank you for coming in today.\n\nHow are you doing today?",
        "createdAt": "2026-09-02T14:00:00.000Z"
      }
    ],
    "progress": { "civicsAsked": 0, "civicsPlanned": 10 },
    "awaitingCompletion": false
  }
}
```

**Error Cases:**
- 400 Bad Request — invalid body, or the caller has not finished
  orientation so no test version is resolved

---

#### POST /interviews/:id/turns
Submits the applicant's reply to the most recent officer turn and streams
the officer's response. Modelled directly on `POST
/civics/questions/{id}/explain` above — same hand-written SSE transport,
same reasoning, extended with a turn outcome on every terminal frame.

**The interview decides; the model only speaks.** Which question comes
next, whether the answer was right, when the civics section stops and
whether the learner passed are all computed server-side, and committed,
before this stream opens. The model supplies one short acknowledgement
sentence; the civics question itself, when the new turn is a civics
question, is appended to that sentence **verbatim from the database** — it
never passes through the model, so it cannot be paraphrased, translated,
simplified, or invented.

**Transport.** `200 text/event-stream`, hand-written rather than Nest's
`@Sse()` (which hard-codes GET, and this route takes a body). The native
`EventSource` cannot send an `Authorization` header and only ever issues a
GET, so a client must use a fetch-based SSE reader, exactly as the explain
endpoint requires. A `?token=` query parameter is deliberately unsupported —
a bearer token in a URL lands in access logs, browser history and
`Referer`. Disconnecting aborts the upstream call — inference runs on the
learner's own key — but the turn is still persisted, so reconnecting shows
a complete transcript rather than one missing the officer's last line.

**Parameters:**
- `id` (uuid) — interview id

**Request Body:**
```json
{ "text": "I would say Congress." }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `text` | string, max 2000 chars | Yes | What the applicant said, verbatim. May be empty after trimming — an applicant who says nothing has still taken their turn. |

There is no `questionId`, no `phase`, no `skipped`, no `revealed`, and no
`hintUsed`: which question this answers is the interview's own state, and
none of the practice screen's affordances exists inside a rehearsal.

**Response.** An open `text/event-stream`. An opening `: connected` comment
flushes the headers immediately, then any number of `delta` frames, then
**exactly one terminal frame, always last**.

| Frame (`event:`) | `data` | Terminal? | Meaning |
|---|---|---|---|
| `delta` | `{"text": "…"}` | No | One chunk of the officer's acknowledgement. Never empty. |
| `done` | `InterviewTurnOutcome` (below) | Yes | The officer's turn is whole. |
| `unavailable` | `InterviewTurnOutcome & {"cause": "no_user_key" \| "ai_disabled" \| "role_unbound" \| "capability_unsupported"}` | Yes | No call was attempted — the caller has no stored key, or an administrator has not finished configuring AI. **The interview continues unchanged** — same phase, same next question, same grading — with the officer using a neutral, code-owned line. Render the turn; do not render an error. |
| `error` | `InterviewTurnOutcome & {"errorCode": "…", "error": "…"}` | Yes | The call was attempted and did not produce a usable acknowledgement. The interview still advanced, identically to `unavailable`. |

**`InterviewTurnOutcome` — carried by all three terminal frames alike, not
only `done`.** The interview advances in every case, so a client applies
this outcome from whichever terminal frame it actually receives:

```json
{
  "officerTurns": [ { "...": "one or more interviewTurnRecord entries, in order" } ],
  "phase": "civics",
  "turnIndex": 5,
  "progress": { "civicsAsked": 2, "civicsPlanned": 10 },
  "awaitingCompletion": false
}
```

`officerTurns` is an array because one exchange can produce several: the
reading and writing phases each consume no applicant answer (one honest
"we don't cover that yet" line and the phase is over), and neither does the
closing statement, so the last civics answer of an interview is followed by
three officer turns at once. `awaitingCompletion: true` means the only
remaining action is `complete`.

Example stream:
```
: connected

event: delta
data: {"text":"Thank you. "}

event: delta
data: {"text":"Let's continue."}

event: done
data: {"officerTurns":[{"id":"uuid","turnIndex":5,"role":"officer","phase":"civics","questionId":"uuid","text":"Thank you. Let's continue.\n\nName one branch of government.","createdAt":"2026-09-02T14:03:00.000Z"}],"phase":"civics","turnIndex":5,"progress":{"civicsAsked":2,"civicsPlanned":10},"awaitingCompletion":false}

```

**Cost.** Disconnecting aborts the upstream request, exactly as the explain
endpoint's does. The turn is still recorded.

**Error Cases:**
- 404 Not Found — unknown interview id, or the interview belongs to another
  learner (resolved, and thrown, before the stream opens — never a stream
  that opens and immediately breaks)
- 409 Conflict — the interview is completed or abandoned, or has no turn
  left to take

---

#### POST /interviews/:id/complete
Closes the interview, computes its debrief, and triggers a readiness
recompute — the first moment any performance information exists where the
learner can see it.

**Parameters:**
- `id` (uuid) — interview id

**Request Body:** none.

**Response:**
```json
{
  "data": {
    "civics": {
      "planned": 10,
      "asked": 6,
      "correct": 6,
      "threshold": 6,
      "passed": true,
      "stoppedEarly": true,
      "stopReason": "threshold_reached"
    },
    "questions": [
      {
        "questionId": "uuid",
        "number": 43,
        "prompt": "Who is the Speaker of the House of Representatives now?",
        "categoryName": "American Government",
        "outcome": "correct",
        "acceptedAnswers": ["Nancy Pelosi"]
      }
    ],
    "phases": [
      { "kind": "smalltalk", "status": "completed" },
      { "kind": "n400", "status": "completed" },
      { "kind": "civics", "status": "completed" },
      { "kind": "reading", "status": "skipped" },
      { "kind": "writing", "status": "skipped" },
      { "kind": "closing", "status": "completed" }
    ],
    "focusAreas": [],
    "readiness": {
      "score": 68,
      "previousScore": 61,
      "delta": 7,
      "capReason": null,
      "capMessage": null,
      "interviewComponent": { "value": 0.5, "evidenceCount": 1 }
    }
  }
}
```

`planned` and `threshold` are echoed from the `civics_test_versions` row
this interview was created against — never hardcoded on the client. `asked`
is smaller than `planned` whenever the early stop fired; `stopReason` says
which of `threshold_reached` / `threshold_unreachable` / `all_asked` ended
the civics section. `reading`/`writing` are reported `skipped`, honestly,
rather than omitted. `acceptedAnswers` comes from each attempt's frozen
`answerSnapshot`, never a live re-query, and survives with retention off —
what retention withholds is the learner's own words, not the evidence of
what happened.

**Error Cases:**
- 404 Not Found — unknown interview id, or it belongs to another learner
- 409 Conflict — the interview is abandoned and cannot be completed

---

#### GET /interviews
The caller's own interviews, newest first, paginated. Added for issue #145
so a learner can answer "did I do better on my second mock interview than
my first" — a debrief that existed only as a one-time response to
`complete` could not answer that.

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `page` | number | 1 | Page number |
| `pageSize` | number | 20 (max 100) | Items per page |

There are deliberately no filters — `?status=`, `?passedCivics=`, `?userId=`
included — a 400 naming the parameter.

**Response:**
```json
{
  "data": [
    { "...": "the same interview shape POST /interviews returns" }
  ],
  "meta": { "total": 3, "page": 1, "pageSize": 20 }
}
```

---

#### GET /interviews/:id
Resume an in-progress interview, or re-read a completed one — the same
"one route serves both live and historical state" shape `GET
/practice/sessions/{id}` above already takes.

**Parameters:**
- `id` (uuid) — interview id

**Response:**
```json
{
  "data": {
    "interview": { "...": "same shape as POST /interviews" },
    "turns": [ { "...": "the whole transcript so far, oldest first" } ],
    "progress": { "civicsAsked": 6, "civicsPlanned": 10 },
    "awaitingCompletion": true,
    "debrief": null
  }
}
```

`debrief` is `null` while the interview is in progress and is populated
with the exact shape `POST /interviews/{id}/complete` returned, once
`status` is `completed` — read back from the stored row, never recomputed.
An applicant turn with empty `text` on an interview whose
`transcriptRetained` is `false` means the words were never kept, **not**
that the learner said nothing; the interview's own `transcriptRetained`
flag on the header is what tells the two apart.

**Error Cases:**
- 404 Not Found — unknown interview id, or it belongs to another learner

---

### Progress

Issue #86, epic #54 (E5 "Memory"). Coverage and mastery, by category, for
the Progress page. Design rationale lives in
[`docs/specs/memory-model.md`](specs/memory-model.md) §8; this section
covers only the wire contract.

**`@Auth()` with no permissions**, caller-scoped exactly like every other
per-user route in this product: the learner is resolved from
`@CurrentUser('id')`, never from a path, query, or body parameter — every
authenticated user owns their own mastery data, so gating this route would
leave the default Viewer role unable to see their own progress.

#### GET /progress/mastery
The caller's own coverage and mastery, by `question_mastery.state`, for
their resolved test version — a different question from `GET
/practice/queue` above (that endpoint answers "what should a session started
right now select"; this one answers "how much of the bank have I covered,
and how well"). This is a read aggregate with no scheduling side effect of
its own — it never calls the scheduler and never writes.

**Request Body:** none.

**Response:**
```json
{
  "data": {
    "testVersionCode": "v2025",
    "totalQuestions": 128,
    "attempted": 64,
    "byState": { "new": 64, "learning": 20, "review": 30, "lapsed": 4, "mastered": 10 },
    "categories": [
      {
        "categoryId": "uuid",
        "categoryName": "American Government",
        "totalQuestions": 57,
        "byState": { "new": 20, "learning": 10, "review": 15, "lapsed": 2, "mastered": 10 },
        "masteredCount": 10
      }
    ]
  }
}
```

| Field | Description |
|-------|-------------|
| `totalQuestions` | The whole bank's size for this test version — **not** scoped by `seniorEligible`, unlike `GET /practice/queue`'s `total`: this is coverage of the full official bank, not of a session's own candidate pool |
| `attempted` | `totalQuestions - byState.new` |
| `byState` | Every question in the bank, grouped by the caller's own `question_mastery.state`; a question with no row counts as `new` |
| `categories[].masteredCount` | Convenience duplicate of that category's own `byState.mastered` — the number the Progress page's per-category ring reads directly |

**Error Cases:**
- 400 Bad Request — the caller has not finished orientation, so no test
  version is resolved

---

### Readiness

Issue #122/#127/#134, epic #55 (E6 "Readiness and Progress"). The
eight-component weighted readiness score, snapshotted (not recomputed on
every read) so the trend line means what it said on the day it was
computed. Design rationale lives in
[`docs/specs/readiness-model.md`](specs/readiness-model.md); this section
covers only the wire contract.

**`@Auth()` with no permissions**, caller-scoped exactly like every other
per-user route in this product: the learner is resolved from
`@CurrentUser('id')`, never from a path, query, or body parameter — every
authenticated user owns their own readiness data.

#### GET /readiness
The caller's most recent `readiness_snapshots` row. Lazily computed and
persisted if none exists yet, or if the latest one is **stale**: an
existing snapshot older than the caller's most recent
`practice_attempts.answeredAt`. A snapshot the nightly cron just produced is
never stale by this rule — the cron already reflects every attempt that
existed when it ran.

`score` is 0-100. `capReason` becomes `"typed_only"` when there is no
spoken-answer evidence and no mock-interview evidence, and `null` the
instant either kind of evidence exists at all, even once — a distinct,
binary signal from `score` itself, which keeps climbing gradually as more
evidence arrives. `spoken` and `interview` (0.10 each) are the two
components `capReason` reads, and both are `0` for a `"typed_only"`
learner, so their score can never exceed `0.80`. `english` (0.05) is *not*
one of the two — a learner can earn full `english` credit (reading and
writing practice) without ever having spoken a civics answer or sat a mock
interview, so a `"typed_only"` learner's score can still reach `0.80` with
full `english` credit, or `0.75` with none at all; see
[`docs/specs/readiness-model.md`](specs/readiness-model.md) §2.9 for why
`english` deliberately does not lift `capReason` itself.

`topRecommendation` is always present: the fixed cap message while capped,
otherwise the earnable component (`coverage`, `recall`, `retention`,
`consistency`, `remediation`, or `english`) with the greatest weighted
headroom.

`narrative`/`narrativeGeneratedAt` are the Progress Guide's one
AI-generated paragraph (issue #134), filled in lazily on the caller's own
AI key. Both stay `null` — absent without complaint, never blocking this
response — whenever AI is not configured for this deployment or this
caller has no key of their own; a later request for the same (still
current) snapshot fills them in once it can.

**Request Body:** none.

**Response:**
```json
{
  "data": {
    "id": "b3f1c2a0-9e4a-4f3b-8c2d-1a2b3c4d5e6f",
    "computedAt": "2026-09-01T03:00:00.000Z",
    "score": 53,
    "stage": "practicing",
    "components": {
      "coverage": { "value": 0.72, "weight": 0.15, "contribution": 0.108 },
      "recall": { "value": 0.75, "weight": 0.2, "contribution": 0.15 },
      "retention": { "value": 0.65, "weight": 0.2, "contribution": 0.13 },
      "consistency": { "value": 0.8571, "weight": 0.1, "contribution": 0.0857 },
      "remediation": { "value": 0.6, "weight": 0.1, "contribution": 0.06 },
      "english": { "value": 0, "weight": 0.05, "contribution": 0 },
      "spoken": { "value": 0, "weight": 0.1, "contribution": 0 },
      "interview": { "value": 0, "weight": 0.1, "contribution": 0 }
    },
    "evidenceCounts": {
      "coverage": { "distinctQuestionsAttempted": 72, "totalQuestionsInVersion": 100 },
      "recall": { "qualifyingAttempts": 20, "correctCount": 14, "partialCount": 2, "incorrectCount": 3, "skippedCount": 1 },
      "retention": { "masteredCount": 36, "reviewCount": 18, "totalAttemptedQuestions": 72 },
      "consistency": { "distinctPracticeDaysInLast14": 6 },
      "remediation": { "everWeakCount": 5, "remediatedCount": 3 },
      "english": { "readingSentences": 0, "writingSentences": 0, "readingCredit": 0, "writingCredit": 0 },
      "spoken": { "attempts": 0 },
      "interview": { "attempts": 0 }
    },
    "capReason": "typed_only",
    "topRecommendation": {
      "componentKey": null,
      "title": "Limited interview practice",
      "reason": "Your civics knowledge is strong, but you have limited interview practice. Completing two mock interviews is the best way to strengthen your readiness now.",
      "path": "/practice"
    },
    "narrative": null,
    "narrativeGeneratedAt": null
  }
}
```

| Field | Description |
|-------|-------------|
| `score` | `round(sum(components[*].contribution) * 100)` — the components above sum to `0.5337`, so `score` is `53` |
| `capReason` | `"typed_only"` (no spoken or mock-interview evidence yet) or `null`. Not a synonym for "components incomplete" — a learner can have `capReason: null` (one passed mock interview) while `score` still sits well under 75 |
| `components[*].value` | Normalized `[0, 1]` |
| `components[*].contribution` | `value * weight` — what this component actually added to the score |
| `topRecommendation.componentKey` | `null` only for the fixed cap message; otherwise the name of the earnable component being recommended |

**Error Cases:** none beyond standard auth (401).

---

#### GET /readiness/history
The caller's own past snapshots, **newest first**, paginated with the same
`page`/`pageSize` shape every other list in this API uses.

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `page` | number | 1 | Page number |
| `pageSize` | number | 20 (max 100) | Items per page |

There are deliberately no filters — `?userId=` included — a 400 naming the
parameter.

Every field on a history row is exactly what `GET /readiness` returns for
the latest snapshot, frozen as it stood the day it was computed — a
`question_mastery` row this snapshot summarized can be rescheduled or
re-promoted since, and this row still means exactly what it meant on the
day it was written.

**Response:**
```json
{
  "data": [
    {
      "id": "b3f1c2a0-9e4a-4f3b-8c2d-1a2b3c4d5e6f",
      "computedAt": "2026-09-01T03:00:00.000Z",
      "score": 53,
      "stage": "practicing",
      "components": { "...": "same shape as GET /readiness" },
      "evidenceCounts": { "...": "same shape as GET /readiness" },
      "capReason": "typed_only",
      "topRecommendation": { "componentKey": null, "title": "Limited interview practice", "reason": "...", "path": "/practice" },
      "narrative": null,
      "narrativeGeneratedAt": null
    }
  ],
  "meta": { "total": 9, "page": 1, "pageSize": 20 }
}
```

**Error Cases:**
- 400 Bad Request — an unknown query parameter was supplied

---

### Engagement

Issue #119/#153, epic #56 (E7 "Habit"). The caller's daily goal, streak and
freeze budget — what the goal ring, the streak badge and the session-end
celebration render. Design rationale, including the settlement algorithm and
the three reminder events, lives in
[`docs/specs/habit-streaks.md`](specs/habit-streaks.md); this section covers
only the wire contract.

**`@Auth()` with no permissions**, caller-scoped exactly like every other
per-user route in this product: the learner is resolved from
`@CurrentUser('id')`, never from a path, query, or body parameter — every
authenticated user owns their own engagement data, so gating this route
would leave the default Viewer role unable to see their own streak.

#### GET /engagement/summary
The caller's own daily goal, today's counters, current/longest streak, and
remaining freeze budget, **after this request's own settlement pass**: the
freeze budget is replenished at most once per 7 days up to a ceiling of 2,
and a missed day inside an existing streak is covered by writing a real
`daily_activity` row with `freezeUsed: true`, bounded to 7 days back. A read
path that persists what it computes, exactly as `GET /api/readiness`
already does.

This is a **consistency** surface, not a readiness one — `daily_activity`,
streaks and freezes are structurally not inputs to the readiness engine (see
[`docs/ARCHITECTURE.md`](ARCHITECTURE.md#56-engagement-model)), and nothing
in this response carries a score.

`today` is always present, including for a learner with no `daily_activity`
row yet, with honest zeros and `goalMet: false`. `goalMet` is
**monotonic** — a day that was earned stays earned, including after the
learner raises their daily goal.

`streak.current` counts consecutive qualifying local days ending **today or
yesterday**, so a learner who always practises in the evening is never shown
`0` at 2pm on a day they fully intend to finish. A day qualifies when the
goal was met **or** a freeze covered it. `streak.longest` is the longest
such run anywhere in their history.

Every `date` in this response is a LOCAL calendar day in the caller's own
`timezone`, never an instant.

**Request Body:** none.

**Response:**
```json
{
  "data": {
    "dailyGoalMinutes": 5,
    "today": {
      "date": "2026-09-03",
      "practiceSeconds": 180,
      "attempts": 6,
      "correct": 5,
      "goalMet": true
    },
    "streak": {
      "current": 4,
      "longest": 11
    },
    "freezes": {
      "remaining": 2,
      "max": 2
    },
    "timezone": "America/Los_Angeles",
    "recentDays": [
      { "...": "11 earlier days, oldest first" },
      {
        "date": "2026-09-01",
        "goalMet": false,
        "freezeUsed": true,
        "practiceSeconds": 0
      },
      {
        "date": "2026-09-02",
        "goalMet": true,
        "freezeUsed": false,
        "practiceSeconds": 210
      },
      {
        "date": "2026-09-03",
        "goalMet": true,
        "freezeUsed": false,
        "practiceSeconds": 180
      }
    ]
  }
}
```

| Field | Description |
|-------|-------------|
| `dailyGoalMinutes` | The learner's own `learner_profiles.daily_goal_minutes` — what the ring is measured against |
| `freezes.remaining` | Held after this request's settlement — presented as protection the learner already has, never a scarcity counter |
| `freezes.max` | The ceiling (`STREAK_FREEZE_MAX`, `apps/api/src/engagement/streaks/freeze-settlement.ts`), so a client never hardcodes it |
| `recentDays` | The last 14 local days, **oldest first**, one entry per day whether or not a row exists — a day with no row reports zeros, which is what actually happened on it |
| `recentDays[].freezeUsed` | True only for a day settlement covered with a freeze — a recorded freeze, never a fabricated practice day |

**Error Cases:** none beyond standard auth (401).

---

### Storage Objects

The storage system provides file upload and management capabilities with support for large files (GB scale) through resumable multipart uploads.

#### Initialize Resumable Upload

`POST /api/storage/objects/upload/init`

**Requires Authentication** - Initialize a multipart upload for large files. Returns presigned URLs for direct-to-S3 uploads.

**Request Body:**
```json
{
  "name": "document.pdf",
  "size": 104857600,
  "mimeType": "application/pdf"
}
```

**Response:**
```json
{
  "data": {
    "objectId": "uuid",
    "uploadId": "s3-upload-id",
    "partSize": 10485760,
    "totalParts": 10,
    "presignedUrls": [
      { "partNumber": 1, "url": "https://..." },
      { "partNumber": 2, "url": "https://..." }
    ]
  }
}
```

---

#### Get Upload Status

`GET /api/storage/objects/:id/upload/status`

**Requires Authentication** - Check progress of an in-progress upload.

**Response:**
```json
{
  "data": {
    "status": "uploading",
    "uploadedParts": 5,
    "totalParts": 10,
    "progress": 50
  }
}
```

---

#### Complete Upload

`POST /api/storage/objects/:id/upload/complete`

**Requires Authentication** - Finalize multipart upload after all parts are uploaded.

**Request Body:**
```json
{
  "parts": [
    { "partNumber": 1, "eTag": "\"etag1\"" },
    { "partNumber": 2, "eTag": "\"etag2\"" }
  ]
}
```

**Response:**
```json
{
  "data": {
    "id": "uuid",
    "name": "document.pdf",
    "size": 104857600,
    "mimeType": "application/pdf",
    "status": "processing"
  }
}
```

---

#### Abort Upload

`DELETE /api/storage/objects/:id/upload/abort`

**Requires Authentication** - Cancel an in-progress upload and clean up resources.

**Response:** HTTP 204 No Content

---

#### Simple Upload

`POST /api/storage/objects`

**Requires Authentication** - Direct upload for small files (< 100MB) using multipart/form-data.

**Request:**
- Content-Type: `multipart/form-data`
- Body: File attached as form data with key `file`

**Response:**
```json
{
  "data": {
    "id": "uuid",
    "name": "document.pdf",
    "size": 1048576,
    "mimeType": "application/pdf",
    "status": "uploading"
  }
}
```

---

#### List Objects

`GET /api/storage/objects`

**Requires Authentication** - List storage objects with pagination and filtering.

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `page` | number | 1 | Page number |
| `pageSize` | number | 20 | Items per page (max 100) |
| `status` | enum | - | Filter by status: `pending`, `uploading`, `processing`, `ready`, `failed` |
| `sortBy` | enum | `createdAt` | Sort field: `createdAt`, `name`, `size` |
| `sortOrder` | enum | `desc` | Sort order: `asc`, `desc` |

**Response:**
```json
{
  "data": [
    {
      "id": "uuid",
      "name": "document.pdf",
      "size": 104857600,
      "mimeType": "application/pdf",
      "status": "ready",
      "createdAt": "2024-01-01T00:00:00.000Z"
    }
  ],
  "meta": {
    "total": 50,
    "page": 1,
    "pageSize": 20,
    "totalPages": 3
  }
}
```

---

#### Get Object

`GET /api/storage/objects/:id`

**Requires Authentication** - Get storage object metadata.

**Response:**
```json
{
  "data": {
    "id": "uuid",
    "name": "document.pdf",
    "size": 104857600,
    "mimeType": "application/pdf",
    "status": "ready",
    "metadata": {
      "customField": "value"
    },
    "createdAt": "2024-01-01T00:00:00.000Z",
    "updatedAt": "2024-01-01T00:00:00.000Z"
  }
}
```

---

#### Get Download URL

`GET /api/storage/objects/:id/download`

**Requires Authentication** - Get a signed download URL for the object.

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `expiresIn` | number | 3600 | URL expiration in seconds |

**Response:**
```json
{
  "data": {
    "url": "https://s3.amazonaws.com/...",
    "expiresAt": "2024-01-01T01:00:00.000Z"
  }
}
```

---

#### Delete Object

`DELETE /api/storage/objects/:id`

**Requires Authentication** - Delete a storage object and its associated file.

**Response:** HTTP 204 No Content

**Error Cases:**
- 404 Not Found - Object not found
- 403 Forbidden - User does not own the object. This check applies to every
  user, including Admin — there is no admin override (see
  [SECURITY-ARCHITECTURE.md](SECURITY-ARCHITECTURE.md#access-control)).

---

#### Update Metadata

`PATCH /api/storage/objects/:id/metadata`

**Requires Authentication** - Update custom metadata for an object.

**Request Body:**
```json
{
  "metadata": {
    "customField": "value",
    "tags": ["document", "important"]
  }
}
```

**Response:**
```json
{
  "data": {
    "id": "uuid",
    "name": "document.pdf",
    "metadata": {
      "customField": "value",
      "tags": ["document", "important"]
    },
    "updatedAt": "2024-01-01T12:00:00.000Z"
  }
}
```

---

### Health

**Public endpoints** - Used for Kubernetes liveness/readiness probes.

#### GET /health
Full health check - includes database connectivity test. Equivalent to GET /health/ready.

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "checks": {
    "database": "ok"
  }
}
```

**Error Cases:**
- 503 Service Unavailable - Database connection failed

---

#### GET /health/live
Liveness check - always returns 200 if service is running.

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

---

#### GET /health/ready
Readiness check - includes database connectivity test.

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "checks": {
    "database": "ok"
  }
}
```

**Error Cases:**
- 503 Service Unavailable - Database connection failed

---

## HTTP Status Codes

| Code | Description |
|------|-------------|
| 200 | OK - Request successful |
| 201 | Created - Resource created successfully |
| 204 | No Content - Request successful, no response body |
| 400 | Bad Request - Invalid request format or validation error |
| 401 | Unauthorized - Missing or invalid authentication token |
| 403 | Forbidden - Insufficient permissions or user disabled |
| 404 | Not Found - Resource not found |
| 409 | Conflict - Resource already exists or version mismatch (optimistic concurrency) |
| 500 | Internal Server Error - Server error occurred |
| 503 | Service Unavailable - Service temporarily unavailable |

---

## Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `AUTH_REQUIRED` | 401 | No valid authentication token provided |
| `INVALID_TOKEN` | 401 | JWT token is invalid or expired |
| `FORBIDDEN` | 403 | User does not have required permissions |
| `USER_DISABLED` | 403 | User account is disabled |
| `NOT_FOUND` | 404 | Requested resource not found |
| `VALIDATION_ERROR` | 400 | Request validation failed |
| `CONFLICT` | 409 | Resource already exists or version mismatch |
| `NOT_AUTHORIZED` | 403 | Email not in allowlist |
| `VERSION_MISMATCH` | 409 | Optimistic concurrency conflict (If-Match header) |

---

## Rate Limits

> **Note:** Rate limiting is recommended for production deployments but is not currently implemented in the application. Consider adding `@nestjs/throttler` or Nginx rate limiting before production deployment.

**Recommended limits:**

| Endpoint Pattern | Recommended Limit | Window |
|------------------|-------------------|--------|
| `/api/auth/*` | 10 requests | 1 minute |
| `/api/allowlist` (POST) | 30 requests | 1 minute |
| `/api/system-settings` (PUT/PATCH) | 30 requests | 1 minute |
| All other endpoints | 100 requests | 1 minute |

---

## OpenAPI Documentation

Interactive API documentation with request/response examples is available at:

**Development:** http://localhost:3535/api/docs

This serves a [Scalar](https://scalar.com) reference page (not Swagger UI) generated from the
OpenAPI 3.1 document at `/api/openapi.json`. It allows you to:
- Explore all endpoints, grouped into sections via `x-tagGroups`
- View request/response schemas, including the generated **Requires:** RBAC line per operation
- Test API calls directly from the browser
- Authenticate with one click via "Authorize with my session" (exchanges your existing browser
  session for an access token), a personal access token, or a device authorization grant

See [`docs/specs/api-documentation.md`](specs/api-documentation.md) for how the document is built.

---

## CORS Policy

The API uses a **same-origin architecture**. Both the frontend and API are served from the same host (via Nginx reverse proxy):

- Frontend: `http://localhost:3535/`
- API: `http://localhost:3535/api`

This eliminates CORS complexity and improves security. No cross-origin requests are required.

---

## Security Headers

All API responses include security headers:

```
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
X-XSS-Protection: 1; mode=block
Strict-Transport-Security: max-age=31536000; includeSubDomains
```

---

## Versioning

The API currently does not use versioning (v1, v2, etc.). Breaking changes will be avoided when possible. When breaking changes are necessary, they will be:

1. Announced in advance
2. Documented in migration guides
3. Implemented with a transition period when feasible

For future versions, the API may adopt URL-based versioning: `/api/v2/...`
