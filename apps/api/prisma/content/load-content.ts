// Civics content loader (issue #106, epic #51).
//
// Loads apps/api/prisma/content/*.json into civics_categories /
// civics_questions / civics_answers, idempotently — docs/specs/
// civics-content.md §4 (dynamic-answer lifecycle) and §7 (content is data,
// not code). Invoked from apps/api/prisma/seed.ts (`loadAllCivicsContent`)
// and, standalone, via `npm run content:load` — a sibling of
// `validate-content.ts` in shape and location, so it shares that script's
// `prisma/tsconfig.json` inclusion and framework-free posture (no Nest DI;
// see seed.ts's own header for why).
//
// Every write in this file goes through one `prisma.$transaction` per
// version (docs/specs/civics-content.md §7's "transaction per version"), and
// every insert/update is preceded by a value comparison so that re-running
// the loader against unchanged content writes NOTHING — no row's
// `updated_at` moves just because a deploy happened to run.
//
// `new Date()` is never called directly here — every timestamp this loader
// invents (never one read from the file) goes through the injected `Clock`,
// per CLAUDE.md's "Using the Clock" rule and docs/specs/civics-content.md
// §10's restatement of it for this epic specifically.

import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { PrismaClient, Prisma } from '@prisma/client';
import { Clock } from '../../src/common/clock/clock';
import {
  type ContentAnswer,
  type ContentFile,
  loadContentFile,
  validateContent,
} from './validate-content';

// Prisma's own generated transaction-client type covers every method this
// file calls (`.civicsCategory`, `.civicsQuestion`, `.civicsAnswer`,
// `.civicsTestVersion`) on both a bare `PrismaClient` and the `tx` handle
// `$transaction` hands its callback — so one alias serves both call sites.
type Db = PrismaClient | Prisma.TransactionClient;

const CONTENT_DIR = __dirname;

export interface LoadCivicsContentOptions {
  /** Directory to discover `*.json` content files in. Defaults to this file's own directory (siblings of `validate-content.ts`). */
  contentDir?: string;
  /** Injected for testability — defaults to a real `Clock`. */
  clock?: Clock;
  /** Injected for testability — defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

export interface VersionLoadSummary {
  file: string;
  testVersionCode: string | undefined;
  skipped: boolean;
  skipReason?: string;
  categoriesWritten: number;
  categoriesUnchanged: number;
  questionsWritten: number;
  questionsUnchanged: number;
  answersInserted: number;
  answersClosed: number;
  answersUnchanged: number;
  contentHash: string;
  contentHashChanged: boolean;
}

interface Counters {
  categoriesWritten: number;
  categoriesUnchanged: number;
  questionsWritten: number;
  questionsUnchanged: number;
  answersInserted: number;
  answersClosed: number;
  answersUnchanged: number;
}

function freshCounters(): Counters {
  return {
    categoriesWritten: 0,
    categoriesUnchanged: 0,
    questionsWritten: 0,
    questionsUnchanged: 0,
    answersInserted: 0,
    answersClosed: 0,
    answersUnchanged: 0,
  };
}

// -----------------------------------------------------------------------------
// content_hash — a sha256 over the file's own CANONICALIZED content
// (docs/specs/civics-content.md §7), so a whitespace-only re-save of the JSON
// does not change the hash but any real content edit does.
// -----------------------------------------------------------------------------

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = canonicalize((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
}

export function computeContentHash(file: ContentFile): string {
  const canonical = JSON.stringify(canonicalize(file));
  return createHash('sha256').update(canonical).digest('hex');
}

// -----------------------------------------------------------------------------
// The unverified-content gate.
//
// Refuses to load a file whose provenance.transcription.status is not
// HUMAN_VERIFIED, UNLESS CIVICS_ALLOW_UNVERIFIED_CONTENT=true — and refuses
// unconditionally when NODE_ENV=production, regardless of that flag. This is
// what makes docs/specs/civics-content.md §6's human-verification rule
// enforced code, not a comment: dev/CI sets the env var to work with the
// #101 draft content; production never does, and even if it did, the
// NODE_ENV check makes production refuse anyway.
//
// AWAITING_SOURCE-with-zero-questions is NOT routed through this gate at
// all — see `loadVersion`'s skip-clean branch below, which runs first and
// never reaches this function for that case, because there is nothing to
// "load" from an intentionally empty placeholder.
//
// The refusal is thrown as `UnverifiedContentError`, a distinct type, so that
// `loadAllCivicsContent` can catch this specific decision — and only this
// decision — to skip the offending file and continue to the next one
// (issue #216). Any other error (a malformed file, a DB failure, a
// constraint violation) is a plain `Error` and still propagates and aborts
// the whole run.
// -----------------------------------------------------------------------------

export class UnverifiedContentError extends Error {
  /**
   * Filled in by `loadVersion` immediately after catching this error (it
   * alone knows the file's testVersionCode/contentHash at the point the gate
   * runs) so that `loadAllCivicsContent`'s catch site can build a skip
   * summary shaped like `loadVersion`'s own AWAITING_SOURCE branch without
   * re-reading or re-hashing the file.
   */
  public testVersionCode?: string;
  public contentHash?: string;

