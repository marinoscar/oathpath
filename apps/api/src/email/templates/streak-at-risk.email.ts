import { html, plainText, renderLayout } from './layout';
import {
  TRANSACTIONAL_EMAIL_HEADERS,
  type RenderedEmail,
} from './email-template.types';

// =============================================================================
// "Your streak is still yours today" — `streak.at_risk` (epic #56 / E7)
// =============================================================================
//
// `docs/specs/habit-streaks.md` §5.3. THE ONE MESSAGE OF THE THREE WHOSE EVENT
// IS `defaultEnabled: false`, because it is the one that references something
// the learner could lose. A learner who wants this nudge asks for it; nobody
// is handed a countdown on their own consistency by default.
//
// -----------------------------------------------------------------------------
// THE FORBIDDEN SHAPES, LISTED, BECAUSE THIS IS WHERE THEY WOULD BE WRITTEN
// -----------------------------------------------------------------------------
//
// §5.3 states them with the examples this template is checked against, and
// `streak-at-risk.email.spec.ts` asserts the rendered output against each:
//
//   * NO EXCLAMATION-STACKING — "Don't lose your streak!!!"
//   * NO COUNTDOWN — "Your streak expires in 6 hours"
//   * NO GUILT — "You haven't studied today!!!" (`VISION.md`'s own named
//     example of what "not useful" looks like)
//   * NO NAMED LOSS — "You'll lose your 12-day streak"
//
// The rule that generates all four: STATE THE POSITIVE ACTION, NEVER THE
// NEGATIVE CONSEQUENCE. The streak number appears because it is a true,
// earned, specific fact about this learner (§8's celebration rule — a message
// that would read identically to somebody with no streak at all is decoration,
// not a reminder). What never appears is what happens if they do nothing.
//
// The subject carries the whole framing: "Your streak is still yours today."
// It is a statement of ownership, not a warning, and a reader who never opens
// the message has received the message.
// =============================================================================

/**
 * Everything the streak reminder renders.
 */
export interface StreakAtRiskEmailData {
  /**
   * The learner's CURRENT streak in days, as `computeStreak`
   * (`engagement/streaks/streak-engine.ts`) resolved it — never a second
   * derivation, and never a projection of what it would become.
   *
   * Always >= 2 in practice: §6.2's ladder only reaches this event for a
   * streak of two or more days with no freeze left to cover today.
   */
  streakDays: number;

  /**
   * Absolute URL of the application root, for the CTA. Optional: with no
   * `APP_URL` configured the layout omits the button rather than rendering one
   * that goes nowhere.
   */
  appUrl?: string;
}

/** The `/practice` destination, or nothing when no `APP_URL` is configured. */
function practiceUrl(appUrl: string | undefined): string | undefined {
  return appUrl ? `${appUrl.replace(/\/+$/, '')}/practice` : undefined;
}

/**
 * Render the streak reminder.
 */
export function streakAtRiskEmail(data: StreakAtRiskEmailData): RenderedEmail {
  // §5.3's subject, verbatim.
  const subject = 'Your streak is still yours today';

  const cta = practiceUrl(data.appUrl);
  const days = `${data.streakDays}-day`;

  const bodyHtml = html`
    <p style="margin:0 0 16px 0;">
      You're on a <strong>${days}</strong> streak. A quick session today keeps
      it going.
    </p>
    <p style="margin:0 0 16px 0;">
      A few questions is enough — the streak counts the days you showed up, not
      the hours you spent.
    </p>
    <p style="margin:0;font-size:13px;line-height:20px;color:#4b5563;">
      You asked for this reminder, and you can change when it arrives — or turn
      it off — in your study settings.
    </p>
  `;

  const htmlDocument = renderLayout({
    title: 'Your streak is still yours today',
    previewText: `You're on a ${days} streak.`,
    bodyHtml,
    ctaLabel: cta ? 'Practise now' : undefined,
    ctaUrl: cta,
  });

  // Hand-written, same facts in the same order.
  const text = plainText({
    title: 'Your streak is still yours today',
    lines: [
      `You're on a ${days} streak.`,
      'A quick session today keeps it going.',
      '',
      'A few questions is enough — the streak counts the days you showed up, not the',
      'hours you spent.',
      '',
      'You asked for this reminder, and you can change when it arrives — or turn it off —',
      'in your study settings.',
    ],
    ctaLabel: cta ? 'Practise now' : undefined,
    ctaUrl: cta,
  });

  return {
    subject,
    html: htmlDocument,
    text,
    headers: { ...TRANSACTIONAL_EMAIL_HEADERS },
  };
}
