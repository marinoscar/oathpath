import { randomUUID } from 'node:crypto';
import { test, expect, type Locator } from '@playwright/test';
import { seedOnboarding } from '../helpers/auth.helper';
import {
  fetchAcceptedAnswer,
  fetchNextQuestionId,
} from '../helpers/practice-questions';

// =============================================================================
// practice-session.spec.ts — issue #84, epic #52 (E3)
// =============================================================================
//
// Exercises `/practice` end to end: Home's Next-up card into a real Quick 5
// session, one attempt of each shape the API can grade, self-mark, a computed
// summary, and — the one thing no component test can reach — that the SAME
// summary renders after leaving the page entirely and coming back through
// Recent sessions. `PracticeSummaryPage`'s own header names that exact case
// ("it must render identically when revisited later") as the reason it reads
// from the server on every mount rather than from React Router navigation
// state; this spec is what proves that promise rather than just documenting
// it.
//
// -----------------------------------------------------------------------------
// NO AI CONFIGURATION OF ANY KIND — AND WHY THAT IS SAFE TO ASSERT
// -----------------------------------------------------------------------------
//
// `seedOnboarding` stores a fake per-user AI key (`PUT /api/ai/key`) because
// `RequireAiKey` hard-blocks every learner regardless of what this spec is
// about — there is no way to reach `/practice` without one. That key is never
// read by anything below: `AiDispatchService.resolve` (apps/api/src/ai/
// ai-dispatch.service.ts) checks the system-wide `enabled` switch and a bound
// model FIRST, before it ever reaches for a caller's own key, and this suite
// never touches `/admin/settings/ai` or sets `AI_PROVIDER_FAKE`. So the one
// question 3 ("wrong answer") attempt below — the only response here with real
// text that also grades `incorrect`, and therefore the only one eligible for
// `PracticeService.escalateToGrader`'s rung 2 — resolves `unavailable` at the
// very first check and the deterministic verdict from `matchAnswer`
// (apps/api/src/practice/answer-matching.ts) stands untouched. That is not a
// coincidental pass; it is `docs/specs/practice-sessions.md`'s ladder
// degrading to its own bottom rung exactly as designed, and it is the reason
// epic #52 ordered E3 (deterministic matching) before E4 (the semantic
// grader) in the first place. If this spec ever needed a model configured to
// pass, something upstream of it would already be a regression.
//
// -----------------------------------------------------------------------------
// WHY NOTHING HERE ASSUMES WHICH QUESTION LANDS IN WHICH POSITION
// -----------------------------------------------------------------------------
//
// `PracticeService.createSession`'s question selection is unseen-first with
// each group SHUFFLED (practice.controller.ts's own Swagger description), so
// the five questions a Quick 5 actually serves — and their order — are not
// something this spec can predict or pin. Two structural choices make that a
// non-issue rather than a source of flakiness:
//
//   1. **Behaviour is keyed to POSITION (1st through 5th question answered),
//      never to a question's content or number.** The loop below does not
//      care whether question 43 or question 7 shows up first; it does exactly
//      one of five actions depending on how many questions it has already
//      answered in this session.
//   2. **The text typed into each answer is read off the ACTUAL question the
//      server is currently asking**, via `fetchAcceptedAnswer` — a plain,
//      idempotent `GET /api/civics/questions/:id` using the question id the
//      session's own `GET /api/practice/sessions/:id` names as `nextQuestion`.
//      This is not scraping the practice page (`PracticeQuestionDto` carries
//      no answer-shaped field — see that file's own compile-time proof — so
//      there is nothing to scrape); it is exactly what a prepared learner
//      already knows, obtained the same way `civics-learn.spec.ts` treats
//      civics answers as public exam content.
//
// -----------------------------------------------------------------------------
// CASE 2: WHICH NORMALISATION RULE, AND WHY IT IS NOT THE ISSUE'S LITERAL "the
// u.s." EXAMPLE
// -----------------------------------------------------------------------------
//
// Issue #84 names "the u.s." against "the United States" as the normalisation
// case to exercise. That pair only exists in the seeded content on questions
// whose accepted answer is literally "the United States" (or an equivalent
// national-scope phrase) — and per the section above, this spec has no way to
// force such a question into position 2 of a shuffled Quick 5, or even to know
// whether one is in the five drawn at all. Hardcoding that phrase would make
// the spec either flaky (most runs) or, if it fell back to "any question
// works", silently stop testing normalisation at all.
//
// Instead this exercises **punctuation stripping** — `answer-matching.ts`
// step 3, `working.replace(/[^\p{L}\p{N}\s]/gu, ' ')` — by taking the SAME
// accepted answer typed exactly in case 1 and appending one trailing period.
// That is a normalisation rule from the file's own documented list (the task
// names "case, article, punctuation, number word") and, unlike the case-fold
// or abbreviation rules, it is content-agnostic: appending a period changes
// the raw string against ANY accepted answer — free text, a number, a dynamic
// placeholder — so pass 1's case-sensitive exact check always fails and pass 2
// always recovers it, regardless of which question the server happens to draw
// into this slot. That is the same trade this spec makes everywhere else:
// content-agnostic and always-true beats a specific, unreachable example.
//
// -----------------------------------------------------------------------------
// WHY SELF-MARK LANDS ON THE REVEAL CASE, NOT THE WRONG-ANSWER CASE
// -----------------------------------------------------------------------------
//
// `AttemptFeedback`'s self-mark control (`canSelfMark = attempt.outcome !==
// 'correct' && attempt.revealed`) only ever appears on a REVEALED attempt —
// `POST .../self-mark` itself refuses an unrevealed one with a 409, and
// `AttemptFeedback.tsx`'s own header makes the reason explicit: "my answer
// matched the accepted one" is only checkable against the accepted one. Case 3
// below (a cold wrong submit) is therefore never self-mark eligible, and this
// spec asserts that absence explicitly rather than assuming it. Case 5 is
// submitted with an intentionally BLANK response through "Show me the
// answer" — `matchAnswer('', …)` is `incorrect` by construction (an empty
// normalised form can never equal a non-empty accepted answer) — which is
// what makes it both a real `incorrect` verdict and the one this spec can
// self-mark. "Exercise self-mark on the incorrect one" and "case 5 is a
// reveal" are the same requirement read from two directions once that
// constraint is followed.
// =============================================================================

