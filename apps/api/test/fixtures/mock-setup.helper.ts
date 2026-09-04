import { prismaMock, mockPrismaTransaction } from '../mocks/prisma.mock';
import {
  createMockUser,
  createMockUserWithRelations,
  createMockAllowedEmail,
  createMockAuditEvent,
  createMockSystemSettings,
  mockRoles,
  mockPermissions,
  CreateMockUserOptions,
  CreateMockAllowedEmailOptions,
} from './test-data.factory';

/**
 * Mock setup helpers to configure Prisma mock responses
 * Use these to set up test scenarios without database calls
 */

// ============================================================================
// Role and Permission Mocks
// ============================================================================

export function setupRoleMocks(): void {
  // Mock role.findUnique - use mockResolvedValue for each call
  (prismaMock.role.findUnique as jest.Mock).mockImplementation(
    async ({ where }: any) => {
      if (where.name) {
        return mockRoles[where.name as keyof typeof mockRoles] || null;
      }
      if (where.id) {
        const role = Object.values(mockRoles).find((r) => r.id === where.id);
        return role || null;
      }
      return null;
    },
  );

  // Mock role.findMany
  (prismaMock.role.findMany as jest.Mock).mockImplementation(
    async ({ where }: any) => {
      // Handle filtering by name with 'in' operator
      if (where?.name?.in && Array.isArray(where.name.in)) {
        return Object.values(mockRoles).filter((r) =>
          where.name.in.includes(r.name),
        );
      }
      // Return all roles if no filter
      return Object.values(mockRoles);
    },
  );

  // Mock permission.findUnique
  (prismaMock.permission.findUnique as jest.Mock).mockImplementation(
    async ({ where }: any) => {
      if (where.name) {
        const permission = Object.values(mockPermissions).find(
          (p) => p.name === where.name,
        );
        return permission || null;
      }
      return null;
    },
  );

  // Mock permission.findMany
  (prismaMock.permission.findMany as jest.Mock).mockResolvedValue(
    Object.values(mockPermissions),
  );
}

// ============================================================================
// User Mocks
// ============================================================================

export interface SetupMockUserResponse {
  id: string;
  email: string;
  roles: string[];
}

// Registry of mock users - accumulates users across multiple setupMockUser calls
let mockUserRegistry: Map<string, any> = new Map();

/**
 * Clear the mock user registry
 * Call this in beforeEach() along with resetPrismaMock()
 */
export function clearMockUserRegistry(): void {
  mockUserRegistry = new Map();
}

/**
 * Setup the user mock implementations
 * This should be called once in beforeEach after clearing the registry
 */
export function setupUserMocks(): void {
  // Mock user.findUnique - searches the registry
  (prismaMock.user.findUnique as jest.Mock).mockImplementation(
    async ({ where, include }: any) => {
      // Search by id
      if (where.id && mockUserRegistry.has(where.id)) {
        return mockUserRegistry.get(where.id);
      }
      // Search by email
      for (const user of mockUserRegistry.values()) {
        if (where.email === user.email) {
          return user;
        }
      }
      return null;
    },
  );

  // Mock user.update - updates user in registry
  (prismaMock.user.update as jest.Mock).mockImplementation(
    async ({ where, data, include }: any) => {
      const user = mockUserRegistry.get(where.id);
      if (user) {
        // Merge the data updates into the existing user
        const updated = { ...user };
        // Only update fields that are defined in data
        if (data.displayName !== undefined) updated.displayName = data.displayName;
        if (data.isActive !== undefined) updated.isActive = data.isActive;
        if (data.profileImageUrl !== undefined) updated.profileImageUrl = data.profileImageUrl;
        if (data.providerDisplayName !== undefined) updated.providerDisplayName = data.providerDisplayName;
        if (data.providerProfileImageUrl !== undefined) updated.providerProfileImageUrl = data.providerProfileImageUrl;

        mockUserRegistry.set(where.id, updated);
        return updated;
      }
      // Search by email
      for (const [id, u] of mockUserRegistry.entries()) {
        if (where.email === u.email) {
          const updated = { ...u, ...data };
          mockUserRegistry.set(id, updated);
          return updated;
        }
      }
      throw new Error('User not found');
    },
  );
}

