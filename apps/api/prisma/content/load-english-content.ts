// English content loader (E10, epic #59 / issue #130) — docs/specs/
// english-test.md §1.3.
//
// Loads apps/api/prisma/content/english-vocabulary-{reading,writing}.json
// and english-sentences.json into `english_sentences`, idempotently — a
// SIBLING of `load-content.ts` in POSTURE (standalone, framework-free
// script; one `$transaction`; value-compare before every write so a
// same-content re-run writes nothing) but not folded into that file's own
// function, per §1.3's own reasoning: the two content domains share a
// loading posture but not a schema, a validator, or a set of tables, so
// combining them would tangle two independent lifecycles the way
// docs/specs/civics-content.md §7 already argues against for civics content
// itself. Invoked from apps/api/prisma/seed.ts as a second, sibling call
// alongside `loadAllCivicsContent(prisma)`.
//
// `new Date()` is never called directly here for a value this loader itself
// invents — per CLAUDE.md's "Using the Clock" rule, any such value must go
// through the injected `Clock`, the same way `load-content.ts` does for its
// own `verifiedAt` fallback. This loader, unlike that one, invents no
// timestamp at all: the only date column it writes, `retrievedAt`, is always
// parsed straight from the content file's own `provenance.retrievedAt`
// (`parseFileDate` below), so there is no "now" for a `Clock` to supply and
// none is injected here. A future field on this loader that DOES need "now"
// must inject `Clock` the same way, never reach for a bare `new Date()`.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Prisma, PrismaClient } from '@prisma/client';
import {
  deriveVocabTags,
  expandVocabulary,
  tokenizeForVocabularyMatch,
  validateEnglishContent,
  type EnglishSentencesFile,
  type VocabularyFile,
} from './english-vocabulary';

// Prisma's own generated transaction-client type covers `.englishSentence`
// on both a bare `PrismaClient` and the `tx` handle `$transaction` hands its
// callback — the identical alias `load-content.ts` declares for the same
// reason.
type Db = PrismaClient | Prisma.TransactionClient;

const CONTENT_DIR = __dirname;

const READING_VOCAB_FILE = 'english-vocabulary-reading.json';
const WRITING_VOCAB_FILE = 'english-vocabulary-writing.json';
const SENTENCES_FILE = 'english-sentences.json';

export interface LoadEnglishContentOptions {
  /** Directory to read the three content files from. Defaults to this file's own directory. */
  contentDir?: string;
  /**
   * Environment the unverified-content gate reads (`ENGLISH_ALLOW_UNVERIFIED_CONTENT`,
   * `NODE_ENV`). Defaults to `process.env`; injectable for the same reason
   * `LoadCivicsContentOptions.env` is — so a test can prove the gate's decision
   * without mutating the real process environment.
   */
  env?: NodeJS.ProcessEnv;
}

// -----------------------------------------------------------------------------
// The unverified-content gate (issue #261).
//
// The civics twin of this is `assertTrustedForLoad` in load-content.ts, and
// this is deliberately the same mechanism with the same env-var convention:
// a content file's verification status is a claim a human signed off on, and
// a claim nothing reads is not enforcement. Before #261 the English status
// fields were exactly that — strings the loader never looked at.
//
// Refuses to load when a file's status is not one this repository trusts,
// UNLESS ENGLISH_ALLOW_UNVERIFIED_CONTENT=true — and refuses unconditionally
// when NODE_ENV=production, regardless of that flag, so an inherited or
// copied .env cannot put unreviewed sentences in front of a learner.
//
// TWO DIFFERENCES FROM THE CIVICS GATE, BOTH DELIBERATE:
//
// 1. A refusal here is NOT turned into a per-file skip. `loadAllCivicsContent`
//    can skip one refused version file and load another because civics
//    versions are independent bank files; the three English files are ONE
//    bundle — the sentences are validated against those exact two vocabulary
//    lists — so "load the rest" is not a state that exists. A refusal
//    therefore throws before the transaction opens and the database is left
//    byte-for-byte unchanged, which is already this loader's own posture for
//    a validation error (see `loadEnglishContent` below).
//
// 2. The sentence file has TWO trusted statuses, and the vocabulary files
//    one. A vocabulary file is a TRANSCRIPTION of an official list, so it
//    answers the identical question civics content does and takes the
//    identical single token. A sentence file records a COMPOSITION decision
//    (docs/specs/english-test.md §1.1: USCIS publishes no sentence list to
//    transcribe), and this repository has shipped two honest answers to it:
//    HUMAN_COMPOSED_AND_REVIEWED for sentences a human actually wrote — what
//    §1.2 requires of any sentence added from here on — and HUMAN_VERIFIED
//    for sentences produced some other way and then verified by a human, which
//    is what english-sentences.json's own note now records. Both name a human
//    sign-off; they differ in who composed. Anything else — a model draft, an
//    unreviewed import, a status field somebody forgot to fill in — is refused.
// -----------------------------------------------------------------------------

