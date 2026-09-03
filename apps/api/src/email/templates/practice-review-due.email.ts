import { html, plainText, renderLayout } from './layout';
import {
  TRANSACTIONAL_EMAIL_HEADERS,
  type RenderedEmail,
} from './email-template.types';

// =============================================================================
// "{n} questions ready to review" — `practice.review_due` (epic #56 / E7)
// =============================================================================
//
// `docs/specs/habit-streaks.md` §5.2. THE ONE MESSAGE OF THE THREE THAT NAMES
// A NUMBER, and the number is the whole reason it outranks the generic nudge
// in §6.2's ladder: "you have four questions ready" is a specific, true,
// checkable fact about this learner's own material, where "five minutes is
// enough" is true of everybody.
//
// -----------------------------------------------------------------------------
// THE COUNT IS `dueCount + lapsedCount`, RESOLVED BY THE CALLER, AND IT IS THE
// SAME FIGURE THAT SELECTED THE LEARNER
// -----------------------------------------------------------------------------
//
// This template renders `reviewCount` and never derives a count of its own.
// That is the identical discipline `journey/study-coach.ts` states in its own
// header for the same figure: the number in the sentence must always be the
// number that made the message appear, or a learner reads "you have 0
// questions ready to review" in a message that exists because they had three.
//
// So there is no branch here for `reviewCount === 0`. A zero would be a caller
// bug — §6.2 only ever selects this event when the sum is positive — and
// rendering an apologetic empty state would hide it rather than surface it.
// =============================================================================

/**
 * Everything the review reminder renders.
 */
export interface PracticeReviewDueEmailData {
  /**
   * How many questions are waiting: the selector's DUE bucket plus its WEAK
   * bucket, the same sum `GET /api/practice/queue` reports as `due` + `weak`
   * and `study-coach.ts` calls `reviewCount`.
   */
  reviewCount: number;

  /**
   * Absolute URL of the application root, for the CTA. Optional: with no
   * `APP_URL` configured the layout omits the button rather than rendering one
   * that goes nowhere.
   */
  appUrl?: string;
}

/** `4 questions` / `1 question`. */
function questionPhrase(count: number): string {
  return `${count} question${count === 1 ? '' : 's'}`;
}

/** The `/practice` destination, or nothing when no `APP_URL` is configured. */
function practiceUrl(appUrl: string | undefined): string | undefined {
  return appUrl ? `${appUrl.replace(/\/+$/, '')}/practice` : undefined;
}

/**
 * Render the review reminder.
 */
export function practiceReviewDueEmail(
  data: PracticeReviewDueEmailData,
): RenderedEmail {
  const phrase = questionPhrase(data.reviewCount);

  // §5.2's subject. The count is in it deliberately: this is the one message
  // whose value survives being read in an inbox list and never opened.
  const subject = `${phrase} ready to review`;

  const cta = practiceUrl(data.appUrl);

  const bodyHtml = html`
    <p style="margin:0 0 16px 0;">
      You have <strong>${phrase}</strong> ready to review — a few minutes now
      keeps them from slipping.
    </p>
    <p style="margin:0 0 16px 0;">
      These are questions you have answered correctly before. Reviewing them
      when they come round is what turns them into answers you keep.
    </p>
    <p style="margin:0;font-size:13px;line-height:20px;color:#4b5563;">
      You choose when this arrives — and whether it arrives at all — in your
      study settings.
    </p>
  `;

  const htmlDocument = renderLayout({
    title: `${phrase} ready to review`,
    previewText: 'A few minutes now keeps them from slipping.',
    bodyHtml,
    ctaLabel: cta ? 'Start reviewing' : undefined,
    ctaUrl: cta,
  });

  // Hand-written, same facts in the same order.
  const text = plainText({
    title: `${phrase} ready to review`,
    lines: [
      `You have ${phrase} ready to review.`,
      'A few minutes now keeps them from slipping.',
      '',
      'These are questions you have answered correctly before. Reviewing them when they',
      'come round is what turns them into answers you keep.',
      '',
      'You choose when this arrives — and whether it arrives at all — in your study settings.',
    ],
    ctaLabel: cta ? 'Start reviewing' : undefined,
    ctaUrl: cta,
  });

  return {
    subject,
    html: htmlDocument,
    text,
    headers: { ...TRANSACTIONAL_EMAIL_HEADERS },
  };
}
