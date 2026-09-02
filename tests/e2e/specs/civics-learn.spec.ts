import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { loginAsTestUser } from '../helpers/auth.helper';

// =============================================================================
// civics-learn.spec.ts — issue #132, epic #51
// =============================================================================
//
// The learner's `/learn` destination (#121) and the admin's
// `/admin/settings/civics` correction surface (#126) end to end: a learner
// reads a resolved answer, an admin corrects it, and the SAME learner session
// sees the new text and a new provenance date — with the superseded text gone.
//
// -----------------------------------------------------------------------------
// REQUIRES `CIVICS_ALLOW_UNVERIFIED_CONTENT=true` ON THE API
// -----------------------------------------------------------------------------
//
// The civics content #101 shipped (`apps/api/prisma/content/civics-2008.json`)
// is a labelled DRAFT — `provenance.transcription.status` is
// `UNVERIFIED_MODEL_DRAFT`, because uscis.gov was unreachable when it was
// written. `load-content.ts`'s `assertTrustedForLoad` refuses to load anything
// short of `HUMAN_VERIFIED` unless the API's environment sets
// `CIVICS_ALLOW_UNVERIFIED_CONTENT=true` (and refuses unconditionally when
// `NODE_ENV=production`, regardless of that flag). This suite does not load
// content itself — it runs against a compose stack that already has, per
// `docs/TESTING.md` — but the API process behind that stack must have been
// started with that variable set, or there is nothing in `civics_questions`
// for any assertion below to find. Never set `NODE_ENV=production` to work
// around this.
//
// -----------------------------------------------------------------------------
// WHY EVERY DYNAMIC ANSWER ASSERTION IS STRUCTURAL, NEVER A NAME
// -----------------------------------------------------------------------------
//
// Every dynamic officeholder answer in that draft — the President, every
// state's Governor, every state's Senators and Representative, the Speaker —
// is the literal string `"[DRAFT PLACEHOLDER] ... — not sourced, needs
// verification"`. Nothing below asserts that literal text or any real
// person's name: doing so would be asserting fabricated content, and it would
// break the day this content is replaced with real, human-verified text. What
// IS asserted is structure and behaviour — an answer rendered, a citation and
// a verified-as-of date accompanied it, the text CHANGED after a correction,
// and the superseded text is gone — none of which depends on what the answer
// actually says. Only genuinely static answers ("the Constitution") are
// asserted by literal text.
//
// -----------------------------------------------------------------------------
// THE CLOCK IS PINNED ON BOTH SESSIONS, TO THE SAME INSTANT
// -----------------------------------------------------------------------------
//
// `civics-content.md` §3.2's read-side rule is `effectiveFrom <= now` — a
// corrected answer with a real-world `effectiveFrom` in the future of the
// READER's clock is not yet the one served, and the reader would keep seeing
// the row that was just closed. Pinning only the ADMIN's clock forward (to
// prove the new `verifiedAt` differs from whatever the content loader
// happened to stamp) would therefore make the correction invisible to a
// learner reading with the real wall clock. Pinning the LEARNER's clock to the
// exact same instant sidesteps that entirely: `effectiveFrom` and the read's
// `now` are then equal, which the `lte` in `currentAnswerWhere` accepts, and
// the whole scenario becomes independent of whatever the real date happens to
// be when this suite runs — see `X-Test-Clock` in `docs/TESTING.md`.
//
// -----------------------------------------------------------------------------
// THE MISSING-STATE CASE USES `page.route()`, AND THAT IS DELIBERATE
// -----------------------------------------------------------------------------
//
// `JourneyService.isOrientationComplete` requires `stateCode` to be present,
// and `RequireOrientation` (`journey-shell.md` §5) gates `/learn` with no
// exemption for it. The write schema for `PUT /api/journey/profile`
// (`update-journey-profile.dto.ts`) accepts `stateCode` as an optional STRING
// — never `null` — so a state, once set, cannot be cleared through the API
// either. Put together: a real learner account can never reach `/learn` with
// no `state_code` on file, by product design, not by test gap. So this one
// test intercepts the single network response for the question it opens and
// rewrites it into the exact `state_required` shape `civics-content.md` §5 and
// `types/index.ts`'s `CivicsAnswerResolution` document (`answers: []`,
// `verifiedAt: null`, `resolvedForStateCode: null`) — everything else in that
// test (login, categories, the rest of the app) talks to the real API. This
// is testing the LEARNER UI's handling of a response shape the API contract
// guarantees it can produce, not re-deriving the resolution rule itself (that
// belongs to the API integration specs this suite is told not to duplicate).
// =============================================================================

