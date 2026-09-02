# Testing Guide

This document describes the testing approach and commands for the API.

## Rule: API Tests Never Touch a Database

Prisma is mocked in full (`test/mocks/prisma.mock.ts`, via `jest-mock-extended`).
Every suite — unit and integration alike — runs against that mock, reset per
test with `resetPrismaMock()`. There is no test database, no `DATABASE_URL`
in the test environment, and nothing truncates, seeds, or migrates anything.

This keeps the suites fast and hermetic, lets them run in CI with no service
containers, and means no test run can ever destroy a developer's data.
**Do not add a test that requires a live database.**

## Test Types

### Unit Tests
- Located in `src/**/*.spec.ts` (colocated with source files)
- Test a single service/controller/guard with all dependencies (Prisma included) mocked
- Fast execution, no external dependencies required

### Integration Tests
- Located in `test/**/*.integration.spec.ts`
- Boot the real Nest `AppModule` and exercise it end-to-end over HTTP via Supertest
- Prisma is still mocked (`createTestApp` defaults `useMockDatabase` to `true`,
  and no call site in this repo passes `false`) — a real database is never
  involved, only a real app wired to a fake data layer

Both run together, in the same command — there is no separate suite to opt
into.

## Test Commands

### Run All Tests
```bash
npm test
```
Runs every `*.spec.ts` and `*.integration.spec.ts` file. **No database
required or used**, by either test type.

### Watch Mode
```bash
npm run test:watch
```

### Coverage
```bash
npm run test:cov
```

### Debug Mode
```bash
npm run test:debug
```

## Test Structure

### Unit Test Example
```typescript
// src/auth/auth.service.spec.ts
import { Test } from '@nestjs/testing';
import { AuthService } from './auth.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';
import { PrismaService } from '../prisma/prisma.service';

describe('AuthService', () => {
  let service: AuthService;
  let prisma: MockPrismaService;

  beforeEach(async () => {
    prisma = createMockPrismaService();

    const module = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get(AuthService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
```

### Integration Test Example
```typescript
// test/auth/auth.integration.spec.ts
import request from 'supertest';
import {
  TestContext,
  createTestApp,
  closeTestApp,
} from '../helpers/test-app.helper';
import { resetPrismaMock, mockPrismaTransaction, prismaMock } from '../mocks/prisma.mock';
import { createMockAdminUser, authHeader } from '../helpers/auth-mock.helper';

describe('Auth (Integration)', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    mockPrismaTransaction();
  });

  it('/api/auth/me (GET)', async () => {
    const admin = await createMockAdminUser(context, 'admin@example.com');

    return request(context.app.getHttpServer())
      .get('/api/auth/me')
      .set(authHeader(admin.accessToken))
      .expect(200);
  });
});
```

## Test Helpers

### App Helpers
- `test/helpers/test-app.helper.ts` - Application setup utilities
- `createTestApp(options?)` - Creates a full NestJS application instance with Prisma mocked (`useMockDatabase` defaults to `true`)
- `closeTestApp(context)` - Closes the application

### Auth Helpers
- `test/helpers/auth-mock.helper.ts` - Mock user creation and authentication utilities
- `createMockAdminUser(context, email)` / `createMockContributorUser(...)` / `createMockViewerUser(...)` / `createMockInactiveUser(...)` - Creates a mock user with a signed JWT, backed entirely by the Prisma mock
- `authHeader(token)` - Returns `{ Authorization: 'Bearer <token>' }`

### Fixtures
- `test/fixtures/mock-setup.helper.ts` - Common Prisma-mock setup (`setupBaseMocks`, `setupMockUser`)
- `test/fixtures/test-data.factory.ts`, `roles.fixture.ts`, `users.fixture.ts`, `settings.fixture.ts` - Reusable mock data builders

### Mocks
- `test/mocks/prisma.mock.ts` - The mocked `PrismaService` every test runs against (`createMockPrismaService`, `prismaMock`, `resetPrismaMock`, `mockPrismaTransaction`)
- `test/mocks/google-oauth.mock.ts` - Mock Google OAuth profiles

## Best Practices

1. **No test may open a database connection** - Prisma is mocked everywhere; if a test needs different data, configure the mock (`prismaMock.model.method.mockResolvedValue(...)`), don't reach for a real one
2. **Reset the Prisma mock between tests** - Call `resetPrismaMock()` (and `mockPrismaTransaction()` where transactions are involved) in `beforeEach`
3. **Use test helpers** - Don't duplicate mock user creation or authentication logic
4. **Fast feedback loop** - `npm test` runs the whole suite quickly precisely because nothing waits on I/O to a database
5. **Pre-commit validation** - Ensure tests pass before committing
6. **CI pipeline** - `.github/workflows/ci.yml` runs `npm test --workspace=api` with no database service at all — it supplies fake OAuth/JWT values as environment variables because the suite boots the real `AppModule` (which instantiates `GoogleStrategy`), not because anything talks to Postgres

## Troubleshooting

### "OAuth2Strategy requires a clientID option" Error
This means `GoogleStrategy` couldn't find OAuth config while the real `AppModule` was booting for an integration test — it is unrelated to any database. Create `apps/api/.env.test`:
```bash
GOOGLE_CLIENT_ID="test-client-id"
GOOGLE_CLIENT_SECRET="test-client-secret"
GOOGLE_CALLBACK_URL="http://localhost:3535/api/auth/google/callback"
JWT_SECRET="test-secret-key-min-32-characters"
NODE_ENV="test"
```
Do not add `DATABASE_URL` — there is no test database to point it at.

### Tests Timing Out
- Increase timeout in `test/jest.config.js` (currently 30 seconds)
- Consider running tests in parallel: `jest --maxWorkers=4`

### Mock Not Returning Expected Data
- Check that you're using `prismaMock.model.method.mockResolvedValue(data)` in your test
- Ensure the mock is reset between tests with `resetPrismaMock()` in `beforeEach`
- Verify the mock type matches the real Prisma client

## Coverage Goals

- 80%+ coverage for business logic (services, guards, validators)
- Integration tests cover critical user journeys (auth flow, RBAC, settings CRUD) through the real app, with Prisma mocked
- Exclude from coverage: DTOs, modules, main.ts, type definitions