/**
 * Setup a mock user in the Prisma mock
 * Returns the user data that will be "found" by Prisma queries
 * Supports multiple users - each call adds to the registry
 */
export function setupMockUser(
  options: CreateMockUserOptions = {},
): SetupMockUserResponse {
  const user = createMockUserWithRelations(options);

  // Add user to registry
  mockUserRegistry.set(user.id, user);

  const roles = user.userRoles?.map((ur: any) => ur.role.name) || [];

  return {
    id: user.id,
    email: user.email,
    roles,
  };
}

/**
 * Setup multiple mock users for list queries
 * Adds them to the user registry so they work with other mock user functions
 * This does NOT clear existing users - it merges with them by replacing users with matching emails
 */
export function setupMockUserList(
  users: Array<CreateMockUserOptions>,
): SetupMockUserResponse[] {
  const mockUsers = users.map((opts) => createMockUserWithRelations(opts));

  // Replace or add users to the registry
  // If a user with the same email exists, replace it with the new one
  mockUsers.forEach((newUser) => {
    // Find existing user with same email
    let existingId: string | null = null;
    for (const [id, existingUser] of mockUserRegistry.entries()) {
      if (existingUser.email === newUser.email) {
        existingId = id;
        break;
      }
    }

    if (existingId) {
      // Replace existing user (keep same ID for JWT tokens to work)
      newUser.id = existingId;
      mockUserRegistry.set(existingId, newUser);
    } else {
      // Add new user
      mockUserRegistry.set(newUser.id, newUser);
    }
  });

  // Mock user.findMany to use the registry (all users)
  (prismaMock.user.findMany as jest.Mock).mockImplementation(
    async (args: any) => {
      const where = args?.where;
      const include = args?.include;
      const skip = args?.skip || 0;
      const take = args?.take;
      const orderBy = args?.orderBy;

      // Get all users from registry
      let filtered = Array.from(mockUserRegistry.values());

      // Apply filters
      if (where) {
        // Handle isActive filter
        if (where.isActive !== undefined) {
          filtered = filtered.filter((u) => u.isActive === where.isActive);
        }
        // Handle OR clause (search)
        if (where.OR && Array.isArray(where.OR)) {
          filtered = filtered.filter((u: any) =>
            where.OR.some((condition: any) => {
              if (condition.email?.contains) {
                const search = condition.email.contains.toLowerCase();
                return u.email?.toLowerCase().includes(search);
              }
              if (condition.displayName?.contains) {
                const search = condition.displayName.contains.toLowerCase();
                return u.displayName?.toLowerCase().includes(search);
              }
              if (condition.providerDisplayName?.contains) {
                const search = condition.providerDisplayName.contains.toLowerCase();
                return u.providerDisplayName?.toLowerCase().includes(search);
              }
              return false;
            }),
          );
        }
        // Handle simple email filter
        if (
          where.email &&
          typeof where.email === 'object' &&
          'contains' in where.email
        ) {
          const search = where.email.contains.toLowerCase();
          filtered = filtered.filter((u: any) =>
            u.email.toLowerCase().includes(search),
          );
        }
        // Handle role filter
        if (where.userRoles && 'some' in where.userRoles) {
          const roleFilter = where.userRoles.some;
          if (roleFilter?.role?.name) {
            filtered = filtered.filter((u: any) =>
              u.userRoles?.some(
                (ur: any) => ur.role.name === roleFilter.role.name,
              ),
            );
          }
        }
      }

      // Apply sorting
      if (orderBy) {
        const [sortField, sortDirection] = Object.entries(orderBy)[0] as [string, 'asc' | 'desc'];
        filtered = [...filtered].sort((a: any, b: any) => {
          const aVal = a[sortField];
          const bVal = b[sortField];
          if (aVal === null || aVal === undefined) return 1;
          if (bVal === null || bVal === undefined) return -1;

          let comparison = 0;
          if (typeof aVal === 'string' && typeof bVal === 'string') {
            comparison = aVal.localeCompare(bVal);
          } else if (aVal instanceof Date && bVal instanceof Date) {
            comparison = aVal.getTime() - bVal.getTime();
          } else {
            comparison = aVal > bVal ? 1 : aVal < bVal ? -1 : 0;
          }

          return sortDirection === 'desc' ? -comparison : comparison;
        });
      }

      // Apply pagination
      let paginated = filtered;
      if (skip || take) {
        paginated = filtered.slice(skip, take ? skip + take : undefined);
      }

      return paginated;
    },
  );

  // Mock user.count
  (prismaMock.user.count as jest.Mock).mockImplementation(async (args: any) => {
    const where = args?.where;

    // Get all users from registry
    let filtered = Array.from(mockUserRegistry.values());

    if (where) {
      // Handle isActive filter
      if (where.isActive !== undefined) {
        filtered = filtered.filter((u) => u.isActive === where.isActive);
      }
      // Handle OR clause (search)
      if (where.OR && Array.isArray(where.OR)) {
        filtered = filtered.filter((u: any) =>
          where.OR.some((condition: any) => {
            if (condition.email?.contains) {
              const search = condition.email.contains.toLowerCase();
              return u.email?.toLowerCase().includes(search);
            }
            if (condition.displayName?.contains) {
              const search = condition.displayName.contains.toLowerCase();
              return u.displayName?.toLowerCase().includes(search);
            }
            if (condition.providerDisplayName?.contains) {
              const search = condition.providerDisplayName.contains.toLowerCase();
              return u.providerDisplayName?.toLowerCase().includes(search);
            }
            return false;
          }),
        );
      }
      // Handle simple email filter
      if (
        where.email &&
        typeof where.email === 'object' &&
        'contains' in where.email
      ) {
        const search = where.email.contains.toLowerCase();
        filtered = filtered.filter((u: any) =>
          u.email.toLowerCase().includes(search),
        );
      }
      // Handle role filter
      if (where.userRoles && 'some' in where.userRoles) {
        const roleFilter = where.userRoles.some;
        if (roleFilter?.role?.name) {
          filtered = filtered.filter((u: any) =>
            u.userRoles?.some(
              (ur: any) => ur.role.name === roleFilter.role.name,
            ),
          );
        }
      }
    }

    return filtered.length;
  });

  return mockUsers.map((user: any) => ({
    id: user.id,
    email: user.email,
    roles: user.userRoles?.map((ur: any) => ur.role.name) || [],
  }));
}

