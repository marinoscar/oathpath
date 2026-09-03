import {
  EVENT_BROWSER_TEMPLATES,
  type BrowserNotificationContent,
} from '../../notifications/channels/browser-notification.channel';
import { practiceDailyReminderEmail } from './practice-daily-reminder.email';
import { practiceReviewDueEmail } from './practice-review-due.email';
import { streakAtRiskEmail } from './streak-at-risk.email';

// =============================================================================
// The three practice reminders — copy tests (epic #56 / E7 "Habit")
// =============================================================================
//
// Two halves, and the second is the one worth having.
//
// The first half checks the FINAL COPY `docs/specs/habit-streaks.md` §5 fixes:
// each subject, each opening line, each plain-text opening. Those are quoted
// in the spec, so a change to any of them is a change to a reviewed product
// decision and should have to edit this file to land.
//
// The second half checks the copy rules §5.3 and §8 state as PROHIBITIONS, and
// it runs over every surface all three messages produce — the subject, the
// HTML part, the hand-written text part, and the browser channel's title and
// body. A prohibition that is only checked on one of the five is not checked:
// the two-line toast is exactly where a countdown is most tempting to write,
// and the text part is the surface nobody looks at.
// =============================================================================

/** The sample payloads. Plural and singular both, where the copy branches. */
const GOAL_MINUTES = 5;
const REVIEW_COUNT = 4;
const STREAK_DAYS = 12;
const APP_URL = 'https://app.example.com';

/** Collapse runs of whitespace, so an assertion can quote a sentence that the
 *  HTML template happens to wrap across two source lines. */
function squash(value: string): string {
  return value.replace(/\s+/g, ' ');
}

/** Every rendered surface of one message, as flat strings. */
function surfacesFor(eventKey: string, rendered: { subject: string; html: string; text: string }, data: unknown): string[] {
  const template = EVENT_BROWSER_TEMPLATES[eventKey];
  expect(template).toBeDefined();

  const browser = (template as (d: never) => BrowserNotificationContent)(
    data as never,
  );

  return [rendered.subject, rendered.html, rendered.text, browser.title, browser.body];
}

const daily = practiceDailyReminderEmail({
  dailyGoalMinutes: GOAL_MINUTES,
  appUrl: APP_URL,
});
const review = practiceReviewDueEmail({
  reviewCount: REVIEW_COUNT,
  appUrl: APP_URL,
});
const streak = streakAtRiskEmail({ streakDays: STREAK_DAYS, appUrl: APP_URL });

describe('practice.daily_reminder — the copy habit-streaks.md §5.1 fixes', () => {
  it('uses the spec\'s subject verbatim', () => {
    expect(daily.subject).toBe('Five minutes is enough today');
  });

  it('opens on the spec\'s body line', () => {
    expect(squash(daily.html)).toContain(
      'Five minutes is enough today. A quick session covers your goal.',
    );
  });

  it('opens the plain-text part on the spec\'s line', () => {
    expect(daily.text).toContain('Five minutes is enough today.');
  });

  it("states the learner's OWN goal, not a figure the template chose", () => {
    // §5.1: "the rest states the learner's own goal". A message that read
    // "your goal is 5 minutes" to a learner who set 15 would be a fabricated
    // claim about their own settings.
    const custom = practiceDailyReminderEmail({ dailyGoalMinutes: 15 });
    expect(squash(custom.html)).toContain('15 minutes a day');
    expect(custom.text).toContain('15 minutes a day');
  });

  it('says "1 minute a day" rather than "1 minutes a day"', () => {
    const singular = practiceDailyReminderEmail({ dailyGoalMinutes: 1 });
    expect(singular.text).toContain('1 minute a day');
    expect(singular.text).not.toContain('1 minutes a day');
  });

  it('links its CTA to /practice, and omits the button entirely with no APP_URL', () => {
    expect(daily.html).toContain('https://app.example.com/practice');

    const noUrl = practiceDailyReminderEmail({ dailyGoalMinutes: GOAL_MINUTES });
    expect(noUrl.html).not.toContain('/practice');
    expect(noUrl.text).not.toContain('/practice');
  });
});

describe('practice.review_due — the copy habit-streaks.md §5.2 fixes', () => {
  it("names the actual count in the subject", () => {
    expect(review.subject).toBe('4 questions ready to review');
  });

  it('opens on the spec\'s body line', () => {
    expect(squash(review.html)).toContain(
      'You have <strong>4 questions</strong> ready to review — a few minutes now keeps them from slipping.',
    );
  });

  it('opens the plain-text part on the spec\'s line', () => {
    expect(review.text).toContain('You have 4 questions ready to review.');
  });

  it('says "1 question" rather than "1 questions"', () => {
    const one = practiceReviewDueEmail({ reviewCount: 1 });
    expect(one.subject).toBe('1 question ready to review');
    expect(one.text).toContain('You have 1 question ready to review.');
  });

  it('renders the count it was handed and never a second one of its own', () => {
    // The discipline `study-coach.ts` states for the same figure: the number
    // in the sentence is always the number that made the message appear.
    const seventeen = practiceReviewDueEmail({ reviewCount: 17 });
    expect(seventeen.subject).toContain('17');
    expect(seventeen.text).toContain('17 questions');
  });
});