export class UnverifiedEnglishContentError extends Error {
  constructor(
    message: string,
    public readonly fileLabel: string,
    public readonly status: string,
  ) {
    super(message);
    this.name = 'UnverifiedEnglishContentError';
  }
}

/** A transcription of an official USCIS vocabulary list — the civics token, for the civics reason. */
export const TRUSTED_VOCABULARY_STATUSES: readonly string[] = ['HUMAN_VERIFIED'];

/** A composition decision — see difference 2 in the header comment above. */
export const TRUSTED_SENTENCES_STATUSES: readonly string[] = [
  'HUMAN_VERIFIED',
  'HUMAN_COMPOSED_AND_REVIEWED',
];

export function assertEnglishTrustedForLoad(
  fileLabel: string,
  status: string,
  trustedStatuses: readonly string[],
  env: NodeJS.ProcessEnv,
): void {
  if (trustedStatuses.includes(status)) {
    return;
  }

  const expected = trustedStatuses.join(' or ');

  if (env.NODE_ENV === 'production') {
    throw new UnverifiedEnglishContentError(
      `Refusing to load ${fileLabel}: verification status is "${status}", not ${expected}. ` +
        `NODE_ENV=production never loads unverified English content, regardless of ` +
        `ENGLISH_ALLOW_UNVERIFIED_CONTENT.`,
      fileLabel,
      status,
    );
  }

  if (env.ENGLISH_ALLOW_UNVERIFIED_CONTENT !== 'true') {
    throw new UnverifiedEnglishContentError(
      `Refusing to load ${fileLabel}: verification status is "${status}", not ${expected}. ` +
        `Set ENGLISH_ALLOW_UNVERIFIED_CONTENT=true to load unverified content in dev/CI (never ` +
        `set this in production).`,
      fileLabel,
      status,
    );
  }

  console.warn(
    `[english-loader] WARNING: ${fileLabel} is not verified (status=${status}); loading anyway ` +
      `because ENGLISH_ALLOW_UNVERIFIED_CONTENT=true.`,
  );
}

export interface LoadEnglishContentSummary {
  sentencesWritten: number;
  sentencesUnchanged: number;
}

function loadJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

