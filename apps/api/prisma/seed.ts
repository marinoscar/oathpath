import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { loadAllCivicsContent } from './content/load-content';
import { loadEnglishContent } from './content/load-english-content';

// Prisma 7 requires a driver adapter — PrismaClient can no longer be
// instantiated with no options. The seed script is invoked as a standalone
// ts-node process (see prisma.config.ts: migrations.seed), not through
// Nest's DI container, so it can't reuse PrismaService's buildConnectionString()
// without also pulling in @nestjs/common. Every Prisma CLI invocation in this
// project (npm run prisma:*, or `npx prisma db seed` per the README) already
// guarantees DATABASE_URL is set before the CLI — and therefore this seed
// script — runs, either via scripts/prisma-env.js or an explicit export, so
// reading it directly here is sufficient and keeps the script framework-free.
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    'DATABASE_URL is not set. Run this script via `npm run prisma:seed` ' +
      '(or export DATABASE_URL) so Prisma can connect to the database.',
  );
}

const adapter = new PrismaPg(databaseUrl);
const prisma = new PrismaClient({ adapter });

// =============================================================================
// Seed Data Definitions
// =============================================================================

const ROLES = [
  {
    name: 'admin',
    description: 'Full system access - manage users, roles, and all settings',
  },
  {
    name: 'contributor',
    description: 'Standard user - can manage own settings and future features',
  },
  {
    name: 'viewer',
    description: 'Read-only access - can view content and manage own settings',
  },
] as const;

const PERMISSIONS = [
  // System settings
  { name: 'system_settings:read', description: 'Read system settings' },
  { name: 'system_settings:write', description: 'Modify system settings' },

  // User settings
  { name: 'user_settings:read', description: 'Read own user settings' },
  { name: 'user_settings:write', description: 'Modify own user settings' },

  // Users management
  { name: 'users:read', description: 'View user list and details' },
  { name: 'users:write', description: 'Modify user accounts' },

  // RBAC management
  { name: 'rbac:manage', description: 'Manage roles and permissions' },

  // Allowlist management
  { name: 'allowlist:read', description: 'View allowlisted emails' },
  { name: 'allowlist:write', description: 'Manage allowlisted emails' },

  // Storage management
  { name: 'storage:read', description: 'Read object metadata, get download URLs' },
  { name: 'storage:write', description: 'Upload, update metadata' },
  { name: 'storage:delete_any', description: 'Admin: delete any object' },
] as const;

// Role to permissions mapping
const ROLE_PERMISSIONS: Record<string, string[]> = {
  admin: [
    'system_settings:read',
    'system_settings:write',
    'user_settings:read',
    'user_settings:write',
    'users:read',
    'users:write',
    'rbac:manage',
    'allowlist:read',
    'allowlist:write',
    'storage:read',
    'storage:write',
    'storage:delete_any',
  ],
  contributor: [
    'user_settings:read',
    'user_settings:write',
    'storage:read',
    'storage:write',
  ],
  viewer: [
    'user_settings:read',
    'user_settings:write',
    'storage:read',
  ],
};

// Default system settings
const DEFAULT_SYSTEM_SETTINGS = {
  ui: {
    allowUserThemeOverride: true,
  },
  features: {},
};

// Civics test versions (docs/specs/journey-shell.md §3.1, issue #62).
//
// The senior-accommodation columns (`seniorQuestionsAsked`/
// `seniorPassThreshold`) are seeded to the same 10-asked/6-to-pass shape as
// the 2008 test for BOTH rows, mirroring the long-standing 65/20
// accommodation. For v2025, this figure is now CONFIRMED against the
// official USCIS source document M-1778 (09/25), "128 Civics Questions and
// Answers (2025 version)" — its sha256 is recorded in
// apps/api/prisma/content/civics-2025.json's provenance block — which states
// the 65/20 applicant answers 10 of the 20 asterisked questions and must get
// at least 6 (60%) correct. The v2008 row's 10/6 figure is NOT verified by
// that source, since it covers only the 2025 test; it remains a
// design-level placeholder until checked against 2008-era USCIS guidance.
const CIVICS_TEST_VERSIONS = [
  {
    code: 'v2008',
    label: '2008 Civics Test',
    questionsAsked: 10,
    passThreshold: 6,
    seniorQuestionsAsked: 10,
    seniorPassThreshold: 6,
  },
  {
    code: 'v2025',
    label: '2025 Civics Test',
    questionsAsked: 20,
    passThreshold: 12,
    seniorQuestionsAsked: 10,
    seniorPassThreshold: 6,
  },
] as const;

