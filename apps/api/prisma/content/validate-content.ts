// Civics content validator (issue #101, epic #51).
//
// Validates the shape of a civics content file (docs/specs/civics-content.md
// §6, §6.1, §7) — the JSON that will eventually feed the loader (#106) that
// populates `civics_categories` / `civics_questions` / `civics_answers`.
// This script loads and checks the *file*; it never touches a database.
//
// Two things this validator is deliberately built to keep apart, per the
// task it was written for:
//   1. STRUCTURAL rules — always enforced, on every file, regardless of
//      trust status. A bad shape (a dangling category reference, a
//      malformed provenance block, a state-scope question missing a state)
//      is a bug in the file, whether or not the file is finished.
//   2. CONTENT COMPLETENESS rules (exact question count, senior-eligible
//      count) — enforced as real failures for a file that claims to be
//      finished, but downgraded to a loudly-reported KNOWN GAP for a file
//      honestly marked `AWAITING_SOURCE` (docs/specs/civics-content.md §6:
//      "an empty, honestly-labelled bank is correct; a fabricated one is
//      not"). Otherwise CI would be red forever on a gap only a human with
//      the official PDF can close.
//
// `--strict` is the release gate (see runCli below): it additionally fails
// on ANY file not `HUMAN_VERIFIED` and on any known gap, because nothing
// short of that status is safe to actually serve to a learner.
//
// Deliberately outside `apps/api/prisma/tsconfig.json`'s sibling `src/`
// tree and outside the app's own `tsconfig.json` `include` — same posture
// `prisma/seed.ts` already takes (a standalone, framework-free script), so
// it is invoked via `npm run content:validate` (ts-node, prisma/tsconfig.json),
// not through Nest's DI container or the app's own `tsc --noEmit`.

import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

// Reused, not re-typed: the same 56-code list `learner_profiles.state_code`
// and `civics_answers.state_code` both have to admit (docs/specs/
// civics-content.md §2.3). Importing it — rather than hand-copying the 56
// codes here — is what keeps a state-scope question's required answer set
// from silently drifting away from the one real source of that list.
import { US_STATE_AND_TERRITORY_CODES } from '../../src/common/constants/us-states.constants';

// -----------------------------------------------------------------------------
// Content file shape
// -----------------------------------------------------------------------------

export const TRANSCRIPTION_STATUSES = [
  'UNVERIFIED_MODEL_DRAFT',
  'HUMAN_VERIFIED',
  'AWAITING_SOURCE',
] as const;

export type TranscriptionStatus = (typeof TRANSCRIPTION_STATUSES)[number];

export const DYNAMIC_SCOPES = ['none', 'national', 'state'] as const;
export type DynamicScope = (typeof DYNAMIC_SCOPES)[number];

export interface ContentProvenance {
  sourceUrl: string;
  retrievedAt: string;
  sha256: string | null;
  transcription: {
    status: TranscriptionStatus;
    warning?: string;
  };
}

export interface ContentCategory {
  code: string;
  section: string;
  name: string;
  sortOrder: number;
}