  constructor(
    message: string,
    public readonly fileLabel: string,
    public readonly status: string,
  ) {
    super(message);
    this.name = 'UnverifiedContentError';
  }
}

export function assertTrustedForLoad(
  file: ContentFile,
  fileLabel: string,
  env: NodeJS.ProcessEnv,
): void {
  const status = file.provenance.transcription.status;
  if (status === 'HUMAN_VERIFIED') {
    return;
  }

  if (env.NODE_ENV === 'production') {
    throw new UnverifiedContentError(
      `Refusing to load ${fileLabel}: provenance.transcription.status is "${status}", not ` +
        `HUMAN_VERIFIED. NODE_ENV=production never loads unverified civics content, regardless ` +
        `of CIVICS_ALLOW_UNVERIFIED_CONTENT.`,
      fileLabel,
      status,
    );
  }

  if (env.CIVICS_ALLOW_UNVERIFIED_CONTENT !== 'true') {
    throw new UnverifiedContentError(
      `Refusing to load ${fileLabel}: provenance.transcription.status is "${status}", not ` +
        `HUMAN_VERIFIED. Set CIVICS_ALLOW_UNVERIFIED_CONTENT=true to load unverified content in ` +
        `dev/CI (never set this in production).`,
      fileLabel,
      status,
    );
  }

  console.warn(
    `[civics-loader] WARNING: ${fileLabel} is not HUMAN_VERIFIED (status=${status}); loading ` +
      `anyway because CIVICS_ALLOW_UNVERIFIED_CONTENT=true.`,
  );
}