function testEmail(label: string): string {
  return `practice-session-${label}-${randomUUID()}@test.local`;
}

// `fetchNextQuestionId` and `fetchAcceptedAnswer` used to live here. They
// moved to `../helpers/practice-questions` when `ai-evaluation.spec.ts`
// (#131) needed the exact same "ask the server what it is currently asking,
// then read the accepted answer the same way a prepared learner would" pair —
// see that file's own header for the full reasoning, which is unchanged by
// the move.

/**
 * One `SummaryTally` count — the number for a given label ("correct", "not
 * matched", "skipped", "partly right").
 *
 * `SummaryTally.tsx`'s `Count` renders one small `Box` per count, containing
 * exactly two `Typography` paragraphs in order: the value, then the label
 * naming it — nothing else inside that `Box`. So the value is reachable from
 * the label with no `data-testid` neither component declares: go up to that
 * enclosing `Box` (the well-known "xpath=.." parent idiom — a single `..`
 * step, which needs no context beyond "the current node" and so carries none
 * of the ambiguity a longer relative XPath would), then take the first of its
 * two paragraph children.
 */
function summaryCount(region: Locator, label: string): Locator {
  const labelParagraph = region.getByText(label, { exact: true });
  const box = labelParagraph.locator('xpath=..');
  return box.locator('p').first();
}