// ============================================================================
// Allowlist Mocks
// ============================================================================

export function setupMockAllowedEmail(
  options: CreateMockAllowedEmailOptions,
): void {
  const allowedEmail = createMockAllowedEmail(options);

  (prismaMock.allowedEmail.findUnique as jest.Mock).mockImplementation(
    async ({ where }: any) => {
      if (where.email === allowedEmail.email || where.id === allowedEmail.id) {
        return allowedEmail;
      }
      return null;
    },
  );

  (prismaMock.allowedEmail.create as jest.Mock).mockResolvedValue(allowedEmail);
}

export function setupMockAllowedEmailList(
  allowedEmails: Array<CreateMockAllowedEmailOptions>,
): void {
  const mockEmails = allowedEmails.map((opts) => createMockAllowedEmail(opts));

  (prismaMock.allowedEmail.findMany as jest.Mock).mockImplementation(
    async (args: any) => {
      const where = args?.where;
      let filtered = mockEmails;

      // Apply filters
      if (where) {
        if (
          where.email &&
          typeof where.email === 'object' &&
          'contains' in where.email
        ) {
          const search = where.email.contains.toLowerCase();
          filtered = filtered.filter((e) => e.email.includes(search));
        }
        if (where.claimedById === null) {
          // Status: pending
          filtered = filtered.filter((e) => e.claimedById === null);
        } else if (where.claimedById && 'not' in where.claimedById) {
          // Status: claimed
          filtered = filtered.filter((e) => e.claimedById !== null);
        }
      }

      return filtered;
    },
  );

  (prismaMock.allowedEmail.count as jest.Mock).mockImplementation(
    async (args: any) => {
      const where = args?.where;
      let filtered = mockEmails;

      if (where) {
        if (
          where.email &&
          typeof where.email === 'object' &&
          'contains' in where.email
        ) {
          const search = where.email.contains.toLowerCase();
          filtered = filtered.filter((e) => e.email.includes(search));
        }
        if (where.claimedById === null) {
          filtered = filtered.filter((e) => e.claimedById === null);
        } else if (where.claimedById && 'not' in where.claimedById) {
          filtered = filtered.filter((e) => e.claimedById !== null);
        }
      }

      return filtered.length;
    },
  );
}

