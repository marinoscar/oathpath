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

/**
 * What a chip or a verdict line says, and which palette role it wears.
 *
 * =============================================================================
 * THE VERDICT IS ONE LABEL. THERE IS NO SECOND SENTENCE (#358, epic #345)
 * =============================================================================
 *
 * This interface used to carry a `detail` string as well — "Not a match" plus
 * "That doesn't match an accepted answer." — and the two were rendered one
 * above the other on every graded attempt. That is the SAME INFORMATION TWICE,
 * in two registers, and E14's coach reaction had to sit sandwiched between
 * them: the flattest line on the screen immediately above the one line the
 * learner is actually meant to read, and another immediately below.
 *
 * `detail` was therefore deleted rather than demoted. A restatement that is
 * merely made smaller is still a restatement, and the space it occupies is the
 * space the coach needs. The chip's `label` states the verdict, once, in text
 * as well as colour — which is what a learner who cannot tell a red chip from
 * a green one relies on.
 */
export interface OutcomeDisplay {
  /** User-facing, and deliberately plain. Never "FAIL", never an emoji. */
  label: string;
  color: 'success' | 'error' | 'warning' | 'default';
}

const OUTCOMES: Record<string, OutcomeDisplay> = {
  correct: { label: 'Correct', color: 'success' },
  // LIVE SINCE E4, and this comment used to say the opposite. It was written
  // when E3's exact matcher was the only grading path — binary by
  // construction, so `partial` was declared by the API and reachable by
  // nothing. E4's semantic grader changed that: `GRADING_VERDICTS`
  // (`apps/api/src/practice/grading.ts`) offers the model `partial`, and
  // `PracticeService.grade` persists the verdict it returns. A learner on a
  // deployment with a `grader` model bound can see this today.
  //
  // It IS still dark on a deployment with no AI configured at all, which is
  // the honest half of the original claim and the only half that survives
  // (issue #352 asked the question directly rather than leaving it ambiguous).
  partial: { label: 'Partly right', color: 'warning' },
  // NOT "wrong". The matcher compares text; it does not judge the learner, and
  // a near-miss it could not recognise is exactly what the self-mark exists
  // for.
  incorrect: { label: 'Not a match', color: 'error' },
  skipped: { label: 'Skipped', color: 'default' },
};

/** The wording and colour for one recorded outcome. Never throws. */
export function outcomeDisplay(outcome: string): OutcomeDisplay {
  return (
    // Says only what is certainly true. A newer server's outcome value means
    // something this build has never heard of, and guessing at it would be the
    // one thing worse than saying nothing.
    OUTCOMES[outcome] ?? { label: 'Recorded', color: 'default' }
  );
}

/**
 * The note explaining WHO decided an outcome — or null when nobody needs
 * telling.
 *
 * `exact` returns null on purpose: the deterministic matcher is the ordinary
 * case, and labelling every ordinary row "graded automatically" is noise that
 * makes the two rows that genuinely differ harder to see.
 *
 * SINCE #358 THIS IS PROGRESSIVE, NOT STACKED. `AiFeedbackCard` renders it
 * behind a "How this was graded" disclosure rather than as a third fixed line
 * under the verdict. The string is unchanged and so is the rule about when it
 * is null; what changed is that a learner who wants to know who decided has to
 * ask, instead of every learner reading it whether they wanted it or not.
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
