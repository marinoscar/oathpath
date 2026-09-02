#!/usr/bin/env node
/**
 * Civics Content Loader Environment Helper
 *
 * Constructs DATABASE_URL from individual PostgreSQL environment variables
 * (the same formula scripts/prisma-env.js uses) and runs the civics content
 * loader (prisma/content/load-content.ts) as a standalone ts-node process.
 *
 * Why this isn't just another scripts/prisma-env.js invocation: that helper
 * always spawns `npx prisma <args>` — the content loader is not a Prisma CLI
 * subcommand, it's a sibling script in the same standalone, framework-free
 * shape as prisma/seed.ts (see that file's own header). It reuses
 * prisma-env.js's `constructDatabaseUrl` export rather than re-deriving the
 * formula a third time.
 *
 * Usage:
 *   node scripts/content-env.js
 */

const { spawn } = require('child_process');
const path = require('path');
const { constructDatabaseUrl } = require('./prisma-env');

if (process.env.NODE_ENV !== 'production') {
  try {
    const dotenv = require('dotenv');
    dotenv.config();
    const composeEnv = path.resolve(__dirname, '..', '..', '..', 'infra', 'compose', '.env');
    dotenv.config({ path: composeEnv });
  } catch (err) {
    // dotenv might not be available in production builds, that's OK
  }
}

const env = {
  ...process.env,
  DATABASE_URL: constructDatabaseUrl(),
};

const child = spawn(
  'npx',
  ['ts-node', '--project', 'prisma/tsconfig.json', 'prisma/content/load-content.ts'],
  { env, stdio: 'inherit', shell: true },
);

child.on('exit', (code) => {
  process.exit(code || 0);
});

child.on('error', (err) => {
  console.error('Failed to execute civics content loader:', err);
  process.exit(1);
});