// ============================================================================
// System Settings Mocks
// ============================================================================

export function setupMockSystemSettings(): void {
  const settings = createMockSystemSettings();

  (prismaMock.systemSettings.findUnique as jest.Mock).mockResolvedValue(
    settings,
  );
  (prismaMock.systemSettings.upsert as jest.Mock).mockImplementation(
    async ({ create, update }: any) => {
      return { ...settings, ...create, ...update };
    },
  );
  (prismaMock.systemSettings.update as jest.Mock).mockImplementation(
    async ({ data }: any) => {
      return { ...settings, ...data };
    },
  );
}

// ============================================================================
// Audit Event Mocks
// ============================================================================

export function setupMockAuditEvents(): void {
  const auditEvents: any[] = [];

  (prismaMock.auditEvent.create as jest.Mock).mockImplementation(
    async ({ data }: any) => {
      const event = createMockAuditEvent(data);
      auditEvents.push(event);
      return event;
    },
  );

  (prismaMock.auditEvent.findFirst as jest.Mock).mockImplementation(
    async ({ where }: any) => {
      if (!where) return auditEvents[0] || null;

      return (
        auditEvents.find((event) => {
          let matches = true;
          if (where.actorUserId)
            matches &&= event.actorUserId === where.actorUserId;
          if (where.action) matches &&= event.action === where.action;
          if (where.targetId) matches &&= event.targetId === where.targetId;
          return matches;
        }) || null
      );
    },
  );
}

// ============================================================================
// User Settings Mocks
// ============================================================================

// Registry for user settings
let mockUserSettingsRegistry: Map<string, any> = new Map();

/**
 * Setup user settings mocks that work with the user registry
 */
export function setupUserSettingsMocks(): void {
  mockUserSettingsRegistry = new Map();

  (prismaMock.userSettings.findUnique as jest.Mock).mockImplementation(
    async ({ where }: any) => {
      // Check custom settings first
      if (mockUserSettingsRegistry.has(where.userId)) {
        return mockUserSettingsRegistry.get(where.userId);
      }
      // Fall back to user's default settings from registry
      const user = mockUserRegistry.get(where.userId);
      if (user?.userSettings) {
        return user.userSettings;
      }
      // Create default settings
      return {
        id: `settings-${where.userId}`,
        userId: where.userId,
        value: { theme: 'system' },
        version: 1,
        updatedAt: new Date(),
      };
    },
  );

  (prismaMock.userSettings.update as jest.Mock).mockImplementation(
    async ({ where, data }: any) => {
      const existing = mockUserSettingsRegistry.get(where.userId) || {
        id: `settings-${where.userId}`,
        userId: where.userId,
        value: { theme: 'system' },
        version: 1,
        updatedAt: new Date(),
      };
      const updated = {
        ...existing,
        value: data.value ?? existing.value,
        version: data.version ?? existing.version,
        updatedAt: new Date(),
      };
      mockUserSettingsRegistry.set(where.userId, updated);
      return updated;
    },
  );

  (prismaMock.userSettings.upsert as jest.Mock).mockImplementation(
    async ({ where, create, update }: any) => {
      const existing = mockUserSettingsRegistry.get(where.userId);
      if (existing) {
        const updated = { ...existing, ...update };
        mockUserSettingsRegistry.set(where.userId, updated);
        return updated;
      }
      const created = {
        id: `settings-${where.userId}`,
        userId: where.userId,
        ...create,
        updatedAt: new Date(),
      };
      mockUserSettingsRegistry.set(where.userId, created);
      return created;
    },
  );
}

