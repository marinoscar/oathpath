import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { seedOnboarding } from '../helpers/auth.helper';
import {
  fetchAcceptedAnswer,
  fetchNextQuestionId,
} from '../helpers/practice-questions';

// =============================================================================
// coach-personality.spec.ts — issue #323, epic #305 (E14 "The Coach's
// personality")
// =============================================================================
//
// The epic's own end-to-end acceptance, walked as a learner walks it:
//
//   "A learner opens `/settings/coach`, picks Playful, reads the sample and
//    presses to hear it, starts a Quick 5, answers one question wrong, and
//    reads a playful reaction line beside an UNCHANGED `Not a match` verdict
//    chip. They switch to Supportive; the next reaction changes and nothing
//    else on the screen does. They revisit the completed session and see the
//    SAME line they were given live."
//
// Four scenarios, mapping onto `docs/specs/coach-personality.md`:
//
//   1. Pick a persona, read a sample, hear one           -> §5, §8
//   2. A reaction beside an unchanged verdict            -> §4.1, §11
//   3. The same attempt shows the same line on re-read   -> §7, §9
//   4. Reactions off means silence, not a placeholder    -> §8
//
// -----------------------------------------------------------------------------
// WHAT THIS CHECKS THAT NO UNIT TEST CAN
// -----------------------------------------------------------------------------
//
// Every claim below is asserted somewhere in the unit suites already —
// `AiFeedbackCard.test.tsx` renders a reaction from a fixture,
// `CoachSettingsPage.test.tsx` drives the picker against MSW,
// `reaction-lines.spec.ts` lints the bank. What none of them can see is the
// SEAM: that the persona a learner stores through `PATCH /api/user-settings`
// is the persona `PracticeService` resolves when it maps an attempt, and that
// the line chosen there survives a real HTTP response, a real render, and a
// real re-read. Three layers agreeing in a fixture is not the same claim as
// three layers agreeing over the wire.
//
// -----------------------------------------------------------------------------
// KEYED TO POSITION AND TO THE BANK'S SHAPE, NEVER TO A LITERAL LINE
// -----------------------------------------------------------------------------
//
// `reactionLine` is deterministic in the attempt id, and an attempt id is a
// uuid the server mints. So WHICH of a cell's lines a learner gets is not
// knowable in advance from here, and asserting a literal string would make
// this spec fail the first time somebody adds a fifth line to a cell — a
// content edit that breaks nothing.
//
// What IS knowable, and is what this asserts:
//   * a reaction is present at all, on a deterministically-graded attempt;
//   * it is the SAME string on a second read of the same attempt;
//   * it CHANGES when the persona changes;
//   * the verdict chip and its sentence do not change, ever.
//
// -----------------------------------------------------------------------------
// EXECUTION
// -----------------------------------------------------------------------------
//
// Every selector, route, copy string and DTO field below was read out of the
// shipped source — `apps/web/src/pages/CoachSettingsPage.tsx`,
// `apps/web/src/components/settings/CoachSettings.tsx`,
// `apps/web/src/components/practice/AiFeedbackCard.tsx`,
// `apps/web/src/components/practice/outcome.ts`,
// `apps/api/src/ai/coach/*` and `apps/api/src/practice/practice.service.ts` —
// never invented. `npx tsc --noEmit -p tests/e2e/tsconfig.json` passes clean.
//
// This sandbox has no Docker daemon for `playwright.config.ts`'s own
// `webServer` and no reachable API at `http://localhost:3535`, so the suite
// itself was **NOT EXECUTED** — the same standing situation every spec in
// this directory records for itself, and the same one `ROADMAP.md` §6 counts
// as a human check rather than something a green `main` implies. See the PR
// that added this file for exactly what was verified another way.
// =============================================================================

/** The four persona labels, in the order `AI_COACH_PERSONAS` declares them. */
const PERSONA_LABELS = ['Supportive', 'Academic', 'Playful', 'Unfiltered'];

/**
 * The reaction line currently on screen, or `null`.
 *
 * `role="status"` is what `AiFeedbackCard` gives the line, and it is the only
 * status region on the practice screen's feedback card — read that component
 * before widening this selector.
 */
async function readReaction(page: import('@playwright/test').Page) {
  const status = page.getByRole('status');
  if ((await status.count()) === 0) return null;
  const text = (await status.first().textContent())?.trim();
  return text && text.length > 0 ? text : null;
}

/** Answer the current question wrong and wait for the verdict. */
async function answerWrong(page: import('@playwright/test').Page) {
  await page
    .getByLabel('Your answer')
    .fill('This response is deliberately wrong and matches no accepted answer.');
  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(page.getByText('Not a match', { exact: true })).toBeVisible();
}

