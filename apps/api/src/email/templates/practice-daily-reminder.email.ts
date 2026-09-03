import { html, plainText, renderLayout } from './layout';
import {
  TRANSACTIONAL_EMAIL_HEADERS,
  type RenderedEmail,
} from './email-template.types';

// =============================================================================
// "Five minutes is enough today" — `practice.daily_reminder`
// (epic #56 / E7 "Habit")
// =============================================================================
//
// `docs/specs/habit-streaks.md` §5.1. THE LAST RUNG OF THE LADDER: this
// message is only ever rendered once the hourly task (§6.2) has already ruled
// out `streak.at_risk` and `practice.review_due`. So by construction there is
// nothing urgent to name here — no streak on the line, no queue of due
// questions — and the copy must not invent one.
//
// -----------------------------------------------------------------------------
// WHAT THIS TEMPLATE IS NOT ALLOWED TO SAY, AND WHY IT IS WORTH SPELLING OUT
// -----------------------------------------------------------------------------
//
// `VISION.md` gives this exact situation as its worked example of a good
// notification ("Five minutes is enough today...") and its worked example of a
// bad one ("You haven't studied today!!!"). The difference between them is not
// tone, it is WHAT THE SENTENCE IS ABOUT: the first is about how small the ask
// is, the second is about what the reader failed to do. So this message never
// mentions the day's absence of practice at all, even though the absence is
// precisely what selected the learner. It offers the smallest true next step
// and stops.
//
// The registry entry's `defaultEnabled: true` is only defensible while that
// holds. A default-on message that reads as an accusation is worse than no
// message, and `notification-events.ts`'s own comment on this group says so.
// =============================================================================

/**
 * Everything the daily reminder renders.
 *
 * Deliberately tiny. The one number in it is the learner's OWN goal, read
 * from `learner_profiles.dailyGoalMinutes` by the task that raises this — not
 * a figure this template picks, and not an average of anything.
 */
export interface PracticeDailyReminderEmailData {
  /** The learner's own daily goal, in minutes (`learner_profiles.daily_goal_minutes`). */
  dailyGoalMinutes: number;

  /**
   * Absolute URL of the application root, for the CTA. Optional, as in every
   * other template here: with no `APP_URL` configured the layout omits the
   * button rather than rendering one that goes nowhere.
   */
  appUrl?: string;
}

/**
 * The learner's goal as a phrase, singular-aware.
 *
 * A reminder that reads "1 minutes a day" undermines the one claim this
 * message makes — that the ask is small and considered.
 */
function goalPhrase(minutes: number): string {
  return `${minutes} minute${minutes === 1 ? '' : 's'} a day`;
}

/** The `/practice` destination, or nothing when no `APP_URL` is configured. */
function practiceUrl(appUrl: string | undefined): string | undefined {
  return appUrl ? `${appUrl.replace(/\/+$/, '')}/practice` : undefined;
}

/**
 * Render the daily practice reminder.
 */
export function practiceDailyReminderEmail(
  data: PracticeDailyReminderEmailData,
): RenderedEmail {
  // §5.1's subject, verbatim. It is the whole message: a reader who never
  // opens it has still received the useful part.
  const subject = 'Five minutes is enough today';

  const cta = practiceUrl(data.appUrl);
  const goal = goalPhrase(data.dailyGoalMinutes);

  const bodyHtml = html`
    <p style="margin:0 0 16px 0;">
      Five minutes is enough today. A quick session covers your goal.
    </p>
    <p style="margin:0 0 16px 0;">
      Your goal is <strong>${goal}</strong>. One short round of questions is
      usually all it takes.
    </p>
    <p style="margin:0;font-size:13px;line-height:20px;color:#4b5563;">
      You choose when this arrives — and whether it arrives at all — in your
      study settings.
    </p>
  `;

  const htmlDocument = renderLayout({
    title: 'Five minutes is enough today',
    // The preheader states the goal rather than repeating the subject the
    // inbox list already shows immediately to its left.
    previewText: `Your goal is ${goal}.`,
    bodyHtml,
    ctaLabel: cta ? 'Practise now' : undefined,
    ctaUrl: cta,
  });

  // Hand-written, same facts in the same order — never stripped from the
  // markup above (see the note above `plainText` in layout.ts).
  const text = plainText({
    title: 'Five minutes is enough today',
    lines: [
      'Five minutes is enough today.',
      'A quick session covers your goal.',
      '',
      `Your goal is ${goal}. One short round of questions is usually all it takes.`,
      '',
      'You choose when this arrives — and whether it arrives at all — in your study settings.',
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
