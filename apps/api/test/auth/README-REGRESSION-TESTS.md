# OAuth Regression Tests

## Overview

The regression coverage described below lives in `oauth.integration.spec.ts` and is designed to catch regressions related to the Google OAuth flow with NestJS + Fastify. Like every suite in `apps/api/test/`, it runs against a real `AppModule` over Supertest with Prisma fully mocked — it never opens a database connection.

## Issues These Tests Would Have Caught

### 1. HttpExceptionFilter Fastify Compatibility

**Issue Fixed**: The `HttpExceptionFilter` was using Express-style `response.status().json()` instead of Fastify's `response.code().send()`

**Tests That Catch This**:
- `should use Fastify response methods (code/send) not Express (status/json)`
  - Triggers an error by authenticating a deactivated user
  - If the filter uses wrong response methods, the test would fail with runtime errors

- `should return proper JSON error format for API errors`
  - Calls authenticated endpoint without token
  - Verifies the error response structure is correct
  - Would fail if Fastify response methods throw errors

- `should handle validation errors with Fastify response`
  - Tests refresh endpoint without token
  - Ensures validation errors are properly formatted

**How It Catches The Bug**: If the filter uses `response.status()`, Fastify throws an error because that method doesn't exist on Fastify's reply object. The test would fail with "response.status is not a function" or similar.

### 2. GoogleOAuthGuard Passport Compatibility

**Issue Fixed**: The `GoogleOAuthGuard` needed to return raw Node.js http objects (IncomingMessage/ServerResponse) for Passport compatibility with Fastify, and copy the user back to the Fastify request.

**Tests That Catch This**:
- `should successfully authenticate with raw request/response objects`
  - Performs full OAuth callback
  - Would fail if Passport can't work with the request/response objects
  - Verifies user creation succeeded (proves authentication worked)

- `should copy user to Fastify request after authentication`
  - Tests that controller can access `req.user`
  - Would redirect with `authentication_failed` error if user isn't copied
  - Expects successful token generation

- `should handle authentication errors gracefully`
  - Sets null profile to simulate failure
  - Ensures error handling works correctly

**How It Catches The Bug**: Without returning raw objects, Passport would fail to authenticate. Without copying user to Fastify request, the controller couldn't access `req.user` and would return authentication errors.

### 3. Admin Bootstrap Transaction Integrity

**Issue Fixed**: `AuthService.createNewUser` was calling admin bootstrap outside the transaction, causing FK violations.

**Tests That Catch This**:
- `should create admin user with role in single transaction`
  - Creates first admin user via OAuth
  - Verifies user, identity, settings, and admin role all exist
  - Validates all foreign keys are correct
  - Would fail with FK violation if operations aren't in transaction

- `should rollback all changes if admin role assignment fails`
  - Deletes admin role to force error
  - Verifies NO user was created (transaction rollback)
  - Would leave orphaned records if not using transaction

- `should create regular user with default role in transaction`
  - Creates non-admin user
  - Verifies all related records created atomically
  - Would fail with FK errors if not transactional