/**
 * Set custom settings for a specific user
 */
export function setupMockUserSettings(userId: string, settings: any): void {
  mockUserSettingsRegistry.set(userId, {
    id: `settings-${userId}`,
    userId,
    value: settings,
    version: 1,
    updatedAt: new Date(),
  });
}

// ============================================================================
// Readiness snapshot mocks (issue #122, epic #55 / E6)
// ============================================================================

/**
 * Generic, spec-agnostic `readiness_snapshots` defaults.
 *
 * `PracticeService.completeSession` calls
 * `ReadinessService.recomputeSnapshot` synchronously on every completion
 * (readiness-model.md §7(a)) — which means EVERY existing integration spec
 * that completes a practice session now exercises this table too, whether
 * or not that spec's own concern is readiness. Without a default here,
 * `readinessSnapshot.create` (an unconfigured `mockDeep` method) resolves
 * to `undefined`, and `recomputeSnapshot` throws reading `.stage` off it.
 *
 * `readiness.integration.spec.ts` overrides `create`/`findFirst`/`findMany`/
 * `count` with its own small in-memory store, the same "generic default
 * here, a real store where the suite's own assertions need one" split
 * `progress.integration.spec.ts`'s header already documents for
 * `question_mastery`.
 */
export function setupReadinessSnapshotMocks(): void {
  (prismaMock.readinessSnapshot.findFirst as jest.Mock).mockResolvedValue(null);
  (prismaMock.readinessSnapshot.findMany as jest.Mock).mockResolvedValue([]);
  (prismaMock.readinessSnapshot.count as jest.Mock).mockResolvedValue(0);
  (prismaMock.readinessSnapshot.create as jest.Mock).mockImplementation(
    async ({ data }: any) => ({
      id: `readiness-snapshot-${Math.random().toString(36).slice(2)}`,
      createdAt: new Date(),
      narrative: null,
      narrativeGeneratedAt: null,
      ...data,
    }),
  );
}

// ============================================================================
// Daily activity mocks (issue #119, epic #56 / E7 "Habit")
// ============================================================================

/**
 * Generic, spec-agnostic `daily_activity` defaults.
 *
 * `PracticeService.recordAttempt` and `.completeSession` now accrue a day
 * through `EngagementService` on every attempt and every completion
 * (habit-streaks.md §2.1) — which means EVERY existing integration spec that
 * answers a question or completes a session touches this table too, whether or
 * not that spec's own concern is engagement.
 *
 * Accrual is wrapped so a failure can never fail the triggering action, so an
 * unconfigured `mockDeep` method would not break those suites — it would
 * merely log an error on every attempt, which is noise a reader would have to
 * learn to ignore. These defaults keep the accrual path silent and honest for
 * suites that are not asserting on it.
 *
 * `engagement.integration.spec.ts` overrides all three with a real in-memory
 * store, the same "generic default here, a real store where the suite's own
 * assertions need one" split `setupReadinessSnapshotMocks` above already
 * documents.
 */