test.describe('Practice session (issue #84), epic #52', () => {
  test('a Quick 5 is answered one question at a time, self-marked, completed, and its summary survives leaving and returning', async ({
    page,
  }) => {
    const email = testEmail('learner');
    const { accessToken } = await seedOnboarding(page, {
      email,
      onboarding: 'full',
    });
    const authHeaders = { Authorization: `Bearer ${accessToken}` };
    // `seedOnboarding` does not itself wait for '/' (see its own header) —
    // only `loginAsTestUser` does, for callers that always want it. This spec
    // needs the captured `accessToken` back, so it waits for the same
    // destination directly.
    await page.waitForURL('/', { timeout: 10000 });

    // ---------------------------------------------------------------------
    // 1. Home's Next-up card, into Practice.
    //
    // `ORIENTATION_PROFILE` (seed-onboarding.ts) sets no interview date, so
    // `recommendNextAction` (apps/api/src/journey/next-action.ts) falls past
    // branch 2 (no countdown to show) to branch 3 — `kind: 'practice'`,
    // `path: '/practice'`, title "Practice five questions." — for a learner
    // oriented but not yet practised today. That IS the Next-up card path
    // into a Quick 5 the issue asks for; E3 (#81) is what re-pointed this
    // card at a page with real sessions behind it at all.
    // ---------------------------------------------------------------------
    await expect(page.getByText('Practice five questions.')).toBeVisible();
    const nextUpLink = page.getByRole('link', { name: 'Go to Practice' });
    await expect(nextUpLink).toHaveAttribute('href', '/practice');
    await nextUpLink.click();

    await expect(page).toHaveURL('/practice');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Practice' }),
    ).toBeVisible();

    // ---------------------------------------------------------------------
    // 2. Start a Quick 5.
    // ---------------------------------------------------------------------
    await page.getByRole('button', { name: 'Start a Quick 5' }).click();
    await expect(page).toHaveURL(/\/practice\/sessions\/[0-9a-f-]{36}$/);
    const sessionId = page.url().split('/').pop();
    if (!sessionId) throw new Error('Could not read the session id from the URL.');

    // ---------------------------------------------------------------------
    // 3. Five questions, five different endings — keyed to POSITION, never
    //    to which question the server happened to draw. See this file's
    //    header for why that is the only safe axis against a shuffled pool.
    // ---------------------------------------------------------------------
    const answerField = page.getByLabel('Your answer');

    for (let position = 1; position <= 5; position += 1) {
      await expect(page.getByText(`Question ${position} of 5`)).toBeVisible();

      if (position === 1) {
        // ---- Case 1: EXACT match. --------------------------------------
        const questionId = await fetchNextQuestionId(page, authHeaders, sessionId);
        const accepted = await fetchAcceptedAnswer(page, authHeaders, questionId);

        await answerField.fill(accepted);
        await page.getByRole('button', { name: 'Submit' }).click();

        await expect(page.getByText('Correct', { exact: true })).toBeVisible();
        await expect(
          page.getByText('That matches an accepted answer.'),
        ).toBeVisible();
      } else if (position === 2) {
        // ---- Case 2: NORMALISATION (punctuation) — see this file's header
        //      for why this rule and not the issue's literal "the u.s." pair.
        const questionId = await fetchNextQuestionId(page, authHeaders, sessionId);
        const accepted = await fetchAcceptedAnswer(page, authHeaders, questionId);

        // A trailing period the raw accepted text does not have: exact match
        // (pass 1) fails on the extra character, normalisation (pass 2)
        // strips it back out via step 3's punctuation-to-space rule.
        await answerField.fill(`${accepted.trim()}.`);
        await page.getByRole('button', { name: 'Submit' }).click();

        await expect(page.getByText('Correct', { exact: true })).toBeVisible();
        await expect(
          page.getByText('That matches an accepted answer.'),
        ).toBeVisible();
      } else if (position === 3) {
        // ---- Case 3: WRONG answer, submitted cold (never revealed). -----
        await answerField.fill(
          'This response is deliberately wrong and matches no accepted answer.',
        );
        await page.getByRole('button', { name: 'Submit' }).click();

        await expect(page.getByText('Not a match', { exact: true })).toBeVisible();
        await expect(
          page.getByText(/doesn.t match an accepted answer/),
        ).toBeVisible();
        // Never self-mark eligible: `POST .../self-mark` refuses an
        // unrevealed attempt (409), and `AttemptFeedback` renders the control
        // only when the API would accept it. See this file's header.
        await expect(
          page.getByRole('button', { name: 'I was right' }),
        ).toHaveCount(0);
      } else if (position === 4) {
        // ---- Case 4: SKIP. ----------------------------------------------
        await page.getByRole('button', { name: 'Skip' }).click();

        await expect(page.getByText('Skipped', { exact: true })).toBeVisible();
        await expect(
          page.getByText('You moved on without answering this one.'),
        ).toBeVisible();
        await expect(
          page.getByRole('button', { name: 'I was right' }),
        ).toHaveCount(0);
      } else {
        // ---- Case 5: REVEAL, with a blank response — the one attempt this
        //      spec self-marks. See this file's header for why it is this
        //      case and not case 3.
        await page.getByRole('button', { name: 'Show me the answer' }).click();

        await expect(page.getByText('Not a match', { exact: true })).toBeVisible();

        const selfMarkButton = page.getByRole('button', { name: 'I was right' });
        await expect(selfMarkButton).toBeVisible();
        await selfMarkButton.click();

        // The verdict now reads correct, attributed to the learner's own
        // claim rather than the matcher — `gradingMethodNote('self')`.
        await expect(page.getByText('Correct', { exact: true })).toBeVisible();
        await expect(
          page.getByText('You marked this one correct yourself.'),
        ).toBeVisible();
        await expect(selfMarkButton).toHaveCount(0);
      }

      const isLastQuestion = position === 5;
      await page
        .getByRole('button', {
          name: isLastQuestion ? 'See your summary' : 'Next question',
        })
        .click();
    }

    // ---------------------------------------------------------------------
    // 4. The summary, freshly finished: correct 3 (exact, normalised,
    //    self-marked), incorrect 1 (the cold wrong submit), skipped 1.
    // ---------------------------------------------------------------------
    const summaryUrlPattern = new RegExp(
      `/practice/sessions/${sessionId}/summary$`,
    );
    await expect(page).toHaveURL(summaryUrlPattern);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Practice summary' }),
    ).toBeVisible();

    async function assertTally(): Promise<void> {
      const tally = page.getByRole('region', { name: 'How it went' });
      await expect(tally).toBeVisible();
      await expect(tally.getByText('You answered 5 of 5.')).toBeVisible();

      await expect(summaryCount(tally, 'correct')).toHaveText('3');
      await expect(summaryCount(tally, 'not matched')).toHaveText('1');
      await expect(summaryCount(tally, 'skipped')).toHaveText('1');
      // E4's semantic grader is the first producer of `partial` — nothing in
      // E3's deterministic path can reach it, so `SummaryTally` renders no
      // "partly right" column at all (`summary.partial > 0 &&`).
      await expect(tally.getByText('partly right')).toHaveCount(0);

      await expect(
        tally.getByText('1 of those you marked correct yourself.'),
      ).toBeVisible();
      await expect(
        tally.getByText('You asked to see the answer on 1 question.'),
      ).toBeVisible();
    }

    await assertTally();

    // Every question answered, in the order it was answered — case 3's wrong
    // submit and case 5's now-self-marked reveal should both still be
    // present and distinguishable.
    await expect(
      page.getByText(
        'This response is deliberately wrong and matches no accepted answer.',
      ),
    ).toBeVisible();
    await expect(
      page.getByText('You asked to see the answer on this one.'),
    ).toBeVisible();

    // ---------------------------------------------------------------------
    // 5. Leave the page entirely, then come back through Recent sessions —
    //    a fresh mount of `usePracticeSession`, a fresh
    //    `GET /api/practice/sessions/:id`, nothing carried through React
    //    Router navigation state. This is the seam no component test can
    //    reach: it proves the summary comes from the persisted attempt rows,
    //    not from whatever this tab still remembered.
    // ---------------------------------------------------------------------
    await page.getByRole('link', { name: 'Back to Practice' }).click();
    await expect(page).toHaveURL('/practice');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Practice' }),
    ).toBeVisible();

    // This account has practised exactly once, ever, so "Quick 5" names
    // exactly one row — the session just finished.
    await page.getByRole('link', { name: 'Quick 5' }).click();
    await expect(page).toHaveURL(summaryUrlPattern);

    await assertTally();
  });
});