test.describe('E14 — the coach a learner chose', () => {
  test('a learner picks a persona, hears a sample, and reads it beside an unchanged verdict', async ({
    page,
  }) => {
    const email = `coach-${randomUUID()}@example.com`;
    const { accessToken } = await seedOnboarding(page, { email });
    const authHeaders = { Authorization: `Bearer ${accessToken}` };

    // -----------------------------------------------------------------------
    // 1. `/settings/coach` — four personas, every sample readable with no
    //    press at all. §5: for `unfiltered` in particular that is the
    //    difference between choosing a blunt coach and discovering one.
    // -----------------------------------------------------------------------
    await page.goto('/settings/coach');

    for (const label of PERSONA_LABELS) {
      await expect(
        page.getByRole('radio', { name: new RegExp(label) }),
      ).toBeVisible();
    }

    // Supportive is the default, and nothing was stored to make it so.
    await expect(
      page.getByRole('radio', { name: /Supportive/ }),
    ).toBeChecked();

    const settingsBefore = await page.request.get('/api/user-settings', {
      headers: authHeaders,
    });
    expect(settingsBefore.ok()).toBe(true);
    const before = (await settingsBefore.json()) as {
      data: { coach?: unknown };
    };
    // ABSENT, not `{ persona: 'supportive' }`. Rendering the default must not
    // write it — see `coach-personality.md` §8 and the settings page's own
    // rule C.
    expect(before.data.coach).toBeUndefined();

    // `unfiltered` is never preselected and says what it is before it is
    // chosen (§5).
    await expect(
      page.getByRole('radio', { name: /Unfiltered/ }),
    ).not.toBeChecked();
    await expect(page.getByText(/Blunt and irreverent/)).toBeVisible();

    // -----------------------------------------------------------------------
    // 2. Pick Playful, and hear its sample on an EXPLICIT press.
    // -----------------------------------------------------------------------
    await page.getByRole('radio', { name: /Playful/ }).click();
    await expect(page.getByText('Coach preferences updated')).toBeVisible();

    // Stored, and only the field that changed.
    const settingsAfter = await page.request.get('/api/user-settings', {
      headers: authHeaders,
    });
    const after = (await settingsAfter.json()) as {
      data: { coach?: { persona?: string; reactions?: boolean } };
    };
    expect(after.data.coach?.persona).toBe('playful');
    expect(after.data.coach?.reactions).toBeUndefined();

    // The Hear control exists only when `speak` is bound. Both states are
    // correct — `voice.md` §2 — so this presses it when it is there and says
    // nothing when it is not, rather than failing on a deployment that has
    // not bound a speech model.
    const hearPlayful = page.getByRole('button', {
      name: 'Hear the Playful sample',
    });
    if ((await hearPlayful.count()) > 0) {
      await hearPlayful.click();
      // Announced either way: playing, or a plain reason it could not.
      await expect(page.getByRole('status').first()).not.toBeEmpty();
    }

    // -----------------------------------------------------------------------
    // 3. A Quick 5, one wrong answer, and the coach speaks.
    // -----------------------------------------------------------------------
    await page.goto('/practice');
    await page.getByRole('button', { name: 'Start a Quick 5' }).click();
    await expect(page).toHaveURL(/\/practice\/sessions\/[0-9a-f-]{36}$/);
    const sessionId = page.url().split('/').pop();
    if (!sessionId) throw new Error('Could not read the session id from the URL.');

    await answerWrong(page);

    // THE HEADLINE. A deterministic `exact` grade makes no AI call, so before
    // E14 this card said nothing beyond the verdict.
    const playfulLine = await readReaction(page);
    expect(playfulLine, 'a reaction line beside the verdict').toBeTruthy();

    // THE VERDICT DID NOT MOVE. `VISION.md` Principle #11 — a beautiful wrong
    // answer is still wrong.
    await expect(page.getByText('Not a match', { exact: true })).toBeVisible();
    await expect(
      page.getByText(/doesn.t match an accepted answer/),
    ).toBeVisible();

    // And the line is not the verdict repeated back.
    expect(playfulLine).not.toContain('Not a match');

    // -----------------------------------------------------------------------
    // 4. The SAME attempt, read again, shows the SAME line (§7, §9).
    //
    //    Nothing was stored to make this true: the line is recomputed from
    //    the attempt's own id every time it is read. That is the whole reason
    //    `reactionLine` is deterministic in a seed rather than random.
    // -----------------------------------------------------------------------
    await page.reload();
    await expect(page.getByText('Not a match', { exact: true })).toBeVisible();
    expect(await readReaction(page)).toBe(playfulLine);

    // -----------------------------------------------------------------------
    // 5. Switch to Supportive. The next reaction changes; the verdict does
    //    not.
    // -----------------------------------------------------------------------
    await page.goto('/settings/coach');
    await page.getByRole('radio', { name: /Supportive/ }).click();
    await expect(page.getByText('Coach preferences updated')).toBeVisible();

    // Returning to the default DELETES the field rather than writing it, so
    // this learner keeps moving with the default if it ever changes (§8).
    const settingsBack = await page.request.get('/api/user-settings', {
      headers: authHeaders,
    });
    const back = (await settingsBack.json()) as { data: { coach?: unknown } };
    expect(back.data.coach).toBeUndefined();

    // Re-read the SAME attempt under the new persona. The line changes
    // because the persona did; the verdict is untouched.
    await page.goto(`/practice/sessions/${sessionId}`);
    await expect(page.getByText('Not a match', { exact: true })).toBeVisible();

    const supportiveLine = await readReaction(page);
    expect(supportiveLine, 'a reaction under the new persona').toBeTruthy();
    expect(supportiveLine).not.toBe(playfulLine);

    // NOTHING ELSE ON THE SCREEN MOVED.
    await expect(
      page.getByText(/doesn.t match an accepted answer/),
    ).toBeVisible();
  });

  test('turning reactions off leaves silence, not an empty space', async ({
    page,
  }) => {
    const email = `coach-quiet-${randomUUID()}@example.com`;
    const { accessToken } = await seedOnboarding(page, { email });
    const authHeaders = { Authorization: `Bearer ${accessToken}` };

    await page.goto('/settings/coach');

    // The switch is on for an untouched account, and nothing is stored.
    const toggle = page.getByLabel('Show a line from your coach');
    await expect(toggle).toBeChecked();

    await toggle.click();
    await expect(page.getByText('Coach preferences updated')).toBeVisible();

    const stored = await page.request.get('/api/user-settings', {
      headers: authHeaders,
    });
    const body = (await stored.json()) as {
      data: { coach?: { reactions?: boolean } };
    };
    expect(body.data.coach?.reactions).toBe(false);

    // A session, a wrong answer, and no coach line — but the verdict is
    // exactly as complete as it always was.
    await page.goto('/practice');
    await page.getByRole('button', { name: 'Start a Quick 5' }).click();
    await expect(page).toHaveURL(/\/practice\/sessions\/[0-9a-f-]{36}$/);

    await answerWrong(page);

    expect(await readReaction(page)).toBeNull();
    await expect(
      page.getByText(/doesn.t match an accepted answer/),
    ).toBeVisible();
  });

  test('a correct answer gets a reaction too, and the verdict stays correct', async ({
    page,
  }) => {
    const email = `coach-correct-${randomUUID()}@example.com`;
    const { accessToken } = await seedOnboarding(page, { email });
    const authHeaders = { Authorization: `Bearer ${accessToken}` };

    // Academic, so the line comes from a cell no other test in this file
    // reads — the bank is four personas wide and a spec that only ever
    // exercises one of them proves less than it looks like it does.
    await page.goto('/settings/coach');
    await page.getByRole('radio', { name: /Academic/ }).click();
    await expect(page.getByText('Coach preferences updated')).toBeVisible();

    await page.goto('/practice');
    await page.getByRole('button', { name: 'Start a Quick 5' }).click();
    await expect(page).toHaveURL(/\/practice\/sessions\/[0-9a-f-]{36}$/);
    const sessionId = page.url().split('/').pop();
    if (!sessionId) throw new Error('Could not read the session id from the URL.');

    // The answer a prepared learner already knows, read from the public
    // content API rather than from anything the page rendered.
    const questionId = await fetchNextQuestionId(page, authHeaders, sessionId);
    const accepted = await fetchAcceptedAnswer(page, authHeaders, questionId);

    await page.getByLabel('Your answer').fill(accepted);
    await page.getByRole('button', { name: 'Submit' }).click();

    await expect(page.getByText('Correct', { exact: true })).toBeVisible();
    await expect(
      page.getByText('That matches an accepted answer.'),
    ).toBeVisible();

    const line = await readReaction(page);
    expect(line, 'a reaction on a correct answer').toBeTruthy();

    // The reaction says something; it does not restate the verdict, and it
    // certainly does not state an answer — the bank carries no facts (§4.1).
    expect(line).not.toContain(accepted);
  });
});