**How It Catches The Bug**: If admin role assignment happens outside the transaction, you'd get FK constraint violations when trying to assign a role to a user that doesn't exist yet (or hasn't been committed). The rollback test specifically catches partial creation issues.

### 4. Error Message URL Sanitization

**Issue Fixed**: Error redirect URLs contained newlines causing "Invalid character in header" errors.

**Tests That Catch This**:
- `should sanitize error messages with newlines for URL redirect`
  - Triggers error via deactivated user
  - Verifies redirect URL has no newlines
  - Would fail with ERR_INVALID_CHAR if newlines present

- `should truncate very long error messages`
  - Ensures error messages don't exceed URL length limits
  - Verifies truncation to 100 characters

- `should encode special characters in error message`
  - Tests error messages with special characters
  - Verifies proper URL encoding
  - Ensures URL parsing doesn't break

**How It Catches The Bug**: If error messages aren't sanitized, the redirect would fail with "Invalid character in header content" errors. The test expects a valid redirect with clean error parameter.

## Test Structure

### Test Suites

1. **Regression: HttpExceptionFilter Fastify Compatibility** (3 tests)
   - Tests error handling with Fastify response methods
   - Verifies JSON error format
   - Tests validation errors

2. **Regression: GoogleOAuthGuard Passport Compatibility** (3 tests)
   - Tests raw request/response compatibility
   - Tests user copy to Fastify request
   - Tests error handling

3. **Regression: Admin Bootstrap Transaction Integrity** (3 tests)
   - Tests admin user creation in transaction
   - Tests transaction rollback on failure
   - Tests regular user creation

4. **Regression: Error Message URL Sanitization** (3 tests)
   - Tests newline removal
   - Tests message truncation
   - Tests special character encoding

5. **Integration: Full OAuth Flow End-to-End** (2 tests)
   - Tests complete OAuth flow
   - Tests refresh token flow

### Running the Tests

```bash
# Run the full suite (unit + integration; no database involved)
npm test

# Run only the OAuth integration tests
npm test -- oauth.integration
```

### Prerequisites

These tests never touch a database — Prisma is mocked in full
(`test/mocks/prisma.mock.ts`) — but the suite boots the real `AppModule`, so
`GoogleStrategy` needs OAuth config to construct without throwing.

**Environment Variables** (`apps/api/.env.test`):
```
GOOGLE_CLIENT_ID=test-client-id
GOOGLE_CLIENT_SECRET=test-client-secret
GOOGLE_CALLBACK_URL=http://localhost:3535/api/auth/google/callback
JWT_SECRET=test-secret-key-minimum-32-chars
INITIAL_ADMIN_EMAIL=admin@example.com
APP_URL=http://localhost:3535
```

Do not add `DATABASE_URL` — there is no test database to point it at, and no
database needs to be started to run these tests.

## Test Coverage

These tests provide:
- **Unit Test Coverage**: Individual component behavior
- **Integration Test Coverage**: Full HTTP request/response cycle with a real Fastify adapter, Prisma mocked
- **Mocked-Transaction Coverage**: `context.prismaMock.$transaction` assertions in place of real transaction behavior — no database, no real transaction, ever
- **Error Path Coverage**: All error scenarios that trigger the fixed code paths

## Verification Strategy

Each regression has:
1. **At least 2 tests**: One for success path, one for failure path
2. **Explicit assertions**: Tests verify specific behavior changes
3. **Mock validation**: Tests check the calls made against the mocked Prisma client, not a real database's state
4. **Error message validation**: Tests check error formats and content

## Future Maintenance

When adding OAuth providers or modifying auth flow:
1. Add similar regression tests for new providers
2. Test raw request/response handling
3. Test transaction integrity for user creation
4. Test error message formatting for redirects
5. Test exception filter compatibility with Fastify

## Related Files

- `apps/api/src/auth/guards/google-oauth.guard.ts` - Guard implementation
- `apps/api/src/auth/auth.service.ts` - Auth service with transaction
- `apps/api/src/common/filters/http-exception.filter.ts` - Exception filter
- `apps/api/src/auth/auth.controller.ts` - Controller with error handling
- `apps/api/test/mocks/google-oauth.mock.ts` - Mock OAuth strategy
- `apps/api/test/mocks/prisma.mock.ts` - Mocked Prisma client every test in this suite runs against
- `apps/api/test/auth/oauth.integration.spec.ts` - OAuth integration tests, including this regression coverage

## Notes

- Tests use `MockGoogleStrategy` to avoid real OAuth provider
- Tests use `resetPrismaMock()` / `context.prismaMock` to ensure clean mock state — there is no database to reset
- Tests verify HTTP responses and the calls made against the mocked Prisma client, never real database state
- Tests check for specific error conditions that triggered the bugs