// =============================================================================
// Seed Functions
// =============================================================================

async function seedRoles() {
  console.log('Seeding roles...');

  for (const role of ROLES) {
    await prisma.role.upsert({
      where: { name: role.name },
      update: { description: role.description },
      create: role,
    });
  }

  console.log(`✓ Seeded ${ROLES.length} roles`);
}

async function seedPermissions() {
  console.log('Seeding permissions...');

  for (const permission of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { name: permission.name },
      update: { description: permission.description },
      create: permission,
    });
  }

  console.log(`✓ Seeded ${PERMISSIONS.length} permissions`);
}

async function seedRolePermissions() {
  console.log('Seeding role-permission mappings...');

  let count = 0;

  for (const [roleName, permissionNames] of Object.entries(ROLE_PERMISSIONS)) {
    const role = await prisma.role.findUnique({ where: { name: roleName } });
    if (!role) continue;

    for (const permissionName of permissionNames) {
      const permission = await prisma.permission.findUnique({
        where: { name: permissionName },
      });
      if (!permission) continue;

      await prisma.rolePermission.upsert({
        where: {
          roleId_permissionId: {
            roleId: role.id,
            permissionId: permission.id,
          },
        },
        update: {},
        create: {
          roleId: role.id,
          permissionId: permission.id,
        },
      });
      count++;
    }
  }

  console.log(`✓ Seeded ${count} role-permission mappings`);
}

async function seedSystemSettings() {
  console.log('Seeding system settings...');

  await prisma.systemSettings.upsert({
    where: { key: 'global' },
    update: {}, // Don't overwrite existing settings
    create: {
      key: 'global',
      value: DEFAULT_SYSTEM_SETTINGS,
      version: 1,
    },
  });

  console.log('✓ Seeded default system settings');
}

async function seedCivicsTestVersions() {
  console.log('Seeding civics test versions...');

  for (const version of CIVICS_TEST_VERSIONS) {
    const { code, ...fields } = version;
    await prisma.civicsTestVersion.upsert({
      where: { code },
      update: fields,
      create: version,
    });
  }

  console.log(`✓ Seeded ${CIVICS_TEST_VERSIONS.length} civics test versions`);
}

async function seedInitialAdminAllowlist() {
  console.log('Seeding initial admin allowlist...');

  const initialAdminEmail = process.env.INITIAL_ADMIN_EMAIL;
  if (initialAdminEmail) {
    await prisma.allowedEmail.upsert({
      where: { email: initialAdminEmail.toLowerCase() },
      update: {},
      create: {
        email: initialAdminEmail.toLowerCase(),
        notes: 'Initial admin (auto-seeded)',
      },
    });
    console.log(`✓ Added ${initialAdminEmail} to allowlist`);
  } else {
    console.log('⊘ INITIAL_ADMIN_EMAIL not set, skipping allowlist seed');
  }
}

// =============================================================================
// Main Seed Function
// =============================================================================

async function main() {
  console.log('Starting database seed...\n');

  await seedRoles();
  await seedPermissions();
  await seedRolePermissions();
  await seedSystemSettings();
  await seedCivicsTestVersions();
  await seedInitialAdminAllowlist();

  // Content is data, not code (docs/specs/civics-content.md §7): it lives in
  // apps/api/prisma/content/*.json, not in this file, and is loaded here as
  // a sibling step, idempotently, on every seed run.
  console.log('Loading civics content...');
  await loadAllCivicsContent(prisma);

  // A second, sibling content-loading step (docs/specs/english-test.md
  // §1.3) — its own file, its own validator, its own idempotency contract,
  // not folded into loadAllCivicsContent's function.
  console.log('Loading English content...');
  await loadEnglishContent(prisma);

  console.log('\n✓ Database seeding completed successfully');
}

main()
  .catch((e) => {
    console.error('Seed error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