function testEmail(label: string): string {
  return `civics-learn-${label}-${randomUUID()}@test.local`;
}

/** A fixed instant, far from any real content-load timestamp. See header. */
const PINNED_NOW = '2031-03-17T15:00:00Z';
/** `formatDay` (admin page): `{ month: 'short' }`, locale `en-US`, UTC. */
const PINNED_DAY_SHORT = 'Mar 17, 2031';
/** `formatVerifiedAt` (learner page): `{ month: 'long' }`, locale `en-US`, UTC. */
const PINNED_DAY_LONG = 'March 17, 2031';

/**
 * The single answer paragraph `AnswerPanel` renders directly under its
 * "Answer" heading, for a question with exactly one currently accepted
 * answer (true of every question this spec opens — none of them is one of
 * the small number of multi-answer questions). `QuestionDetail` and
 * `FlashcardStudy` both pass `headingComponent="h4"`, so this is stable
 * across both surfaces without needing a per-page variant.
 */
function answerParagraph(page: Page) {
  return page.locator('h4:has-text("Answer") + p').first();
}

test.use({ locale: 'en-US' });

test.describe('Civics Learn (issue #121) + Civics Answers admin (issue #126), epic #51', () => {
  test('a learner reads a resolved answer, an admin corrects it, and the learner sees the new answer with the old one gone', async ({
    page,
    browser,
  }) => {
    const learnerEmail = testEmail('learner');
    await loginAsTestUser(page, { email: learnerEmail });
    await expect(page).toHaveURL('/');

    // Pinned from here on — see header. Set on the PAGE so it rides along on
    // every fetch the React app itself makes (services/api.ts), never on
    // `page.request` (the separate context `loginAsTestUser` already used).
    await page.setExtraHTTPHeaders({ 'X-Test-Clock': PINNED_NOW });

    // -------------------------------------------------------------------------
    // 1. Browse to a category, open a question — the Governor of the
    //    learner's own state (CA, `seed-onboarding.ts`'s `ORIENTATION_PROFILE`).
    //    This doubles as the question the admin corrects in step 4, so its
    //    "before" state is captured here rather than invented later.
    // -------------------------------------------------------------------------
    await page.goto('/learn');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Learn' }),
    ).toBeVisible();

    await page.getByRole('link', { name: 'System of Government' }).click();
    await expect(page).toHaveURL(/\/learn\?category=/);

    // Question #43 of 35 in this category sorts onto the list's second page
    // (20 per page, `LearnPage.tsx`'s `LIST_PAGE_SIZE`).
    await page.getByRole('link', { name: 'Go to page 2' }).click();

    await page
      .getByRole('link', { name: 'Governor of your state now' })
      .click();
    await expect(
      page.getByRole('heading', { level: 3, name: /Governor of your state now/ }),
    ).toBeVisible();
    const governorQuestionUrl = page.url();

    // Resolved, not the `state_required` notice: this learner's plan does
    // carry a state.
    await expect(page.getByText('Set your state to see this answer')).toHaveCount(0);
    // Per-state provenance line — confirms this really is a state-scoped
    // resolution, not a coincidence of the fixture.
    await expect(page.getByText(/This is the answer for /)).toBeVisible();
    await expect(page.getByText(/^Current as of /)).toBeVisible();

    const oldGovernorAnswer = (await answerParagraph(page).textContent())?.trim();
    expect(oldGovernorAnswer).toBeTruthy();

    // -------------------------------------------------------------------------
    // 2. Open "Who is the President of the United States now?" specifically
    //    — the epic's named case. National scope: resolves for every learner
    //    with no per-state line, and — per the header — asserted only for
    //    STRUCTURE (an answer rendered, dated), never for a name.
    // -------------------------------------------------------------------------
    await page.goto('/learn');
    await page.getByRole('link', { name: 'System of Government' }).click();
    // #28 sorts onto the list's first page; no extra pagination needed.
    // "name of the President" (not just "President of the United States
    // now") to avoid also matching #29's "name of the Vice President of the
    // United States now?" — that substring is shared by both prompts.
    await page
      .getByRole('link', { name: 'name of the President of the United States now' })
      .click();
    await expect(
      page.getByRole('heading', {
        level: 3,
        name: /President of the United States now/,
      }),
    ).toBeVisible();

    await expect(page.getByText('Set your state to see this answer')).toHaveCount(0);
    await expect(
      page.getByText('No answer has been recorded for this question yet.'),
    ).toHaveCount(0);
    // National scope: no per-state provenance line.
    await expect(page.getByText(/This is the answer for /)).toHaveCount(0);
    await expect(page.getByText(/^Current as of /)).toBeVisible();
    const presidentAnswer = (await answerParagraph(page).textContent())?.trim();
    expect(presidentAnswer).toBeTruthy();

    // -------------------------------------------------------------------------
    // 3. Flashcard mode: reveal an answer, assert no score is shown anywhere.
    //    `FlashcardStudy`'s whole design is recognition with no grading — see
    //    that component's header — so this asserts the absence is total, not
    //    merely that one particular scoring widget is missing.
    // -------------------------------------------------------------------------
    await page.goto('/learn');
    await page
      .getByRole('link', { name: 'Study all questions with flashcards' })
      .click();
    await expect(
      page.getByRole('heading', { level: 2, name: 'Flashcards' }),
    ).toBeVisible();
    await expect(page.getByText(/^Card 1 of /)).toBeVisible();
    await expect(
      page.getByText('Nothing here is marked or counted against you.'),
    ).toBeVisible();

    await expect(page.getByRole('button', { name: 'Show answer' })).toBeVisible();
    await page.getByRole('button', { name: 'Show answer' }).click();

    // The reveal happened — the primary control relabels — but nothing about
    // whether the learner "got it" is anywhere on screen.
    await expect(
      page.getByRole('button', { name: /Next question|Start over/ }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { level: 4, name: 'Answer' })).toBeVisible();
    await expect(page.getByText(/\bscore\b/i)).toHaveCount(0);
    await expect(page.getByText(/\bcorrect\b/i)).toHaveCount(0);
    await expect(page.getByText(/\bincorrect\b/i)).toHaveCount(0);
    await expect(page.getByText(/\bgrade[ds]?\b/i)).toHaveCount(0);
    await expect(page.getByRole('button', { name: /correct/i })).toHaveCount(0);

    // -------------------------------------------------------------------------
    // 4. As an admin, correct the governor answer for the learner's state
    //    (CA), with a source note. A separate browser context: the admin and
    //    the learner are two different, simultaneously live sessions, and the
    //    learner's session must survive untouched while this happens.
    // -------------------------------------------------------------------------
    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    await loginAsTestUser(adminPage, {
      email: testEmail('admin'),
      role: 'admin',
    });
    await expect(adminPage).toHaveURL('/');
    // Same pinned instant as the learner — see header.
    await adminPage.setExtraHTTPHeaders({ 'X-Test-Clock': PINNED_NOW });

    await adminPage.goto('/admin/settings/civics');
    await expect(
      adminPage.getByRole('heading', { level: 1, name: 'Civics Answers' }),
    ).toBeVisible();

    // All five dynamic questions fit on one unfiltered page (CIVICS_PAGE_SIZE
    // is 20), so no scope filter or pagination is needed to find this one.
    await adminPage
      .getByRole('button', { name: /Governor of your state now/ })
      .click();

    const NEW_GOVERNOR_ANSWER = `E2E-corrected governor answer ${randomUUID()}`;
    const SOURCE_NOTE = 'civics-learn.spec.ts (issue #132) — test correction, not a real citation.';

    // The exact label, not a pattern: three state-scope questions (Senator,
    // Representative, Governor) each have their own "Correct the answer for
    // CA on question N" button, and only the question NUMBER tells them
    // apart — stable, official numbering (`QuestionList.tsx`'s header), so
    // hardcoding it here is safe.
    await adminPage
      .getByRole('button', { name: 'Correct the answer for CA on question 43' })
      .click();

    // Scoped to the dialog throughout: the accordion row BEHIND it still
    // shows the pre-correction text until the write actually lands, so an
    // unscoped `getByText(oldGovernorAnswer)` would match twice.
    const dialog = adminPage.getByRole('dialog');

    // Step 1 of the dialog: the confirm step names the CURRENT value, which
    // must be exactly what the learner was just shown.
    await expect(dialog.getByText(oldGovernorAnswer!)).toBeVisible();

    await adminPage.getByLabel('New answer').fill(NEW_GOVERNOR_ANSWER);
    await adminPage.getByLabel('Source').fill(SOURCE_NOTE);
    // "Effective from" left blank — the server clock (pinned) stands in.
    await adminPage.getByRole('button', { name: 'Review correction' }).click();

    // Step 2: the confirmation names both the old and the new value before
    // the write happens.
    await expect(
      dialog.getByRole('heading', { name: 'Review this correction' }),
    ).toBeVisible();
    await expect(dialog.getByText(oldGovernorAnswer!)).toBeVisible();
    await expect(dialog.getByText(NEW_GOVERNOR_ANSWER)).toBeVisible();

    await adminPage.getByRole('button', { name: 'Record correction' }).click();

    // The result: BOTH rows named, and the pinned date on the new one.
    // Scoped to the success `role="status"` banner (`AlertTitle` renders a
    // styled `<div>`, not a heading element, hence `getByText` rather than
    // `getByRole('heading', ...)`) — the accordion row behind it now ALSO
    // shows the new text (the list is merged in place, not refetched), so an
    // unscoped `getByText(NEW_GOVERNOR_ANSWER)` would match twice here too.
    const successBanner = adminPage.getByRole('status');
    await expect(successBanner.getByText(/New answer recorded/)).toBeVisible();
    await expect(successBanner.getByText(PINNED_DAY_SHORT)).toBeVisible();
    await expect(successBanner.getByText(NEW_GOVERNOR_ANSWER)).toBeVisible();
    await expect(
      successBanner.getByText(/is now the answer learners see/),
    ).toBeVisible();
    await expect(successBanner.getByText(oldGovernorAnswer!)).toBeVisible();
    await expect(successBanner.getByText(/was closed as of/)).toBeVisible();

    await adminContext.close();

    // -------------------------------------------------------------------------
    // 5. Back as the learner: reload the same question. New answer, new
    //    verified-as-of date, and the superseded answer nowhere on the page.
    // -------------------------------------------------------------------------
    await page.goto(governorQuestionUrl);
    await expect(
      page.getByRole('heading', { level: 3, name: /Governor of your state now/ }),
    ).toBeVisible();

    await expect(page.getByText(NEW_GOVERNOR_ANSWER)).toBeVisible();
    await expect(
      page.getByText(`Current as of ${PINNED_DAY_LONG}.`),
    ).toBeVisible();

    // The prior answer is gone from the only learner-facing surface it was
    // ever shown on.
    await expect(page.getByText(oldGovernorAnswer!)).toHaveCount(0);

    const newGovernorAnswer = (await answerParagraph(page).textContent())?.trim();
    expect(newGovernorAnswer).toBe(NEW_GOVERNOR_ANSWER);
  });
});