export interface ContentAnswer {
  sort: number;
  stateCode: string | null;
  text: string;
  sourceNote: string;
  verifiedAt: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface ContentQuestion {
  number: number;
  categoryCode: string;
  prompt: string;
  seniorEligible: boolean;
  dynamicScope: DynamicScope;
  answers: ContentAnswer[];
}

export interface ContentFile {
  testVersionCode: string;
  label: string;
  provenance: ContentProvenance;
  expected: {
    questionCount: number;
    seniorEligibleCount: number | null;
  };
  categories: ContentCategory[];
  questions: ContentQuestion[];
}

// -----------------------------------------------------------------------------
// Validation result shape
// -----------------------------------------------------------------------------

export type IssueSeverity = 'error' | 'known_gap' | 'warning';

export interface ValidationIssue {
  severity: IssueSeverity;
  code: string;
  message: string;
}

export interface ValidationReport {
  file: string;
  testVersionCode: string | undefined;
  transcriptionStatus: TranscriptionStatus | undefined;
  issues: ValidationIssue[];
  errors: ValidationIssue[];
  knownGaps: ValidationIssue[];
  warnings: ValidationIssue[];
  /** True once `errors` is empty — independent of --strict. */
  structurallyValid: boolean;
  /** True only for a file fit to ship to production (HUMAN_VERIFIED, no gaps, no errors). */
  releaseReady: boolean;
}

const STATE_CODES = new Set(US_STATE_AND_TERRITORY_CODES);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function err(code: string, message: string): ValidationIssue {
  return { severity: 'error', code, message };
}
function gap(code: string, message: string): ValidationIssue {
  return { severity: 'known_gap', code, message };
}
function warn(code: string, message: string): ValidationIssue {
  return { severity: 'warning', code, message };
}

// -----------------------------------------------------------------------------
// Core validation (pure — no fs, no process.exit — this is what tests call)
// -----------------------------------------------------------------------------

export function validateContent(
  file: ContentFile,
  opts: { fileLabel?: string } = {},
): ValidationReport {
  const issues: ValidationIssue[] = [];
  const fileLabel = opts.fileLabel ?? file.testVersionCode ?? '(unknown file)';

  const status = file.provenance?.transcription?.status;
  const isAwaitingSource = status === 'AWAITING_SOURCE';

  // ---- Provenance completeness — ALWAYS enforced, regardless of status ----
  const prov = file.provenance;
  if (!prov) {
    issues.push(err('provenance.missing', `${fileLabel}: no provenance block at all.`));
  } else {
    if (!prov.sourceUrl || typeof prov.sourceUrl !== 'string' || prov.sourceUrl.trim() === '') {
      issues.push(err('provenance.sourceUrl', `${fileLabel}: provenance.sourceUrl is missing or empty.`));
    }
    if (!prov.retrievedAt || !DATE_RE.test(prov.retrievedAt)) {
      issues.push(
        err(
          'provenance.retrievedAt',
          `${fileLabel}: provenance.retrievedAt must be a YYYY-MM-DD date, got ${JSON.stringify(prov.retrievedAt)}.`,
        ),
      );
    }
    if (!('sha256' in prov)) {
      issues.push(err('provenance.sha256', `${fileLabel}: provenance.sha256 key is missing (must be present, null allowed).`));
    }
    if (!prov.transcription || !TRANSCRIPTION_STATUSES.includes(prov.transcription.status as TranscriptionStatus)) {
      issues.push(
        err(
          'provenance.transcription.status',
          `${fileLabel}: provenance.transcription.status must be one of ${TRANSCRIPTION_STATUSES.join(', ')}, got ${JSON.stringify(
            prov.transcription?.status,
          )}.`,
        ),
      );
    }
    if (status !== 'HUMAN_VERIFIED' && !prov.transcription?.warning) {
      issues.push(
        warn(
          'provenance.transcription.warning.missing',
          `${fileLabel}: a file not marked HUMAN_VERIFIED should carry a transcription.warning explaining what is unverified.`,
        ),
      );
    }
  }

  // ---- Categories: codes must be unique ----
  const categoryCodes = new Set<string>();
  for (const cat of file.categories ?? []) {
    if (categoryCodes.has(cat.code)) {
      issues.push(err('category.duplicateCode', `${fileLabel}: duplicate category code "${cat.code}".`));
    }
    categoryCodes.add(cat.code);
  }

  // ---- Per-question structural rules — always enforced ----
  const seenNumbers = new Map<number, number>();
  let seniorEligibleCount = 0;

  for (const [index, q] of (file.questions ?? []).entries()) {
    const label = `${fileLabel} Q${q?.number ?? `#${index}`}`;

    // Unique numbers within the version.
    const priorCount = seenNumbers.get(q.number) ?? 0;
    seenNumbers.set(q.number, priorCount + 1);
    if (priorCount === 1) {
      // Report once, when the second occurrence is found, not once per dupe.
      issues.push(err('question.duplicateNumber', `${fileLabel}: question number ${q.number} is used more than once.`));
    }

    // categoryCode resolves to a declared category.
    if (!categoryCodes.has(q.categoryCode)) {
      issues.push(err('question.unknownCategory', `${label}: categoryCode "${q.categoryCode}" does not match any declared category.`));
    }

    // dynamicScope is one of none|national|state.
    if (!DYNAMIC_SCOPES.includes(q.dynamicScope)) {
      issues.push(err('question.invalidDynamicScope', `${label}: dynamicScope "${q.dynamicScope}" is not one of ${DYNAMIC_SCOPES.join('|')}.`));
    }

    // Every question has at least one answer.
    const answers = q.answers ?? [];
    if (answers.length === 0) {
      issues.push(err('question.noAnswers', `${label}: has no answers.`));
    }

    if (q.seniorEligible) {
      seniorEligibleCount += 1;
    }

    if (q.dynamicScope === 'national') {
      // Exactly one answer slot: sort 0, stateCode null.
      if (answers.length !== 1) {
        issues.push(
          err('question.national.slotCount', `${label}: dynamicScope "national" must have exactly one answer slot, found ${answers.length}.`),
        );
      } else {
        const [a] = answers;
        if (a.sort !== 0 || a.stateCode !== null) {
          issues.push(
            err(
              'question.national.badSlot',
              `${label}: dynamicScope "national" answer must be { sort: 0, stateCode: null }, got { sort: ${a.sort}, stateCode: ${JSON.stringify(
                a.stateCode,
              )} }.`,
            ),
          );
        }
      }
    } else if (q.dynamicScope === 'state') {
      // Exactly one slot per declared state/territory (sort 0), no gaps, no dupes.
      const seenStateCodes = new Map<string, number>();
      const offSlot: ContentAnswer[] = [];
      for (const a of answers) {
        if (a.sort !== 0) {
          offSlot.push(a);
          continue;
        }
        if (a.stateCode == null) {
          issues.push(err('question.state.nullStateCode', `${label}: dynamicScope "state" answer at sort 0 has a null stateCode.`));
          continue;
        }
        seenStateCodes.set(a.stateCode, (seenStateCodes.get(a.stateCode) ?? 0) + 1);
      }
      if (offSlot.length > 0) {
        issues.push(
          err(
            'question.state.extraSlot',
            `${label}: dynamicScope "state" must use only sort 0, found ${offSlot.length} answer(s) with a different sort value (an extra, un-conflicting slot the DB's partial unique index would not catch — docs/specs/civics-content.md §3.3).`,
          ),
        );
      }
      const missing = US_STATE_AND_TERRITORY_CODES.filter((code) => !seenStateCodes.has(code));
      if (missing.length > 0) {
        issues.push(
          err(
            'question.state.missingStates',
            `${label}: dynamicScope "state" is missing ${missing.length} state/territory code(s): ${missing.join(', ')}.`,
          ),
        );
      }
      const unknown = [...seenStateCodes.keys()].filter((code) => !STATE_CODES.has(code));
      if (unknown.length > 0) {
        issues.push(err('question.state.unknownStateCode', `${label}: unknown state/territory code(s): ${unknown.join(', ')}.`));
      }
      const dupes = [...seenStateCodes.entries()].filter(([, count]) => count > 1).map(([code]) => code);
      if (dupes.length > 0) {
        issues.push(err('question.state.duplicateStateCode', `${label}: duplicate state/territory slot(s): ${dupes.join(', ')}.`));
      }
    } else if (q.dynamicScope === 'none') {
      // No stateCode on any answer.
      const withState = answers.filter((a) => a.stateCode != null);
      if (withState.length > 0) {
        issues.push(
          err(
            'question.none.hasStateCode',
            `${label}: dynamicScope "none" must not set stateCode on any answer, but ${withState.length} did.`,
          ),
        );
      }
    }
  }

  // ---- Count rules: exact question count, senior-eligible count ----
  const actualCount = (file.questions ?? []).length;
  const expectedCount = file.expected?.questionCount;
  if (typeof expectedCount === 'number' && actualCount !== expectedCount) {
    const message = `${fileLabel}: expected exactly ${expectedCount} questions, found ${actualCount}.`;
    issues.push(isAwaitingSource ? gap('count.questionCount', message) : err('count.questionCount', message));
  }

  const expectedSenior = file.expected?.seniorEligibleCount;
  if (typeof expectedSenior === 'number' && seniorEligibleCount !== expectedSenior) {
    const message = `${fileLabel}: expected exactly ${expectedSenior} senior-eligible (65/20) questions, found ${seniorEligibleCount}.`;
    issues.push(isAwaitingSource ? gap('count.seniorEligible', message) : err('count.seniorEligible', message));
  }

  // ---- Strict-gate marker: not HUMAN_VERIFIED is itself a (release) gap ----
  if (status && status !== 'HUMAN_VERIFIED') {
    issues.push(
      gap(
        'trust.notHumanVerified',
        `${fileLabel}: transcription.status is "${status}", not HUMAN_VERIFIED — not safe to release.`,
      ),
    );
  }

  const errors = issues.filter((i) => i.severity === 'error');
  const knownGaps = issues.filter((i) => i.severity === 'known_gap');
  const warnings = issues.filter((i) => i.severity === 'warning');

  return {
    file: fileLabel,
    testVersionCode: file.testVersionCode,
    transcriptionStatus: status,
    issues,
    errors,
    knownGaps,
    warnings,
    structurallyValid: errors.length === 0,
    releaseReady: errors.length === 0 && knownGaps.length === 0,
  };
}

export function loadContentFile(path: string): ContentFile {
  const raw = readFileSync(path, 'utf8');
  return JSON.parse(raw) as ContentFile;
}

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------

const CONTENT_DIR = __dirname;

// This validator checks CIVICS content against the civics schema, and only
// that. Since E10 (epic #59 / issue #130) this same directory also holds
// `english-*.json`, whose shape is entirely different — three files with no
// `testVersionCode`, no `questions`, and categories keyed on `tag` rather
// than `code` — so globbing every `.json` here reported 15 fabricated
// `category.duplicateCode` errors and exited 1 on an untouched checkout
// (issue #258).
//
// Scoped by NAME (`civics-*.json`), never by shape. A shape sniffer would
// make a genuinely broken civics file — a bad merge, a truncated write, a
// renamed key — look like "not civics content" and disappear from this
// report silently, which is precisely the failure a validator exists to
// prevent; with a name rule, that same file still gets validated and still
// fails loudly. The cost is the mirror case: a civics file renamed off the
// prefix would stop being checked, so `runCli` prints every file it skipped
// and why, and a directory with no civics file at all is still a hard error.
// `load-content.ts`'s own discovery answers the same question from the other
// side (it excludes `english-`), for the reason stated there: its temp-dir
// tests load fixture files that are civics content under other names.
const CIVICS_FILE_PREFIX = 'civics-';

function discoverContentFiles(dir: string): { civics: string[]; skipped: string[] } {
  const json = readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort();

  return {
    civics: json.filter((name) => name.startsWith(CIVICS_FILE_PREFIX)).map((name) => join(dir, name)),
    skipped: json.filter((name) => !name.startsWith(CIVICS_FILE_PREFIX)),
  };
}

function printReport(report: ValidationReport): void {
  const trustBadge =
    report.transcriptionStatus === 'HUMAN_VERIFIED'
      ? '[HUMAN_VERIFIED]'
      : report.transcriptionStatus === 'AWAITING_SOURCE'
        ? '[AWAITING_SOURCE — NOT TRUSTWORTHY, NOT LOADABLE]'
        : '[UNVERIFIED_MODEL_DRAFT — NOT TRUSTWORTHY, DO NOT USE IN PRODUCTION]';

  console.log(`\n=== ${report.file} ${trustBadge} ===`);
  if (report.errors.length === 0 && report.knownGaps.length === 0 && report.warnings.length === 0) {
    console.log('  OK — no structural errors, no known gaps, no warnings.');
  }
  for (const e of report.errors) {
    console.log(`  ERROR      [${e.code}] ${e.message}`);
  }
  for (const g of report.knownGaps) {
    console.log(`  KNOWN GAP  [${g.code}] ${g.message}`);
  }
  for (const w of report.warnings) {
    console.log(`  WARNING    [${w.code}] ${w.message}`);
  }
}

export function runCli(argv: string[] = process.argv.slice(2)): number {
  const strict = argv.includes('--strict');
  const { civics: files, skipped } = discoverContentFiles(CONTENT_DIR);

  if (files.length === 0) {
    console.error(`No ${CIVICS_FILE_PREFIX}*.json content files found in ${CONTENT_DIR}`);
    return 1;
  }

  console.log(`Civics content validator — mode: ${strict ? '--strict (release gate)' : 'default'}`);
  console.log(`Checking ${files.length} file(s) in ${CONTENT_DIR}: ${files.map((f) => basename(f)).join(', ')}`);
  if (skipped.length > 0) {
    // Named, never silent: a skip this validator does not print is a skip
    // nobody can notice (issue #258).
    console.log(
      `Not checked (not ${CIVICS_FILE_PREFIX}*.json — another content domain, with its own ` +
        `validator): ${skipped.join(', ')}`,
    );
  }

  const reports = files.map((f) => validateContent(loadContentFile(f), { fileLabel: basename(f) }));
  reports.forEach(printReport);

  const totalErrors = reports.reduce((n, r) => n + r.errors.length, 0);
  const totalGaps = reports.reduce((n, r) => n + r.knownGaps.length, 0);
  const totalWarnings = reports.reduce((n, r) => n + r.warnings.length, 0);

  console.log('\n=== Summary ===');
  for (const r of reports) {
    console.log(
      `  ${r.file}: status=${r.transcriptionStatus ?? 'UNKNOWN'} errors=${r.errors.length} knownGaps=${r.knownGaps.length} warnings=${r.warnings.length} releaseReady=${r.releaseReady}`,
    );
  }
  console.log(`  TOTAL: errors=${totalErrors} knownGaps=${totalGaps} warnings=${totalWarnings}`);

  const failed = strict ? totalErrors > 0 || totalGaps > 0 : totalErrors > 0;

  if (failed) {
    console.log(
      strict
        ? '\nFAILED (--strict): every file must be HUMAN_VERIFIED with zero known gaps to pass the release gate.'
        : '\nFAILED: one or more structural errors were found (see ERROR lines above).',
    );
  } else {
    console.log(
      strict
        ? '\nPASSED (--strict).'
        : '\nPASSED (default mode) — known gaps, if any, are reported above but do not fail this mode. Run with --strict before a production release.',
    );
  }

  return failed ? 1 : 0;
}

if (require.main === module) {
  process.exitCode = runCli();
}
