/**
 * How a practice verdict is worded and coloured — in ONE file.
 *
 * Issues #76 and #79, epic #52. Three surfaces render an outcome (the session
 * screen's verdict, the summary's per-question list, and the recent-sessions
 * band's counts), and three inline `outcome === 'correct' ? … : …` expressions
 * is how two of them end up disagreeing about what `skipped` is called or
 * which colour a `partial` is — the same one-named-file argument
 * `components/civics/verifiedAt.ts` makes for its own single formatter.
 *
 * =============================================================================
 * EVERY LOOKUP HERE FALLS BACK. NONE OF THEM INDEXES A `Record` AND HOPES.
 * =============================================================================
 *
 * `PracticeOutcome`, `PracticeGradingMethod` and `PracticeSessionKind` are
 * closed unions in TypeScript and OPEN sets on the wire: the API already
 * declares `partial` (E4's semantic near-miss), `ai` (E4's grader) and
 * `review`/`weak`/`mixed` (E5's scheduler) as values it can produce before
 * anything in this epic produces them, and a browser holding an older bundle
 * will meet them the day their producer ships. A total `Record` lookup returns
 * `undefined` there, and `undefined.label` is a blank screen where a session
 * summary should be.
 *
 * So each function takes a plain `string`, and each ends in a fallback that is
 * honest rather than clever: an unrecognised outcome renders as "Recorded",
 * which claims nothing about whether the learner was right.
 *
 * =============================================================================
 * COLOURS ARE PALETTE ROLES, NEVER HEX
 * =============================================================================
 *
 * `success` / `error` / `warning` / `default` are MUI palette roles, so the
 * dark theme is a re-render rather than a second design. A literal `#2e7d32`
 * here would render "correctly" in every jsdom test — jsdom performs no layout
 * and resolves no palette — and be unreadable in a real dark-theme browser.
 */

/** What a chip or a verdict line says, and which palette role it wears. */
export interface OutcomeDisplay {
  /** User-facing, and deliberately plain. Never "FAIL", never an emoji. */
  label: string;
  color: 'success' | 'error' | 'warning' | 'default';
  /**
   * The one-line explanation under a verdict, in `VISION.md`'s tone: never
   * congratulatory, never scolding, and never implying the learner should have
   * known better.
   */
  detail: string;
}

const OUTCOMES: Record<string, OutcomeDisplay> = {
  correct: {
    label: 'Correct',
    color: 'success',
    detail: 'That matches an accepted answer.',
  },
  // Declared by the API and unreachable from E3's grading path — exact match
  // plus normalisation is binary by construction. It is handled here anyway,
  // because the day E4's semantic grader produces one, this file is not the
  // place anybody will remember to look.
  partial: {
    label: 'Partly right',
    color: 'warning',
    detail: 'Part of that matches an accepted answer.',
  },
  incorrect: {
    label: 'Not a match',
    color: 'error',
    // NOT "wrong". The matcher compares text; it does not judge the learner,
    // and a near-miss it could not recognise is exactly what the self-mark
    // exists for.
    detail: 'That doesn’t match an accepted answer.',
  },
  skipped: {
    label: 'Skipped',
    color: 'default',
    detail: 'You moved on without answering this one.',
  },
};

/** The wording and colour for one recorded outcome. Never throws. */
export function outcomeDisplay(outcome: string): OutcomeDisplay {
  return (
    OUTCOMES[outcome] ?? {
      label: 'Recorded',
      color: 'default',
      // Says only what is certainly true. A newer server's outcome value means
      // something this build has never heard of, and guessing at it would be
      // the one thing worse than saying nothing.
      detail: 'This answer was recorded.',
    }
  );
}

/**
 * The note beside an outcome explaining WHO decided it — or null when nobody
 * needs telling.
 *
 * `exact` returns null on purpose: the deterministic matcher is the ordinary
 * case, and labelling every ordinary row "graded automatically" is noise that
 * makes the two rows that genuinely differ harder to see.
 */
export function gradingMethodNote(method: string): string | null {
  if (method === 'self') return 'You marked this one correct yourself.';
  if (method === 'ai') return 'Graded by the assistant.';
  return null;
}

const SESSION_KINDS: Record<string, string> = {
  quick: 'Quick 5',
  category: 'By category',
  // E5's three, named here for the same reason the outcomes above are: a
  // history row for a session kind this build cannot name is still a row a
  // learner is entitled to read.
  review: 'Review',
  weak: 'Weak spots',
  mixed: 'Mixed practice',
};

/** What a session kind is called on screen. Never throws. */
export function sessionKindLabel(kind: string): string {
  return SESSION_KINDS[kind] ?? 'Practice';
}

const SESSION_STATUSES: Record<string, string> = {
  in_progress: 'In progress',
  completed: 'Completed',
  // Deliberately NOT "abandoned" on screen. The database calls it that because
  // the row needs a name; a learner who started a second session did not
  // abandon anything, and telling them they did is a judgement the product has
  // no business making.
  abandoned: 'Left unfinished',
};

export function sessionStatusLabel(status: string): string {
  return SESSION_STATUSES[status] ?? 'Recorded';
}

/**
 * A session's start instant as a date and time the learner recognises.
 *
 * In the BROWSER'S OWN ZONE, which is the opposite of `formatVerifiedAt`'s
 * deliberate UTC — and the difference is the point. `verifiedAt` is a
 * provenance claim about a calendar day, so it must read the same everywhere.
 * `startedAt` is a moment the learner personally lived through, so it must read
 * as the clock on their wall said at the time.
 *
 * Returns null for anything unparseable, so a caller renders NOTHING rather
 * than the string `Invalid Date`.
 */
export function formatSessionDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

/**
 * A duration in whole minutes and seconds, or null when there is nothing
 * honest to say.
 *
 * Null in, null out — and that is load-bearing rather than defensive.
 * `totalDurationMs` is null, never 0, when no attempt reported a duration
 * (`practice-sessions.md` §2.2), and rendering "0s" for it would claim the
 * learner answered five questions instantly.
 */
export function formatDuration(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) {
    return null;
  }
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}