// A file's dates are YYYY-MM-DD (validate-content.ts's DATE_RE) — a calendar
// day, not an instant. Anchored at UTC midnight so the same string always
// parses to the same instant regardless of the host's local timezone.
function parseFileDate(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00.000Z`);
}

// -----------------------------------------------------------------------------
// One answer SLOT — (questionId, stateCode, sort) — per docs/specs/
// civics-content.md §3.1/§7. Never an in-place edit: an unchanged slot is
// left alone, an unseen slot is inserted, and a changed slot is closed then
// reopened in the same transaction the caller already holds.
// -----------------------------------------------------------------------------

async function loadAnswerSlot(
  tx: Db,
  questionId: string,
  a: ContentAnswer,
  clock: Clock,
  counters: Counters,
): Promise<void> {
  const stateCode = a.stateCode;
  const fileEffectiveFrom = parseFileDate(a.effectiveFrom);
  const fileEffectiveTo = a.effectiveTo ? parseFileDate(a.effectiveTo) : null;
  // The column is NOT NULL; the file's verifiedAt is nullable (an
  // UNVERIFIED_MODEL_DRAFT file has no human verification date to give at
  // all). Falling back to the load instant is not a claim that a human
  // verified this text — it merely satisfies the column, and content in
  // that state is refused outside dev/CI by the gate above regardless.
  const verifiedAt = a.verifiedAt ? parseFileDate(a.verifiedAt) : clock.now();

  if (fileEffectiveTo !== null) {
    // The file is directly declaring an already-closed historical row
    // (backfilling history), not "the current state of this slot" — the
    // shipped content files never do this today (every declared answer is
    // open), but the slot model supports it, so it is handled here rather
    // than assumed away. Idempotent on an exact match of every field a
    // historical row is defined by.
    const existing = await tx.civicsAnswer.findFirst({
      where: {
        questionId,
        sort: a.sort,
        stateCode,
        effectiveFrom: fileEffectiveFrom,
        effectiveTo: fileEffectiveTo,
        text: a.text,
      },
    });
    if (existing) {
      counters.answersUnchanged++;
      return;
    }
    await tx.civicsAnswer.create({
      data: {
        questionId,
        sort: a.sort,
        stateCode,
        text: a.text,
        sourceNote: a.sourceNote,
        verifiedAt,
        effectiveFrom: fileEffectiveFrom,
        effectiveTo: fileEffectiveTo,
      },
    });
    counters.answersInserted++;
    return;
  }

  // The common case: the file declares this slot's CURRENT (open) answer.
  const openRow = await tx.civicsAnswer.findFirst({
    where: { questionId, sort: a.sort, stateCode, effectiveTo: null },
  });

  if (!openRow) {
    // Nothing to close — a first-ever load of this slot.
    await tx.civicsAnswer.create({
      data: {
        questionId,
        sort: a.sort,
        stateCode,
        text: a.text,
        sourceNote: a.sourceNote,
        verifiedAt,
        effectiveFrom: fileEffectiveFrom,
        effectiveTo: null,
      },
    });
    counters.answersInserted++;
    return;
  }

  // §7: compare text and sourceNote only. verifiedAt/effectiveFrom moving
  // with no text change is not a correction and must not touch the row —
  // that is what makes a same-content re-run a true no-op.
  const unchanged = openRow.text === a.text && openRow.sourceNote === a.sourceNote;
  if (unchanged) {
    counters.answersUnchanged++;
    return;
  }

  // §4's close-then-open transaction, never an in-place UPDATE of `text`.
  // The close date is the NEW row's real-world effectiveFrom (the worked
  // example in §4.1 closes the old Speaker's row on the new Speaker's
  // swearing-in date), not Clock.now() — a load only reaches for the clock
  // when the content itself has no more specific date to give (verifiedAt
  // above).
  await tx.civicsAnswer.update({
    where: { id: openRow.id },
    data: { effectiveTo: fileEffectiveFrom },
  });
  await tx.civicsAnswer.create({
    data: {
      questionId,
      sort: a.sort,
      stateCode,
      text: a.text,
      sourceNote: a.sourceNote,
      verifiedAt,
      effectiveFrom: fileEffectiveFrom,
      effectiveTo: null,
    },
  });
  counters.answersClosed++;
  counters.answersInserted++;
}

// -----------------------------------------------------------------------------
// content_hash stamping — only written when it actually differs, so a
// same-content re-run does not touch civics_test_versions.updated_at either.
// -----------------------------------------------------------------------------

export async function stampContentHash(tx: Db, testVersionCode: string, hash: string): Promise<boolean> {
  const version = await tx.civicsTestVersion.findUnique({ where: { code: testVersionCode } });
  if (!version) {
    throw new Error(
      `Unknown test version code "${testVersionCode}" — no matching civics_test_versions row. ` +
        `Seed civics_test_versions (seedCivicsTestVersions in seed.ts) before loading content.`,
    );
  }
  if (version.contentHash === hash) {
    return false;
  }
  await tx.civicsTestVersion.update({ where: { code: testVersionCode }, data: { contentHash: hash } });
  return true;
}

// -----------------------------------------------------------------------------
// One version's file.
// -----------------------------------------------------------------------------

async function loadVersion(
  prisma: PrismaClient,
  filePath: string,
  clock: Clock,
  env: NodeJS.ProcessEnv,
): Promise<VersionLoadSummary> {
  const fileLabel = basename(filePath);
  const file = loadContentFile(filePath);

  // Run the validator BEFORE writing anything. A structurally invalid file
  // aborts here, before any transaction opens, so the database is left
  // byte-for-byte unchanged.
  const report = validateContent(file, { fileLabel });
  if (!report.structurallyValid) {
    const details = report.errors.map((e) => `  [${e.code}] ${e.message}`).join('\n');
    throw new Error(
      `Content validation FAILED for ${fileLabel}; the database has been left unchanged:\n${details}`,
    );
  }
  for (const gap of report.knownGaps) {
    console.log(`[civics-loader] ${fileLabel}: KNOWN GAP [${gap.code}] ${gap.message}`);
  }

  const contentHash = computeContentHash(file);
  const testVersionCode = file.testVersionCode;
  const status = file.provenance.transcription.status;

  // A file honestly marked AWAITING_SOURCE with zero questions (civics-2025
  // today) is a known content gap, not an error — skip cleanly, log why, and
  // do not run it through the trust gate at all (there is nothing to trust
  // or distrust in an intentionally empty bank). content_hash is still
  // stamped: it is a fingerprint of the file on disk, not a claim about
  // grade-worthy content, and it lets an environment tell one placeholder
  // revision apart from another.
  if (status === 'AWAITING_SOURCE' && file.questions.length === 0) {
    console.log(
      `[civics-loader] SKIPPING ${fileLabel} (${testVersionCode}): AWAITING_SOURCE with zero ` +
        `questions — an honest, known content gap (docs/specs/civics-content.md §6), not an error.`,
    );
    const contentHashChanged = await prisma.$transaction((tx) => stampContentHash(tx, testVersionCode, contentHash));
    return {
      file: fileLabel,
      testVersionCode,
      skipped: true,
      skipReason: 'AWAITING_SOURCE with zero questions',
      ...freshCounters(),
      contentHash,
      contentHashChanged,
    };
  }

  try {
    assertTrustedForLoad(file, fileLabel, env);
  } catch (err) {
    if (err instanceof UnverifiedContentError) {
      // Attach what only this function knows, so the catch in
      // `loadAllCivicsContent` can build a full skip summary from the error
      // alone — see the class doc comment above.
      err.testVersionCode = testVersionCode;
      err.contentHash = contentHash;
    }
    throw err;
  }

  const counters = freshCounters();
  let contentHashChanged = false;

  // One transaction per version (docs/specs/civics-content.md §7): a load
  // interrupted mid-version rolls back to nothing for that version, and a
  // re-run converges from either a clean or a fully-committed prior state —
  // there is no partially-written middle state to reconcile.
  await prisma.$transaction(async (tx) => {
    const categoryIdByCode = new Map<string, string>();

    for (const cat of file.categories) {
      const existing = await tx.civicsCategory.findUnique({
        where: { testVersionCode_code: { testVersionCode, code: cat.code } },
      });
      if (!existing) {
        const created = await tx.civicsCategory.create({
          data: {
            testVersionCode,
            code: cat.code,
            section: cat.section,
            name: cat.name,
            sortOrder: cat.sortOrder,
          },
        });
        categoryIdByCode.set(cat.code, created.id);
        counters.categoriesWritten++;
        continue;
      }
      categoryIdByCode.set(cat.code, existing.id);
      const changed =
        existing.section !== cat.section || existing.name !== cat.name || existing.sortOrder !== cat.sortOrder;
      if (!changed) {
        counters.categoriesUnchanged++;
        continue;
      }
      await tx.civicsCategory.update({
        where: { id: existing.id },
        data: { section: cat.section, name: cat.name, sortOrder: cat.sortOrder },
      });
      counters.categoriesWritten++;
    }

    for (const q of file.questions) {
      // The validator already confirmed every categoryCode resolves.
      const categoryId = categoryIdByCode.get(q.categoryCode) as string;

      const existing = await tx.civicsQuestion.findUnique({
        where: { testVersionCode_number: { testVersionCode, number: q.number } },
      });

      let questionId: string;
      if (!existing) {
        const created = await tx.civicsQuestion.create({
          data: {
            testVersionCode,
            number: q.number,
            categoryId,
            prompt: q.prompt,
            seniorEligible: q.seniorEligible,
            dynamicScope: q.dynamicScope,
          },
        });
        questionId = created.id;
        counters.questionsWritten++;
      } else {
        questionId = existing.id;
        const changed =
          existing.categoryId !== categoryId ||
          existing.prompt !== q.prompt ||
          existing.seniorEligible !== q.seniorEligible ||
          existing.dynamicScope !== q.dynamicScope;
        if (changed) {
          await tx.civicsQuestion.update({
            where: { id: existing.id },
            data: {
              categoryId,
              prompt: q.prompt,
              seniorEligible: q.seniorEligible,
              dynamicScope: q.dynamicScope,
            },
          });
          counters.questionsWritten++;
        } else {
          counters.questionsUnchanged++;
        }
      }

      for (const a of q.answers) {
        await loadAnswerSlot(tx, questionId, a, clock, counters);
      }
    }

    contentHashChanged = await stampContentHash(tx, testVersionCode, contentHash);
  });

  return {
    file: fileLabel,
    testVersionCode,
    skipped: false,
    ...counters,
    contentHash,
    contentHashChanged,
  };
}

function logSummary(s: VersionLoadSummary): void {
  if (s.skipped) {
    console.log(`[civics-loader] ${s.file}: skipped (${s.skipReason}). contentHash=${s.contentHash.slice(0, 12)}… changed=${s.contentHashChanged}`);
    return;
  }
  console.log(
    `[civics-loader] ${s.file} (${s.testVersionCode}): categories ${s.categoriesWritten} written / ` +
      `${s.categoriesUnchanged} unchanged; questions ${s.questionsWritten} written / ` +
      `${s.questionsUnchanged} unchanged; answers ${s.answersInserted} inserted ` +
      `(${s.answersClosed} of those closing a prior row) / ${s.answersUnchanged} unchanged; ` +
      `contentHash=${s.contentHash.slice(0, 12)}… changed=${s.contentHashChanged}`,
  );
}

// -----------------------------------------------------------------------------
// Entry point used by seed.ts, and by the standalone CLI below.
// -----------------------------------------------------------------------------

export async function loadAllCivicsContent(
  prisma: PrismaClient,
  options: LoadCivicsContentOptions = {},
): Promise<VersionLoadSummary[]> {
  const contentDir = options.contentDir ?? CONTENT_DIR;
  const clock = options.clock ?? new Clock();
  const env = options.env ?? process.env;

  const files = readdirSync(contentDir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => join(contentDir, name));

  const summaries: VersionLoadSummary[] = [];
  for (const filePath of files) {
    try {
      const summary = await loadVersion(prisma, filePath, clock, env);
      logSummary(summary);
      summaries.push(summary);
    } catch (err) {
      // Only the trust gate's own refusal is turned into a per-file skip.
      // Everything else — a malformed file, a DB failure, a constraint
      // violation — propagates and aborts the whole run, unchanged from
      // before #216.
      if (!(err instanceof UnverifiedContentError)) {
        throw err;
      }

      const testVersionCode = err.testVersionCode;
      const contentHash = err.contentHash;
      // Short, because it is repeated on the per-file line and again in the
      // CLI's closing SUMMARY. The full explanation is logged once, below.
      const skipReason = `refused: not HUMAN_VERIFIED (status=${err.status})`;

      // Loud and unmissable: a silent skip here would be worse than the old
      // abort-the-whole-run behaviour it replaces (issue #216). `err.message`
      // already names the file, the status and the governing rule, so it is
      // the whole explanation and is not restated around it.
      console.error(`[civics-loader] SKIPPED — ${err.message}`);

      let contentHashChanged = false;
      if (testVersionCode && contentHash) {
        contentHashChanged = await prisma.$transaction((tx) =>
          stampContentHash(tx, testVersionCode, contentHash),
        );
      }

      const summary: VersionLoadSummary = {
        file: err.fileLabel,
        testVersionCode,
        skipped: true,
        skipReason,
        ...freshCounters(),
        contentHash: contentHash ?? '',
        contentHashChanged,
      };
      logSummary(summary);
      summaries.push(summary);
    }
  }
  return summaries;
}

// -----------------------------------------------------------------------------
// CLI — `npm run content:load`. A standalone, framework-free process, the
// same posture as prisma/seed.ts and prisma/content/validate-content.ts.
// -----------------------------------------------------------------------------

if (require.main === module) {
  void (async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error(
        'DATABASE_URL is not set. Run this script via `npm run content:load` (or export ' +
          'DATABASE_URL) so Prisma can connect to the database.',
      );
    }
    const { PrismaClient: RuntimePrismaClient } = await import('@prisma/client');
    const { PrismaPg } = await import('@prisma/adapter-pg');
    const adapter = new PrismaPg(databaseUrl);
    const prisma = new RuntimePrismaClient({ adapter });
    try {
      const summaries = await loadAllCivicsContent(prisma);
      const loaded = summaries.filter((s) => !s.skipped);
      const skipped = summaries.filter((s) => s.skipped);

      const loadedList = loaded.map((s) => s.file).join(', ') || '(none)';
      const skippedList = skipped.map((s) => `${s.file} [${s.skipReason}]`).join(', ') || '(none)';
      console.log(`[civics-loader] SUMMARY: loaded: ${loadedList}; skipped: ${skippedList}`);

      if (loaded.length === 0) {
        // Every file was skipped or refused — this deployment would have NO
        // civics content at all, which is a genuinely broken deploy, not a
        // partial one. Distinct from the per-file skip above, which is
        // expected in a mixed-verification directory (issue #216).
        console.error(
          '[civics-loader] FAILED: no civics content version was loaded (every file was skipped ' +
            'or refused). This deployment has no civics content.',
        );
        process.exitCode = 1;
      } else {
        console.log('[civics-loader] Done.');
      }
    } finally {
      await prisma.$disconnect();
    }
  })().catch((e: unknown) => {
    console.error('[civics-loader] FAILED:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