test.describe('State required (docs/specs/civics-content.md §5)', () => {
  test('a learner with no state on file sees the honest unresolved message, never a national answer', async ({
    page,
  }) => {
    // A real, fully onboarded learner (state CA) — see the header on why no
    // real account can ever have a null `state_code` here. The ONE network
    // response for the question this test opens is rewritten into the exact
    // `state_required` shape the API contract documents; everything else
    // (login, categories, the rest of the app) is the real backend.
    await page.route('**/api/civics/questions/*', async (route) => {
      const response = await route.fetch();
      const json = await response.json();
      if (json?.data?.dynamicScope === 'state') {
        json.data.answerResolution = 'state_required';
        json.data.answers = [];
        json.data.resolvedForStateCode = null;
        json.data.verifiedAt = null;
      }
      await route.fulfill({ response, json });
    });

    await loginAsTestUser(page, { email: testEmail('no-state') });
    await expect(page).toHaveURL('/');

    await page.goto('/learn');
    await page.getByRole('link', { name: 'System of Government' }).click();
    await page.getByRole('link', { name: 'Go to page 2' }).click();
    await page
      .getByRole('link', { name: 'Governor of your state now' })
      .click();
    await expect(
      page.getByRole('heading', { level: 3, name: /Governor of your state now/ }),
    ).toBeVisible();

    // The honest unresolved message — never a national or a guessed answer.
    const notice = page.getByRole('status').filter({
      hasText: 'Set your state to see this answer',
    });
    await expect(notice).toBeVisible();
    const setStateLink = notice.getByRole('link', { name: 'Set your state' });
    await expect(setStateLink).toHaveAttribute('href', '/settings/journey');

    // Neither of the OTHER two answer states rendered instead.
    await expect(
      page.getByText('No answer has been recorded for this question yet.'),
    ).toHaveCount(0);
    await expect(page.getByText(/^Current as of /)).toHaveCount(0);
    await expect(page.getByText(/This is the answer for /)).toHaveCount(0);
  });
});
