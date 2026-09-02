# Testing Framework

This document describes the testing strategy, frameworks, and conventions used in this project. It serves as a guide for developers writing new tests and for AI agents that need to understand the testing approach.

## Table of Contents

1. [Testing Framework Overview](#testing-framework-overview)
2. [Test Structure](#test-structure)
3. [Running Tests](#running-tests)
4. [Test Patterns & Conventions](#test-patterns--conventions)
5. [Mocking Strategies](#mocking-strategies)
6. [Writing New Tests](#writing-new-tests)
7. [Test Configuration](#test-configuration)
8. [Best Practices](#best-practices)
9. [Visual Regression Testing](#visual-regression-testing)

## Testing Framework Overview

### Backend (API)

**Framework:** Jest + Supertest + @nestjs/testing

**Why These Frameworks:**
- **Jest**: Industry-standard JavaScript testing framework with excellent TypeScript support, built-in mocking, and parallel test execution
- **Supertest**: HTTP assertion library that works seamlessly with NestJS applications, allowing end-to-end API testing without spinning up a real server
- **@nestjs/testing**: Official NestJS testing utilities that provide dependency injection and module compilation for isolated testing

**Key Features:**
- Unit tests run in isolation with mocked dependencies
- Integration tests boot a real Nest `AppModule` over HTTP (via Supertest) with Prisma mocked in full — **no test ever touches a database**
- OAuth strategies are mocked to avoid external dependencies
- The Prisma mock is reset between tests (`resetPrismaMock()`) for isolation — there is no database to reset

> **Rule: API tests never touch a database.** Prisma is mocked in full
> (`test/mocks/prisma.mock.ts`, via `jest-mock-extended`); the suites are unit
> and integration tests over a real Nest application with a fake data layer.
> There is no test database, no `DATABASE_URL` in the test environment, and
> nothing truncates, seeds, or migrates anything. This keeps the suites fast
> and hermetic, lets them run in CI with no service containers, and means no
> test run can ever destroy a developer's data. **Do not add a test that
> requires a live database.**

### Frontend (Web)

**Framework:** Vitest + React Testing Library + MSW (Mock Service Worker)

**Why These Frameworks:**
- **Vitest**: Fast, modern test runner built for Vite projects with Jest-compatible API, native ESM support, and excellent performance
- **React Testing Library**: Encourages testing components from the user's perspective rather than implementation details, promoting maintainable tests
- **MSW (Mock Service Worker)**: Intercepts network requests at the network level, providing realistic API mocking without changing application code
- **@testing-library/user-event**: Simulates real user interactions more accurately than fireEvent

**Key Features:**
- Component tests render UI in jsdom environment
- API calls are mocked with MSW handlers
- User interactions tested with user-event library
- Context providers (Auth, Theme) tested in isolation

## Test Structure

### Backend Test Organization

```
apps/api/
├── src/
│   └── **/*.spec.ts          # Unit tests (co-located with source)
├── test/
│   ├── jest.config.js         # Jest configuration
│   ├── setup.ts               # Global test setup
│   ├── teardown.ts            # Global test cleanup
│   ├── helpers/               # Test utilities
│   │   ├── test-app.helper.ts    # App creation/teardown (createTestApp mocks Prisma by default)
│   │   └── auth-mock.helper.ts   # Mock user creation & JWT helpers
│   ├── fixtures/              # Mock data builders and setup helpers
│   ├── mocks/                 # Mock implementations
│   │   ├── prisma.mock.ts        # Prisma client mock (jest-mock-extended) — the only "database" any test sees
│   │   └── google-oauth.mock.ts  # OAuth strategy mocks
│   └── **/*.integration.spec.ts  # Integration tests (real AppModule, mocked Prisma)
└── .env.test                  # Test environment variables (OAuth + JWT config only — no DATABASE_URL)
```

**Test Types:**
- **Unit tests** (`*.spec.ts`): Located alongside source files, test individual services/controllers/guards in isolation with a mocked `PrismaService`
- **Integration tests** (`*.integration.spec.ts`): Located in `test/`, boot the real Nest `AppModule` and exercise full request-response cycles through Supertest — with Prisma still mocked, not a real database

### Frontend Test Organization

```
apps/web/
├── src/
│   ├── __tests__/
│   │   ├── setup.ts              # Test setup (MSW, mocks)
│   │   ├── utils/
│   │   │   └── test-utils.tsx    # Custom render utilities
│   │   ├── mocks/
│   │   │   ├── server.ts         # MSW server setup
│   │   │   └── handlers.ts       # API mock handlers
│   │   ├── components/
│   │   │   └── **/*.test.tsx     # Component tests
│   │   ├── contexts/
│   │   │   └── **/*.test.tsx     # Context/hook tests
│   │   └── pages/
│   │       └── **/*.test.tsx     # Page tests
└── vitest.config.ts          # Vitest configuration
```

**Test Types:**
- **Component tests**: Test individual React components in isolation
- **Page tests**: Test entire pages with routing and context
- **Context tests**: Test React contexts and custom hooks
- **Integration tests**: Test multiple components working together

## Running Tests

### Backend Tests

```bash
# Navigate to API directory
cd apps/api

# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run with coverage
npm run test:cov

# Run only unit tests (co-located *.spec.ts)
npm run test:unit

# Debug tests
npm run test:debug

# CI mode (coverage + junit reporter)
npm run test:ci
```

### Frontend Tests

```bash
# Navigate to web directory
cd apps/web

# Run all tests
npm test

# Run tests in watch mode (interactive)
npm run test:watch

# Run tests once (CI mode)
npm run test:run

# Run with coverage
npm run test:coverage

# Open Vitest UI
npm run test:ui

# CI mode (coverage + junit reporter)
npm run test:ci
```

### Environment Variables

Backend tests never touch a database, but the suites boot the real `AppModule`, and that means Nest instantiates `GoogleStrategy`, which throws if OAuth config is missing. Create `apps/api/.env.test` with OAuth and JWT values only:

```bash
GOOGLE_CLIENT_ID="test-client-id"
GOOGLE_CLIENT_SECRET="test-client-secret"
GOOGLE_CALLBACK_URL="http://localhost:3535/api/auth/google/callback"
JWT_SECRET="test-secret-key-min-32-characters"
NODE_ENV="test"
```

**Do not add `DATABASE_URL` here.** There is no test database — Prisma is
mocked in full (`test/mocks/prisma.mock.ts`) — so nothing reads it, and
adding one only invites a future test to depend on a live connection that
doesn't exist. CI supplies the same OAuth/JWT values as fake environment
variables instead of a checked-in `.env.test` (see `.github/workflows/ci.yml`).

## Test Patterns & Conventions

### Naming Conventions

**Backend:**
- Unit tests: `*.spec.ts` (e.g., `auth.service.spec.ts`)
- Integration tests: `*.integration.spec.ts` (e.g., `auth.integration.spec.ts`)

**Frontend:**
- All tests: `*.test.tsx` or `*.test.ts`
- Test files mirror source structure (e.g., `LoginPage.tsx` → `LoginPage.test.tsx`)

### Test Structure Pattern

Use nested `describe` blocks to organize tests logically:

```typescript
describe('ComponentName or ServiceName', () => {
  // Setup
  beforeEach(() => {
    // Reset state before each test
  });

  describe('Feature Group 1', () => {
    it('should do something specific', () => {
      // Arrange
      // Act
      // Assert
    });

    it('should handle error case', () => {
      // Test error handling
    });
  });

  describe('Feature Group 2', () => {
    it('should behave differently', () => {
      // Another test
    });
  });
});
```

**Best Practices:**
- Group related tests in `describe` blocks
- Use descriptive test names starting with "should"
- Follow Arrange-Act-Assert pattern
- One logical assertion per test (exceptions for related assertions)
- Test both success and error cases

### Backend Test Pattern (Unit Test)

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { ServiceName } from './service-name.service';
import { PrismaService } from '../prisma/prisma.service';
import { createMockPrismaService } from '../../test/mocks/prisma.mock';

describe('ServiceName', () => {
  let service: ServiceName;
  let mockPrisma: MockPrismaService;

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ServiceName,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<ServiceName>(ServiceName);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('methodName', () => {
    it('should return expected result', async () => {
      // Arrange
      mockPrisma.model.findUnique.mockResolvedValue({ id: '1' });

      // Act
      const result = await service.methodName('1');

      // Assert
      expect(result).toEqual({ id: '1' });
      expect(mockPrisma.model.findUnique).toHaveBeenCalledWith({
        where: { id: '1' },
      });
    });
  });
});
```

### Backend Test Pattern (Integration Test)

Integration tests boot the real `AppModule` behind Supertest, but Prisma is
still the mock from `test/mocks/prisma.mock.ts` — `createTestApp` defaults
`useMockDatabase` to `true`, and no call site in the repo passes `false`.
There is no database to reset; `resetPrismaMock()` clears the mock's call
history instead.

```typescript
import request from 'supertest';
import { TestContext, createTestApp, closeTestApp } from '../helpers/test-app.helper';
import { resetPrismaMock, mockPrismaTransaction, prismaMock } from '../mocks/prisma.mock';
import { createMockAdminUser, authHeader } from '../helpers/auth-mock.helper';

describe('Controller (Integration)', () => {
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

  describe('GET /api/endpoint', () => {
    it('should return data for authenticated user', async () => {
      const admin = await createMockAdminUser(context, 'admin@example.com');
      prismaMock.someModel.findMany.mockResolvedValue([]);

      const response = await request(context.app.getHttpServer())
        .get('/api/endpoint')
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(response.body.data).toBeDefined();
    });

    it('should return 401 without token', async () => {
      await request(context.app.getHttpServer())
        .get('/api/endpoint')
        .expect(401);
    });
  });
});
```

### Frontend Test Pattern (Component Test)

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils/test-utils';
import { ComponentName } from '../../components/ComponentName';

describe('ComponentName', () => {
  beforeEach(() => {
    // Reset any state
  });

  describe('Rendering', () => {
    it('should render component with props', () => {
      render(<ComponentName title="Test" />);

      expect(screen.getByText('Test')).toBeInTheDocument();
    });
  });

  describe('User Interaction', () => {
    it('should handle button click', async () => {
      const user = userEvent.setup();
      const onClickMock = vi.fn();

      render(<ComponentName onClick={onClickMock} />);

      await user.click(screen.getByRole('button'));

      expect(onClickMock).toHaveBeenCalledTimes(1);
    });
  });
});
```

### Frontend Test Pattern (Hook Test)

```typescript
import { renderHook, act, waitFor } from '@testing-library/react';
import { useCustomHook } from '../../hooks/useCustomHook';

describe('useCustomHook', () => {
  it('should return initial state', () => {
    const { result } = renderHook(() => useCustomHook());

    expect(result.current.value).toBe(null);
    expect(result.current.isLoading).toBe(false);
  });

  it('should update state on action', async () => {
    const { result } = renderHook(() => useCustomHook());

    act(() => {
      result.current.updateValue('new');
    });

    await waitFor(() => {
      expect(result.current.value).toBe('new');
    });
  });
});
```

## Mocking Strategies

### Backend Mocking

#### 1. Prisma Client Mocking (Unit Tests)

Use the provided mock factory for consistent Prisma mocking:

```typescript
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';

let mockPrisma: MockPrismaService;

beforeEach(() => {
  mockPrisma = createMockPrismaService();

  // Configure specific mocks
  mockPrisma.user.findUnique.mockResolvedValue({ id: '1', email: 'test@example.com' });
});
```

The mock factory provides Jest mock functions for all Prisma operations (findUnique, findMany, create, update, delete, etc.).

#### 2. OAuth Strategy Mocking

Google OAuth is mocked using a custom Passport strategy:

```typescript
import { MockGoogleStrategy, createMockGoogleProfile } from '../../test/mocks/google-oauth.mock';

// Set mock profile for next auth
MockGoogleStrategy.setMockProfile({
  email: 'custom@example.com',
  displayName: 'Custom User',
});

// Reset to defaults
MockGoogleStrategy.resetMockProfile();
```

This allows E2E tests to simulate OAuth flows without calling Google's servers.

#### 3. JWT Service Mocking (Unit Tests)

```typescript
const mockJwtService = {
  sign: jest.fn().mockReturnValue('mock-jwt-token'),
  verify: jest.fn().mockReturnValue({ sub: '1', email: 'test@example.com' }),
} as any;
```

#### 4. Config Service Mocking

```typescript
const mockConfigService = {
  get: jest.fn((key: string) => {
    const config: Record<string, any> = {
      'jwt.secret': 'test-secret',
      'jwt.accessTtlMinutes': 15,
    };
    return config[key];
  }),
} as any;
```

### Frontend Mocking

#### 1. API Mocking with MSW

MSW intercepts HTTP requests at the network level. Handlers are defined in `apps/web/src/__tests__/mocks/handlers.ts`:

```typescript
import { http, HttpResponse } from 'msw';

export const handlers = [
  http.get('/api/auth/me', () => {
    return HttpResponse.json({
      data: {
        id: 'user-1',
        email: 'test@example.com',
        roles: ['viewer'],
      },
    });
  }),

  http.post('/api/auth/logout', () => {
    return new HttpResponse(null, { status: 204 });
  }),
];
```

**Override handlers in specific tests:**

```typescript
import { server } from '../mocks/server';
import { http, HttpResponse } from 'msw';

it('should handle error', async () => {
  server.use(
    http.get('/api/auth/me', () => {
      return new HttpResponse(null, { status: 500 });
    }),
  );

  // Test error handling
});
```

#### 2. Browser API Mocking

Common browser APIs are mocked in `setup.ts`:

```typescript
// Mock window.matchMedia (for MUI responsive components)
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })),
});

// Mock ResizeObserver
global.ResizeObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}));
```

#### 3. Context Mocking

Use custom render utilities to wrap components with necessary providers:

```typescript
import { render } from '../utils/test-utils';

// Render with authenticated context
render(<Component />, {
  wrapperOptions: { authenticated: true },
});

// Render with unauthenticated context
render(<Component />, {
  wrapperOptions: { authenticated: false },
});
```

#### 4. Router Mocking

```typescript
import { MemoryRouter } from 'react-router-dom';

render(
  <MemoryRouter initialEntries={['/login']}>
    <LoginPage />
  </MemoryRouter>
);
```

## Writing New Tests

### Adding a Backend Unit Test

1. **Create test file** next to source file: `feature.service.spec.ts`
2. **Import testing utilities:**
   ```typescript
   import { Test, TestingModule } from '@nestjs/testing';
   ```
3. **Mock dependencies** using provided mock factories
4. **Test each method** with success and error cases
5. **Verify calls** to mocked dependencies

### Adding a Backend Integration Test

1. **Create test file** in `apps/api/test/` directory: `feature.integration.spec.ts`
2. **Use test helpers:**
   ```typescript
   import { createTestApp, closeTestApp } from '../helpers/test-app.helper';
   import { resetPrismaMock, mockPrismaTransaction, prismaMock } from '../mocks/prisma.mock';
   import { createMockAdminUser, authHeader } from '../helpers/auth-mock.helper';
   ```
3. **Set up test context** in `beforeAll` (`createTestApp({ useMockDatabase: true })` — the default)
4. **Reset the Prisma mock** in `beforeEach` (`resetPrismaMock()`) — there is no database to reset
5. **Test HTTP endpoints** with Supertest, configuring `prismaMock` return values per test
6. **Test RBAC** by creating mock users with different roles (`createMockAdminUser`, `createMockContributorUser`, `createMockViewerUser`)

### Adding a Frontend Component Test

1. **Create test file** in `apps/web/src/__tests__/components/`: `Component.test.tsx`
2. **Import testing utilities:**
   ```typescript
   import { render } from '../utils/test-utils';
   import { screen, waitFor } from '@testing-library/react';
   import userEvent from '@testing-library/user-event';
   ```
3. **Test rendering** with different props
4. **Test user interactions** with `userEvent`
5. **Test async behavior** with `waitFor`
6. **Mock API calls** with MSW if needed

### Adding a Frontend Context/Hook Test

1. **Create test file** in `apps/web/src/__tests__/contexts/`: `Context.test.tsx`
2. **Use `renderHook`** from React Testing Library
3. **Create wrapper** with necessary providers
4. **Test state changes** with `act` and `waitFor`
5. **Test error handling** by mocking failing API calls

## Test Configuration

### Backend Configuration

**File:** `apps/api/test/jest.config.js`

```javascript
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '..',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.module.ts',
    '!src/**/*.dto.ts',
    '!src/main.ts',
    '!src/**/*.spec.ts',
  ],
  coverageDirectory: './coverage',
  testEnvironment: 'node',
  roots: ['<rootDir>/src/', '<rootDir>/test/'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  setupFilesAfterEnv: ['<rootDir>/test/setup.ts'],
  globalTeardown: '<rootDir>/test/teardown.ts',
  testTimeout: 30000,
  verbose: true,
};
```

**Key Settings:**
- `testRegex`: Matches `*.spec.ts` files
- `roots`: Includes both `src/` and `test/` directories
- `setupFilesAfterEnv`: Runs setup before tests
- `testTimeout`: 30 seconds, generous headroom for booting the full `AppModule` in integration tests
- `moduleNameMapper`: Supports `@/` path alias

### Frontend Configuration

**File:** `apps/web/vitest.config.ts`

```typescript
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/__tests__/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules', 'dist'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules',
        'src/__tests__',
        '**/*.d.ts',
        '**/*.config.*',
        'src/main.tsx',
      ],
      thresholds: {
        lines: 70,
        branches: 70,
        functions: 70,
        statements: 70,
      },
    },
    testTimeout: 10000,
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
});
```

**Key Settings:**
- `environment: 'jsdom'`: Browser-like environment for React
- `globals: true`: No need to import `describe`, `it`, `expect`
- `setupFiles`: Runs MSW setup and browser mocks
- `coverage.thresholds`: Enforces minimum 70% coverage
- `testTimeout`: 10 seconds for async operations

## Best Practices

### General

1. **Test Behavior, Not Implementation**
   - Test what the code does, not how it does it
   - Avoid testing internal state or private methods
   - Focus on public API and observable outcomes

2. **Test Isolation**
   - Each test should run independently
   - Use `beforeEach` to reset state
   - Don't rely on test execution order

3. **Clear Test Names**
   - Use descriptive names: `should return 401 when token is invalid`
   - Follow pattern: "should [expected behavior] when [condition]"

4. **Arrange-Act-Assert Pattern**
   - **Arrange:** Set up test data and mocks
   - **Act:** Execute the code under test
   - **Assert:** Verify the outcome

5. **Test Error Cases**
   - Always test both success and failure paths
   - Test edge cases and boundary conditions
   - Test validation errors and exceptions

### Backend-Specific

1. **Unit Test External Dependencies**
   - Mock Prisma, external APIs, file system
   - Unit tests should be fast (<100ms per test)

2. **Integration-Test Critical Paths**
   - Auth flows (login, logout, refresh)
   - RBAC enforcement
   - API contract validation
   - Prisma call shape (e.g. that a service passes the right `where`/`data` to a mocked `$transaction`)

3. **Use Test Helpers**
   - Leverage provided helpers for mock user creation, auth headers, and Prisma mock reset
   - Keep test code DRY with shared utilities

4. **Mock Isolation**
   - Always reset the Prisma mock in `beforeEach` (`resetPrismaMock()`)
   - There is no test database to isolate — Prisma is mocked in full; do not add a test that requires a live database
   - Never point a test at a real database, development or otherwise

### Frontend-Specific

1. **Query by Accessibility**
   - Prefer `getByRole`, `getByLabelText`, `getByText`
   - Avoid `getByTestId` unless necessary
   - Mirrors how users interact with UI

2. **User-Centric Testing**
   - Use `userEvent` instead of `fireEvent`
   - Test user flows, not implementation
   - Wait for async updates with `waitFor`

3. **Mock Network at Network Level**
   - Use MSW for realistic API mocking
   - Define default handlers, override in tests
   - MSW works in both tests and browser

4. **Avoid Testing Implementation Details**
   - Don't test component state directly
   - Don't test CSS classes or internal methods
   - Test visible output and user interactions

### Coverage Guidelines

**Target Coverage:** 70% minimum (enforced in frontend)

**What to Focus On:**
- Business logic in services
- RBAC guards and decorators
- API controllers (especially auth)
- React contexts and custom hooks
- Critical user flows (login, settings)

**What Can Have Lower Coverage:**
- DTOs and type definitions
- Module configuration files
- Simple getter/setter methods
- UI styling components

### Debugging Tests

**Backend:**
```bash
# Run tests with Node debugger
npm run test:debug

# Add breakpoint in code
debugger;

# Run single test file
npm test -- auth.service.spec.ts

# Run single test by name
npm test -- -t "should create user"
```

**Frontend:**
```bash
# Open Vitest UI for interactive debugging
npm run test:ui

# Run single test file
npm test -- LoginPage.test.tsx

# Run with browser-like debugging
npm run test:ui
```

**Helpful Debugging Tools:**
- `screen.debug()` - Print current DOM state
- `screen.logTestingPlaygroundURL()` - Get query suggestions
- `console.log` in tests (shown in output)
- VS Code debugger integration

## Common Issues and Solutions

### Backend

**Issue:** `GoogleStrategy` throws "OAuth2Strategy requires a clientID option" on boot
- **Solution:** Ensure `apps/api/.env.test` sets `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_CALLBACK_URL` — tests boot the real `AppModule`, which instantiates `GoogleStrategy`, even though no test opens a database connection

**Issue:** Prisma mock not working as expected
- **Solution:** Clear mocks in `afterEach`, use `mockResolvedValue` for promises

**Issue:** JWT validation fails in tests
- **Solution:** Ensure `JWT_SECRET` is set in test environment

### Frontend

**Issue:** "Target container is not a DOM element"
- **Solution:** Ensure `jsdom` environment is set in vitest.config.ts

**Issue:** "window.matchMedia is not a function"
- **Solution:** Check that setup.ts is imported in vitest.config

**Issue:** MSW not intercepting requests
- **Solution:** Verify server.listen() is called in beforeAll

**Issue:** Async state not updating in tests
- **Solution:** Use `await waitFor()` to wait for async updates

## E2E Testing with Playwright

### Overview

The application supports end-to-end testing using Playwright with a dedicated test authentication mechanism that bypasses Google OAuth.

### Test Authentication

In development/test environments, a special login page at `/testing/login` allows Playwright tests to authenticate as any user with any role without going through Google OAuth.

**How it works:**
1. Backend provides `POST /api/auth/test/login` endpoint (disabled in production)
2. Frontend provides `/testing/login` page (excluded from production builds)
3. Tests can authenticate as admin, contributor, or viewer roles

### Directory Structure

```
tests/e2e/
├── playwright.config.ts       # Playwright configuration
├── helpers/
│   └── auth.helper.ts         # Login helper functions
├── fixtures/
│   └── auth.fixture.ts        # Pre-authenticated page fixtures
└── specs/
    ├── auth.spec.ts           # Authentication tests
    └── example.spec.ts        # Example feature tests
```

### Auth Helper

```typescript
// tests/e2e/helpers/auth.helper.ts
import { Page } from '@playwright/test';

export async function loginAsTestUser(
  page: Page,
  options: { email: string; role?: 'admin' | 'contributor' | 'viewer' }
): Promise<void> {
  await page.goto('/testing/login');
  await page.fill('[data-testid="test-email-input"]', options.email);
  if (options.role) {
    await page.click('[data-testid="test-role-select"]');
    await page.click(`[data-value="${options.role}"]`);
  }
  await page.click('[data-testid="test-login-button"]');
  await page.waitForURL('/');
}
```

### Auth Fixtures

```typescript
// tests/e2e/fixtures/auth.fixture.ts
import { test as base, Page } from '@playwright/test';
import { loginAsAdmin, loginAsViewer } from '../helpers/auth.helper';

export const test = base.extend<{
  adminPage: Page;
  viewerPage: Page;
}>({
  adminPage: async ({ page }, use) => {
    await loginAsAdmin(page);
    await use(page);
  },
  viewerPage: async ({ page }, use) => {
    await loginAsViewer(page);
    await use(page);
  },
});

export { expect } from '@playwright/test';
```

### Example Test

```typescript
// tests/e2e/specs/admin.spec.ts
import { test, expect } from '../fixtures/auth.fixture';

test.describe('Admin functionality', () => {
  test('can access users & allowlist', async ({ adminPage }) => {
    // /admin/users is a real redirect route (epic #90) — it resolves to
    // /admin/settings/users, the Users & Allowlist card's route within the
    // Console settings hub. See docs/specs/settings-ui.md.
    await adminPage.goto('/admin/users');
    await expect(adminPage).toHaveURL('/admin/settings/users');
  });

  test('viewer cannot access admin pages', async ({ viewerPage }) => {
    await viewerPage.goto('/admin/users');
    await expect(viewerPage).not.toHaveURL('/admin/settings/users');
  });
});
```

### Running E2E Tests

```bash
# Navigate to e2e test directory
cd tests/e2e

# Install dependencies (first time)
npm install
npx playwright install chromium

# Run all E2E tests
npm test

# Run with UI mode (interactive)
npm run test:ui

# Run in headed mode (see browser)
npm run test:headed

# Run specific test file
npx playwright test auth.spec.ts
```

### Security Note

The test authentication endpoint (`/api/auth/test/login`) and the test login page (`/testing/login`) are **completely disabled in production** through multiple security layers. See [SECURITY-ARCHITECTURE.md](SECURITY-ARCHITECTURE.md#13-test-authentication-development-only) for details.

## Visual Regression Testing

### Overview

In addition to the Vitest component suite and the Playwright E2E suite above, the project maintains a third, narrower test suite dedicated to pixel-level visual regression testing. It lives in `tests/visual/` — a sibling to `tests/e2e/`, not a variant of it — and exists to catch layout bugs that neither of the other two suites can see, no matter how the assertions inside them are written.

This suite was built for issue #107 after epic #90 shipped 1,563 passing Vitest tests alongside two visible layout regressions (issue #105): the `Console` entry was rendering inline in the navigation rail instead of pinned at its foot, and collapsed-rail captions were truncating ("Setti…", "Cons…"). Both bugs were plainly visible in the running app, and neither was caught by 1,563 otherwise-passing tests.

### Why jsdom Can't Catch This

Vitest's component tests run in jsdom, which has no layout engine. `offsetWidth` and `offsetHeight` are always `0`, text never wraps, nothing overflows its container, and elements have no real font metrics — jsdom doesn't know what a font looks like, let alone measure text against one. A test can assert that a caption's DOM node contains the string `"Console"`, but it cannot ask whether that string rendered on one line or two, whether it got clipped with an ellipsis, or whether it pushed a sibling element out of the rail's fixed width. Both #105 bugs lived entirely in that blind spot: one was a layout-order mistake that only resolves into an actual on-screen position once a real layout engine runs, the other was a caption whose padding only becomes "too wide for the collapsed rail" once real text is laid out against a real font.

This is a structural gap in jsdom, not a coverage gap that more (or cleverer) Vitest tests can close. Anything that depends on real layout — text wrapping, ellipsis truncation, overflow, the settings hub's card-grid column count at a given viewport width, a long label widening a fixed-width shell — is invisible to a jsdom-based assertion regardless of how the test is written. Closing that gap requires an actual browser laying out actual pixels, which is what `tests/visual/` does: it renders the real app in real Chromium at fixed viewport sizes and asserts the rendered pixels against a checked-in baseline image, tolerant of only a handful of pixels of drift.

### The Harness

The suite doesn't screenshot the running application; it screenshots a small, purpose-built harness at `apps/web/visual/` (`index.html`, `main.tsx`, `vite.config.ts`, `tsconfig.json`). The harness is a separate Vite entry point from `apps/web/src/` — excluded from the production build and from `apps/web`'s `tsc --noEmit` app scope — but it mounts the **real** application components: `Layout`, `NavigationRail`, `AppBar`, and `SettingsHub` (via both `pages/Admin/SettingsHubPage` and `pages/UserSettingsHubPage`), wrapped in a fake `AuthContext.Provider`, the real `ThemeContextProvider` + MUI `ThemeProvider` + `CssBaseline`, and a `MemoryRouter`.

The harness takes its starting state entirely from query parameters on its own URL, so a spec can pin exactly the state it wants to screenshot:

| Param | Effect |
|---|---|
| `?route=` | Initial router entry |
| `?perms=` | Comma-separated permission strings, becomes `user.permissions` |
| `?roles=` | Comma-separated role strings, becomes `user.roles` |
| `?theme=` | `light` or `dark`, written to `localStorage.theme_mode` before mount |

There is no backend, no database, and no OAuth behind the harness. Calls the app's real hooks make under the hood (e.g. `useUserSettings`, used internally by `useNavigationPrefs`) are deliberately left unproxied, so they fail fast and the app's existing error handling degrades to a deterministic default state — that determinism is what makes the resulting screenshots stable enough to diff against a checked-in baseline.

### Fonts: The Harness Loads the App's, Not Its Own

Typography is load-bearing for this suite. The caption-truncation half of #105 is a bug about whether a word fits a fixed-width box, which is a question about *glyph metrics* — so the font the harness renders in has to be the font the application renders in, or the baselines describe a layout no user ever sees.

The harness originally solved this by shipping its own copy of Inter under `apps/web/visual/assets/fonts/` with its own `@font-face`, because at the time the application loaded no webfont at all: `src/theme/index.ts` declared `"Inter", "Roboto", "Helvetica", "Arial", sans-serif` but nothing ever fetched the first two, so real users got Arial, Helvetica or DejaVu depending on their OS. That was issue **#111**, and it made the harness's private copy the only Inter in the repository.

#111 fixed it at the root. The application now self-hosts Inter itself:

| File | Role |
|---|---|
| `apps/web/public/fonts/Inter-latin-variable.woff2` | The **only** font file in the repo (~48KB, latin subset, variable `wght` 100–900) |
| `apps/web/public/fonts/inter.css` | The **only** `@font-face` in the repo, `font-display: swap` |
| `apps/web/index.html` | `<link>`s that stylesheet — the real app |
| `apps/web/visual/index.html` | `<link>`s **the same** stylesheet at the same URL — the harness |

The harness sees `/fonts/...` because `apps/web/visual/vite.config.ts` points its `publicDir` at `apps/web/public` instead of Vite's `<root>/public` default. Nothing is duplicated: **one font file, one `@font-face`, both consumers.**

This is not tidiness, it's what makes the suite non-vacuous. While the harness owned a private font, the app could have lost Inter entirely — or never had it, which is what actually happened — and all 11 pixel baselines would still have passed, because they were measuring the harness's font loading rather than the application's. That coupling is now verified in both directions: deleting `apps/web/public/fonts/inter.css` fails the suite.

Because the shared stylesheet uses `font-display: swap` (correct for production — text must never be invisible while a font is in flight) rather than the `block` the harness previously used for its own convenience, specs must not screenshot during the swap window. Every spec therefore calls `waitForInter(page)` from `tests/visual/support/harness.ts` immediately after `page.goto()`. It awaits `document.fonts.load()` for each weight the theme uses, then asserts against the **FontFace set** — that exactly one `Inter` face is registered, that its `status` is `loaded`, and that it still carries the full `100 900` variable range.

That assertion is deliberately not `document.fonts.check('16px Inter')`, which is useless for this purpose: `check()` asks "can this be rendered?", and an undeclared family counts as an available system font, so it returns `true` in precisely the broken case the guard exists to catch. Confirmed empirically — with the stylesheet deleted, `check()` still returned `true` while the screenshots diffed by 11,589 pixels.

### Directory Structure

```
apps/web/public/fonts/            # Shared by the app AND the harness (#111)
├── Inter-latin-variable.woff2    # The repo's only font file
└── inter.css                     # The repo's only @font-face

apps/web/visual/                  # Harness — mounts real app components
├── index.html                    # <link>s the app's /fonts/inter.css
├── main.tsx
├── vite.config.ts                # publicDir -> apps/web/public
└── tsconfig.json

tests/visual/                     # Playwright project — sibling to tests/e2e/
├── playwright.config.ts          # Own testDir, own webServer (harness only)
├── package.json                  # @playwright/test pinned to exact 1.62.1 (no caret)
├── support/harness.ts            # URL builder + waitForInter() font guard
└── specs/                        # 11 specs across 7 files
```

`tests/visual/` is deliberately independent of `tests/e2e/`: it has its own `testDir`, its own `webServer` entry (which starts only the harness's Vite dev server — no Docker Compose stack, no API, no database), and its own pinned Playwright version. That pin is not incidental: `tests/e2e/package.json` floats `@playwright/test` on `^1.40.0`, which is fine for behavioral E2E, but pixel baselines are sensitive to the exact Chromium build a given Playwright version ships, not just its API surface — an unpinned range would let baselines drift out from under the suite on an unrelated `npm install`.

### What's Covered

The 11 specs cover the settings hub at three breakpoints — 1919×862 (3-up card grid, expanded Console rail), 767×844 (2-up grid, collapsed rail), and 551×840 (drill-down list) — plus the Console rail's group headers and "Back to library" control on `/admin/settings` at desktop width, the library rail with Console pinned at its foot (both collapsed and expanded on a non-admin route), the compact drill-down `AppBar`, a filtered search result and the empty "no results" state, a `users:read`-only user whose `General` settings group disappears entirely, and the user settings hub at `/settings`.

### Configuration

A few settings in `tests/visual/playwright.config.ts` exist specifically because this suite screenshots real layout rather than asserting on the DOM:

- **`animations: 'disabled'`** — removes MUI transition timing as a source of flaky diffs.
- **`maxDiffPixels: 4`** (an absolute count, not a ratio) — several specs screenshot a mostly-blank nav rail element where a real regression changes only a few hundred pixels out of roughly 47,000 total, comfortably under even a 1% ratio threshold. An absolute pixel count catches that; a percentage would not.
- **pixelmatch `threshold: 0.05`** (down from Playwright's default of `0.2`) — the #105 caption-padding regression's visual delta is a subtle tint-edge shift on a near-black dark theme background. At the default perceptual threshold, pixelmatch does not register it as different at all, despite a large, real, confirmed RGB delta.

Baselines are generated and verified **only** inside the pinned container, `mcr.microsoft.com/playwright:v1.62.1-noble` — never on a developer's host machine. Host Chromium's font hinting and antialiasing drift from CI's, and at this tight a pixel tolerance that drift alone is enough to fail a spec with no real regression present.

### CI Integration

A `visual` job in `.github/workflows/ci.yml` runs concurrently with the other CI jobs (no `needs:` dependency), inside `container: mcr.microsoft.com/playwright:v1.62.1-noble`. It invokes the pinned Playwright binary directly:

```bash
tests/visual/node_modules/.bin/playwright test --config=tests/visual/playwright.config.ts
```

It does **not** use `npx playwright`, which resolves a different, unpinned Playwright module instance from the repo root and throws a `"did not expect test() to be called here"` error from having two copies of the Playwright module loaded in the same process.

The job uploads `tests/visual/playwright-report/` via `actions/upload-artifact@v4` unconditionally (`if: always()`), so a failing run's HTML report — which embeds the expected, actual, and diff PNGs for every failed assertion — is downloadable directly from the Actions run without needing to reproduce the failure locally.

### Running Tests Locally

Playwright's `webServer` option starts the harness's Vite dev server automatically, so from `tests/visual/`, after `npm install`, a bare test run is normally sufficient:

```bash
cd tests/visual
npm install
npm test
# or directly:
npx playwright test --config=tests/visual/playwright.config.ts
```

(Manually starting the harness dev server yourself, from `apps/web/visual/`, is only needed if you want to poke at the harness in a browser outside of a test run.)

To generate or verify baselines, run the suite inside the exact pinned container instead — the point of the container is that the pixels it produces are the same pixels CI will produce. From the repo root:

```bash
REPO=$(git rev-parse --show-toplevel)
docker run --rm \
  --user "$(id -u):$(id -g)" \
  -v "$REPO:$REPO" \
  -w "$REPO" \
  mcr.microsoft.com/playwright:v1.62.1-noble \
  tests/visual/node_modules/.bin/playwright test --config=tests/visual/playwright.config.ts
```

Three details in that command are load-bearing:

- **`--user "$(id -u):$(id -g)"`.** The image's default user is root, and Playwright writes `test-results/` and `playwright-report/` into the mount. Without this flag those directories come back owned by root: they are gitignored so they never reach a commit, but they are enough to make `git worktree remove` and `rm -rf` fail with *Permission denied* until you delete them from inside a container. Run as yourself and the problem does not arise.
- **The mount path equals the host path.** `node_modules` inside a worktree is a symlink into the main checkout, so mounting the repo root at its own absolute path is what keeps those symlinks resolvable inside the container. Mounting at `/app` instead leaves them dangling.
- **Invoking the pinned binary directly** rather than through `npx`. `npx` resolves the first Playwright it finds walking up from the working directory, which in this repo is the unpinned copy at the root — and a version mismatch against the container's browsers throws a module-duplication error rather than anything self-explanatory.

### Updating Baselines Deliberately

To regenerate baselines after an intentional visual change, run the suite with `--update-snapshots` inside the same pinned container — `tests/visual/package.json` provides `npm run test:update` for this. As with the run command above, this must happen inside `mcr.microsoft.com/playwright:v1.62.1-noble`, not on a host machine.

This is the most important paragraph in this section: **blessing a diff without opening the image and confirming the new pixels are the intended change is the standard failure mode of every snapshot-testing suite, and it would defeat the entire purpose of this one.** A rubber-stamped `--update-snapshots` run after a CI failure silently readmits the exact class of regression — #105 — that this suite exists to catch. Before running `test:update`, open the failing run's HTML report, look at the diff image for each failing spec, and understand specifically what changed and why. Only update the baseline once that change is confirmed intentional. If it isn't, the fix is to fix the code, not the baseline.

---

## Resources

- [Jest Documentation](https://jestjs.io/docs/getting-started)
- [Vitest Documentation](https://vitest.dev/)
- [React Testing Library](https://testing-library.com/docs/react-testing-library/intro/)
- [MSW Documentation](https://mswjs.io/docs/)
- [NestJS Testing](https://docs.nestjs.com/fundamentals/testing)
- [Supertest Documentation](https://github.com/visionmedia/supertest)
- [Playwright Documentation](https://playwright.dev/)

## Summary

This project uses industry-standard testing frameworks tailored to each layer:

- **Backend:** Jest + Supertest for comprehensive API testing over a fully mocked Prisma layer — no test database, ever
- **Frontend:** Vitest + React Testing Library + MSW for fast, user-centric component testing
- **Mocking:** Prisma mocks, OAuth mocks, MSW handlers for realistic test scenarios
- **Helpers:** Shared utilities for mock user creation, Prisma mock reset, and test app setup

When writing tests, focus on behavior over implementation, maintain test isolation, and leverage the provided helpers for consistency. Target 70% coverage with emphasis on business logic, auth flows, and RBAC enforcement.
