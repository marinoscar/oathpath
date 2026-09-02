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
| `systemReady` | Provider configured, wired roles bound, master switch on. `false` does **not** block you |
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
      "reason": "Start with the material, then build up to full practice.",
      "path": "/learn"
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

`nextAction.kind` is one of exactly three values in this release —
`orientation`, `interview_countdown`, `explore` — and each maps to one fixed,
non-redirecting route. A later epic adding practice, review, or the
interview stage widens this set; nothing else does.

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