export function setupDailyActivityMocks(): void {
  (prismaMock.dailyActivity.findMany as jest.Mock).mockResolvedValue([]);
  (prismaMock.dailyActivity.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
  (prismaMock.dailyActivity.upsert as jest.Mock).mockImplementation(
    async ({ where, create }: any) => ({
      id: `daily-activity-${Math.random().toString(36).slice(2)}`,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...where.userId_activityDate,
      ...create,
    }),
  );
}

// ============================================================================
// Mock interview mocks (issue #133, epic #57 / E8)
// ============================================================================

/**
 * Generic, spec-agnostic `mock_interviews` defaults.
 *
 * `ReadinessService.assembleEvidence` now reads this table — a real
 * `mockInterview.count` — on EVERY readiness recompute (readiness.service.ts's
 * own `interview` comment), and `PracticeService.completeSession` triggers a
 * recompute synchronously on every session completion. That means EVERY
 * existing integration spec that completes a practice session touches
 * `mock_interviews` too, whether or not that spec's own concern is interviews.
 *
 * Without a default here, `mockInterview.count` (an unconfigured `mockDeep`
 * method) resolves to `undefined`, `computeInterview`'s
 * `mockInterviewsPassed / 2` becomes `undefined / 2` — `NaN`, not a thrown
 * error — and a `NaN` component silently makes the whole weighted score `NaN`,
 * which serialises over the wire as `null`. So the symptom of a missing mock
 * here is a wrong score (`null`), not a crash — the harder kind to diagnose,
 * because nothing points at `mock_interviews` at all.
 *
 * `findFirst`/`findMany` are deliberately NOT stubbed here:
 * `EngagementService`'s own `mockInterview.findFirst` read is reached only
 * through the interview-shaped accrual key (`kind: 'interview'`), which is
 * only ever constructed when an interview attempt itself is recorded — never
 * by ordinary practice-session completion, the path every generic spec
 * exercises. A spec asserting on interview evidence itself (or on engagement
 * accrual from an interview) should override these with its own in-memory
 * store, the same "generic default here, a real store where the suite's own
 * assertions need one" split `setupReadinessSnapshotMocks` and
 * `setupDailyActivityMocks` above already document.
 */
export function setupMockInterviewMocks(): void {
  (prismaMock.mockInterview.count as jest.Mock).mockResolvedValue(0);
}

// ============================================================================
// English attempt mocks (issue #141, epic #59 / E10)
// ============================================================================

/**
 * Generic, spec-agnostic `english_attempts` default.
 *
 * `ReadinessService.collectEnglishBestOutcomesInWindow` now reads this table
 * — a real `englishAttempt.findMany` — on EVERY readiness recompute
 * (readiness.service.ts's own `english` evidence comment), and
 * `PracticeService.completeSession` triggers a recompute synchronously on
 * every session completion. That means EVERY existing integration spec that
 * completes a practice session, or otherwise reaches `GET /api/readiness`,
 * touches `english_attempts` too, whether or not that spec's own concern is
 * English.
 *
 * Without a default here, `englishAttempt.findMany` (an unconfigured
 * `mockDeep` method) resolves to `undefined`, and the
 * `for (const row of rows)` loop right after that call in
 * `collectEnglishBestOutcomesInWindow` throws `TypeError: rows is not
 * iterable` — a crash, not a wrong score, because this query's result is
 * iterated directly rather than only divided into like
 * `mockInterview.count`'s `mockInterviewsPassed / 2` above.
 *
 * A spec asserting on the `english` component itself should override this
 * with its own in-memory store, the same "generic default here, a real store
 * where the suite's own assertions need one" split `setupReadinessSnapshotMocks`,
 * `setupDailyActivityMocks` and `setupMockInterviewMocks` above already
 * document. `readiness.integration.spec.ts` does exactly that.
 */
export function setupEnglishAttemptMocks(): void {
  (prismaMock.englishAttempt.findMany as jest.Mock).mockResolvedValue([]);
}

// ============================================================================
// Complete Mock Setup
// ============================================================================

/**
 * Setup all base mocks needed for most tests
 * Call this in beforeEach() after resetPrismaMock()
 */
export function setupBaseMocks(): void {
  // Clear registries
  clearMockUserRegistry();

  // Setup base mocks
  setupRoleMocks();
  setupUserMocks();
  setupUserSettingsMocks();
  setupMockSystemSettings();
  setupMockAuditEvents();
  setupReadinessSnapshotMocks();
  setupDailyActivityMocks();
  setupMockInterviewMocks();
  setupEnglishAttemptMocks();

  // Mock transactions
  mockPrismaTransaction();

  // Mock userRole operations (used in transactions)
  (prismaMock.userRole.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });
  (prismaMock.userRole.create as jest.Mock).mockImplementation(async ({ data }: any) => ({
    userId: data.userId,
    roleId: data.roleId,
  }));
  (prismaMock.userRole.createMany as jest.Mock).mockImplementation(async ({ data }: any) => ({
    count: Array.isArray(data) ? data.length : 1,
  }));

  // Mock $connect and $disconnect
  (prismaMock.$connect as jest.Mock).mockResolvedValue(undefined);
  (prismaMock.$disconnect as jest.Mock).mockResolvedValue(undefined);
}