// A file's dates are YYYY-MM-DD (a calendar day, not an instant), anchored
// at UTC midnight so the same string always parses to the same instant
// regardless of the host's local timezone — identical to `load-content.ts`'s
// own `parseFileDate`.
function parseFileDate(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00.000Z`);
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * One sentence's upsert: value-compare before every write, so re-running the
 * loader against unchanged content writes NOTHING — no row's `updated_at`
 * moves just because a deploy happened to run, the identical idempotency
 * contract `load-content.ts` gives the civics loader (docs/specs/
 * civics-content.md §7).
 */
async function upsertSentence(
  tx: Db,
  sentencesVersion: string,
  entry: {
    kind: 'reading' | 'writing';
    ordinal: number;
    text: string;
    vocabTags: string[];
    sourceUrl: string;
    retrievedAt: Date;
    contentSha256: string;
  },
  counters: LoadEnglishContentSummary,
): Promise<void> {
  const existing = await tx.englishSentence.findUnique({
    where: {
      kind_version_ordinal: {
        kind: entry.kind,
        version: sentencesVersion,
        ordinal: entry.ordinal,
      },
    },
  });

  const data = {
    kind: entry.kind,
    version: sentencesVersion,
    ordinal: entry.ordinal,
    text: entry.text,
    vocabTags: entry.vocabTags,
    sourceUrl: entry.sourceUrl,
    retrievedAt: entry.retrievedAt,
    contentSha256: entry.contentSha256,
  };

  if (!existing) {
    await tx.englishSentence.create({ data });
    counters.sentencesWritten++;
    return;
  }

  const unchanged =
    existing.text === data.text &&
    existing.sourceUrl === data.sourceUrl &&
    existing.contentSha256 === data.contentSha256 &&
    existing.retrievedAt.getTime() === data.retrievedAt.getTime() &&
    arraysEqual(existing.vocabTags, data.vocabTags);

  if (unchanged) {
    counters.sentencesUnchanged++;
    return;
  }

  await tx.englishSentence.update({ where: { id: existing.id }, data });
  counters.sentencesWritten++;
}

/**
 * Entry point used by seed.ts.
 *
 * Loads the two vocabulary files and the sentence file, validates (§1.4),
 * and THROWS on any `error` issue rather than seeding bad content — the
 * identical "run the validator before writing anything" posture
 * `load-content.ts`'s own `loadVersion` takes, so a structurally invalid
 * file aborts before any transaction opens and the database is left
 * byte-for-byte unchanged.
 *
 * Then runs the unverified-content gate (issue #261) over all three files,
 * which throws `UnverifiedEnglishContentError` — also before the transaction,
 * also leaving the database untouched — for content this repository has not
 * marked as human-signed-off. See the gate's own header comment above.
 */
export async function loadEnglishContent(
  prisma: PrismaClient,
  options: LoadEnglishContentOptions = {},
): Promise<LoadEnglishContentSummary> {
  const contentDir = options.contentDir ?? CONTENT_DIR;
  const env = options.env ?? process.env;

  const readingVocabulary = loadJsonFile<VocabularyFile>(join(contentDir, READING_VOCAB_FILE));
  const writingVocabulary = loadJsonFile<VocabularyFile>(join(contentDir, WRITING_VOCAB_FILE));
  const sentencesFile = loadJsonFile<EnglishSentencesFile>(join(contentDir, SENTENCES_FILE));

  const issues = validateEnglishContent(readingVocabulary, writingVocabulary, sentencesFile);
  const errors = issues.filter((issue) => issue.severity === 'error');
  if (errors.length > 0) {
    const details = errors.map((issue) => `  [${issue.code}] ${issue.message}`).join('\n');
    throw new Error(
      `English content validation FAILED; the database has been left unchanged:\n${details}`,
    );
  }

  // The trust gate (issue #261), after validation and before anything is
  // written — the same order load-content.ts's `loadVersion` uses, so a file
  // that is both structurally broken AND unverified reports the structural
  // problem, which is the more actionable of the two. All three files are
  // checked: a verified sentence list composed against an unverified word
  // list is not verified content.
  assertEnglishTrustedForLoad(
    READING_VOCAB_FILE,
    readingVocabulary.provenance.transcription.status,
    TRUSTED_VOCABULARY_STATUSES,
    env,
  );
  assertEnglishTrustedForLoad(
    WRITING_VOCAB_FILE,
    writingVocabulary.provenance.transcription.status,
    TRUSTED_VOCABULARY_STATUSES,
    env,
  );
  assertEnglishTrustedForLoad(
    SENTENCES_FILE,
    sentencesFile.composition.status,
    TRUSTED_SENTENCES_STATUSES,
    env,
  );

  const readingAllowed = expandVocabulary(readingVocabulary);
  const writingAllowed = expandVocabulary(writingVocabulary);

  const counters: LoadEnglishContentSummary = { sentencesWritten: 0, sentencesUnchanged: 0 };

  // One transaction for the whole load (§1.3): an interrupted run rolls
  // back to nothing, and a re-run converges from either a clean or a
  // fully-committed prior state.
  await prisma.$transaction(async (tx) => {
    for (const sentence of sentencesFile.sentences) {
      const allowed = sentence.kind === 'reading' ? readingAllowed : writingAllowed;
      const tokens = tokenizeForVocabularyMatch(sentence.text);
      const vocabTags = deriveVocabTags(tokens, allowed);

      await upsertSentence(
        tx,
        sentencesFile.version,
        {
          kind: sentence.kind,
          ordinal: sentence.ordinal,
          text: sentence.text,
          vocabTags,
          sourceUrl: sentence.provenance.sourceUrl,
          retrievedAt: parseFileDate(sentence.provenance.retrievedAt),
          contentSha256: sentence.provenance.sha256,
        },
        counters,
      );
    }
  });

  console.log(
    `[english-loader] sentences: ${counters.sentencesWritten} written / ${counters.sentencesUnchanged} unchanged.`,
  );

  return counters;
}
