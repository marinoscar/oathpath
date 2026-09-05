import { Pool } from 'pg';

// =============================================================================
// db.ts — a direct Postgres connection, for the ONE class of claim the API
// cannot be trusted to make about itself (issue #114, epic #58 / E9)
// =============================================================================
//
// Every other helper in this directory deliberately goes through the API —
// `practice-questions.ts`'s own header calls that out as the house
// convention, and `mock-interview-text.spec.ts`'s report is explicit that it
// could NOT independently confirm a retention claim through the API for want
// of a route that serves it. That is normally the right restraint: asserting
// through the product's own surface is what proves the PRODUCT behaves
// correctly, not just the database underneath it.
//
// `docs/specs/voice.md` §4 makes a claim no API response can ever falsify:
// "nothing reaches `storage_objects`". A response that carries no `audio`
// field is consistent with the audio never having been stored, but it is
// EQUALLY consistent with the audio having been written to
// `storage_objects` and simply not linked back into the response the client
// happens to read. The only way to tell those two apart is to ask the table
// itself whether a row exists — which is what this file is for, and the only
// thing it is for. A future refactor that spools an upload to disk or a
// bucket "temporarily, just for debugging" would pass every other assertion
// in `voice.spec.ts` and fail only this one.
//
// -----------------------------------------------------------------------------
// CONNECTION: THE SAME FIVE VARIABLES THE API ITSELF READS
// -----------------------------------------------------------------------------
//
// `CLAUDE.md`'s Environment Variables section names `POSTGRES_HOST` /
// `_PORT` / `_USER` / `_PASSWORD` / `_DB` as the individual connection
// parameters `DATABASE_URL` is constructed from at runtime. This file reads
// the identical five, with the identical defaults `infra/compose/.env.example`
// ships (`localhost:5432`, `postgres`/`postgres`, database `oathpath`) — so
// against the dev compose stack (or an equivalent local Postgres) this needs
// no configuration of its own, and a CI environment that already has to set
// these for the API to boot sets them for this file for free.
const pool = new Pool({
  host: process.env.POSTGRES_HOST || 'localhost',
  port: Number(process.env.POSTGRES_PORT || 5432),
  user: process.env.POSTGRES_USER || 'postgres',
  password: process.env.POSTGRES_PASSWORD || 'postgres',
  database: process.env.POSTGRES_DB || 'oathpath',
  // Small and fixed: this file runs a handful of point queries per spec run,
  // never a pool a busy suite could exhaust.
  max: 4,
});

/**
 * How many `storage_objects` rows any of the given users uploaded.
 *
 * Scoped to a caller-supplied list of user ids — never a bare `SELECT
 * COUNT(*) FROM storage_objects` — so this assertion is isolated to the
 * learners THIS spec created and cannot be made to fail (or, worse, pass for
 * the wrong reason) by another spec file's own storage activity running
 * concurrently in the same database. `uploaded_by_id` is the column
 * `schema.prisma`'s `StorageObject` model maps `uploadedById` to.
 */
export async function countStorageObjectsUploadedBy(
  userIds: readonly string[],
): Promise<number> {
  if (userIds.length === 0) return 0;
  const { rows } = await pool.query<{ count: string }>(
    'SELECT COUNT(*)::int AS count FROM storage_objects WHERE uploaded_by_id = ANY($1::uuid[])',
    [userIds],
  );
  return Number(rows[0]?.count ?? 0);
}

/**
 * How many `english_attempts` rows any of the given users have, in total.
 *
 * Added for issue #149 (epic #59 / E10 "Reading and writing tests") for the
 * identical structural reason {@link countStorageObjectsUploadedBy} exists:
 * `docs/specs/english-test.md` §3 states that a low-confidence reading
 * attempt writes NOTHING — "no row, no `outcome: 'incorrect'`, nothing" — and
 * `POST /api/english/attempts`'s `misheard` response is consistent with that
 * claim without proving it. A response that omits `attemptId` is equally
 * consistent with a row having been written anyway and simply not linked
 * back into what the client happens to read. Only the table itself settles
 * it, which is what this function is for, and the only thing it is for.
 *
 * Scoped to a caller-supplied list of user ids for the same isolation reason
 * `countStorageObjectsUploadedBy` is: so this assertion cannot be made to
 * pass (or fail) by another spec file's own English practice activity
 * running concurrently in the same database.
 */
export async function countEnglishAttemptsByUser(
  userIds: readonly string[],
): Promise<number> {
  if (userIds.length === 0) return 0;
  const { rows } = await pool.query<{ count: string }>(
    'SELECT COUNT(*)::int AS count FROM english_attempts WHERE user_id = ANY($1::uuid[])',
    [userIds],
  );
  return Number(rows[0]?.count ?? 0);
}

/**
 * Release the pool's connections.
 *
 * Call once, from a top-level `test.afterAll` — an open `pg.Pool` holds live
 * TCP sockets that would otherwise keep the Playwright worker process from
 * exiting cleanly once the file's tests are done with it.
 */
export async function closeDbPool(): Promise<void> {
  await pool.end();
}