describe('streak.at_risk — the copy habit-streaks.md §5.3 fixes', () => {
  it('uses the spec\'s subject verbatim, which states ownership rather than risk', () => {
    expect(streak.subject).toBe('Your streak is still yours today');
  });

  it('opens on the spec\'s body line', () => {
    expect(squash(streak.html)).toContain(
      "You're on a <strong>12-day</strong> streak. A quick session today keeps it going.",
    );
  });

  it('opens the plain-text part on the spec\'s line', () => {
    expect(streak.text).toContain("You're on a 12-day streak.");
  });

  it("renders the learner's own streak length, not a generic one", () => {
    const three = streakAtRiskEmail({ streakDays: 3 });
    expect(three.text).toContain("You're on a 3-day streak.");
  });
});

// =============================================================================
// The prohibitions
// =============================================================================

describe('VISION.md: "We should never create pressure, shame, fear, or unhealthy compulsion to increase engagement metrics"', () => {
  /**
   * Every surface of every one of the three messages, labelled so a failure
   * names which message and which part of it broke the rule.
   */
  const SURFACES: [string, string][] = [
    ...surfacesFor('practice.daily_reminder', daily, {
      dailyGoalMinutes: GOAL_MINUTES,
      appUrl: APP_URL,
    }).map((surface, index): [string, string] => [
      `practice.daily_reminder [${['subject', 'html', 'text', 'browser title', 'browser body'][index]}]`,
      surface,
    ]),
    ...surfacesFor('practice.review_due', review, {
      reviewCount: REVIEW_COUNT,
      appUrl: APP_URL,
    }).map((surface, index): [string, string] => [
      `practice.review_due [${['subject', 'html', 'text', 'browser title', 'browser body'][index]}]`,
      surface,
    ]),
    ...surfacesFor('streak.at_risk', streak, {
      streakDays: STREAK_DAYS,
      appUrl: APP_URL,
    }).map((surface, index): [string, string] => [
      `streak.at_risk [${['subject', 'html', 'text', 'browser title', 'browser body'][index]}]`,
      surface,
    ]),
  ];

  /**
   * The shapes §5.3 lists, each with the example the spec is checked against.
   *
   * These are patterns, not exact strings, on purpose: the failure this guards
   * against is not somebody pasting `VISION.md`'s own bad example into a
   * template, it is somebody writing a NEW sentence of the same shape when the
   * open rate looks disappointing.
   */
  const FORBIDDEN: [string, RegExp][] = [
    // "Don't lose your streak!!!" — exclamation-stacking.
    ['stacked exclamation marks', /!!/],
    // "You haven't studied today!!!" — VISION.md's own named example of what
    // "not useful" looks like.
    ['guilt about what the learner did not do', /you ?ha(ve ?not|ven'?t|d ?not|dn'?t)/i],
    ["a second person 'did not'", /you (did ?not|didn'?t)/i],
    // "You'll lose your 12-day streak" — naming a specific loss.
    ['naming a loss', /(lose|losing|lost)\b/i],
    // "Your streak expires in 6 hours" — countdown framing.
    ['countdown framing', /(expires?|ends?|resets?|runs out)\s+(in|at|today|tonight)/i],
    ['hours-remaining framing', /\b\d+\s+hours?\s+(left|remaining|to go)/i],
    // Urgency vocabulary of the kind the spec rules out wholesale.
    ['urgency vocabulary', /\b(hurry|last chance|don'?t miss|act now|final)\b/i],
    // §8: a claim the ring is never entitled to make.
    ["borrowing readiness's vocabulary for a habit", /\b(ready to pass|% ready|percent ready)\b/i],
  ];

  it.each(SURFACES)('%s uses no forbidden shape', (_label, surface) => {
    for (const [shape, pattern] of FORBIDDEN) {
      // The message names the rule rather than the regex, so a failure reads
      // as a product decision and not as a lint error.
      expect({ shape, matched: pattern.test(surface) }).toEqual({
        shape,
        matched: false,
      });
    }
  });

  it.each(
    SURFACES.filter(([label]) => !label.includes('html')),
  )('%s carries no exclamation mark at all', (_label, surface) => {
    // The HTML part is excluded because the LAYOUT contains `<!doctype>` and
    // the Outlook conditional comments, neither of which is copy. Every
    // surface a reader actually reads as a sentence is checked.
    expect(surface).not.toContain('!');
  });

  it('none of the three mentions the streak breaking, on any surface', () => {
    for (const [, surface] of SURFACES) {
      expect(surface).not.toMatch(/streak\s+(will|would|is about to|is going to)/i);
      expect(surface).not.toMatch(/break(s|ing)?\s+your\s+streak/i);
    }
  });
});
