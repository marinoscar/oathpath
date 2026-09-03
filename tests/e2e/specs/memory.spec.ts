import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { seedOnboarding } from '../helpers/auth.helper';
import { fetchAcceptedAnswer } from '../helpers/practice-questions';

// =============================================================================
// memory.spec.ts — issue #98, epic #54 (E5 "Memory")
// =============================================================================
//
// The epic's own acceptance criteria, end to end against the real shipped
// scheduler (`apps/api/src/practice/mastery/scheduler.ts`), selector
// (`apps/api/src/practice/mastery/selector.ts`), Study Coach
// (`apps/api/src/journey/study-coach.ts`) and the three UI surfaces that read
// them: `/practice` (queue counts, #90), `/` (Home's Next-up card, #82) and
// `/progress` (coverage and mastery, #86/#94).
//
// -----------------------------------------------------------------------------
// WHY THE "LEARNING -> DUE" FLOW ANSWERS THE SAME QUESTION TWICE, NOT ONCE
// -----------------------------------------------------------------------------
//
// The epic body (as handed to this spec) reads: "Answer a question correctly
// -> it enters `learning`, due tomorrow -> advance the test clock a day -> it
// appears in a review session". Read literally that is ONE correct answer.
// The REAL shipped `classifyMasteryBucket` (`mastery/selector.ts`) — the exact
// function both `GET /api/practice/queue`'s `due` count and a session's own
// question ordering read — disagrees: its `due` bucket is
// `state IN ('review', 'lapsed') AND dueAt <= now`, and a single correct
// answer only ever produces `state: 'learning'` (`scheduler.ts`'s
// `nextStateOnCorrect`, the `'new' -> 'learning'` branch). A `learning`
// question, however overdue, classifies as `steady`, never `due` — there is
// no code path that puts it in the due bucket on one correct answer alone.
//
// `docs/specs/memory-model.md` §3.8's own worked table (Rows 1-2) and its §11
// footer — written for this exact issue — name the real mechanism: `learning`
// graduates to `review` "on the very next correct answer regardless of
// `correctStreak`'s value". So this spec answers the question correctly
// TWICE, on two DISTINCT test-clock days, exactly matching Rows 1 and 2:
//
//   Row 1 (Day 1, first-ever correct):  new -> learning,   dueAt = Day 2
//   Row 2 (Day 2, second correct):      learning -> review, dueAt = Day 5
//                                        (`SECOND_REPETITION_INTERVAL_DAYS`, 3)
//
// Advancing the clock to Day 2 for Row 2 is "advance the test clock a day"
// from the epic text, verbatim — a learner returning on the question's own
// due date and getting it right again is the realistic action that text
// describes. What differs from a literal reading is that ONE MORE clock
// advance (to Day 5, Row 2's own `dueAt`) is needed before the question is
// actually `due` and actually drives the Study Coach's `review` rung
// (`recommendStudyAction`'s `reviewCount = dueCount + lapsedCount > 0` gate) —
// which is the moment this spec asserts against, because it is the moment the
// real code produces it.
//
// -----------------------------------------------------------------------------
// WHY EVERY DAY ADVANCE IS A LITERAL, HARDCODED ISO CONSTANT
// -----------------------------------------------------------------------------
//
// `nextSchedule`'s distinct-day rule compares UTC CALENDAR dates
// (`isSameUtcCalendarDay`), so each pinned instant below is fixed at noon UTC
// — nowhere near a day boundary — and the next one is exactly 24h later,
// which is always exactly one more UTC calendar day. Literal strings, not
// computed date arithmetic, so each value is checkable by inspection against
// `docs/specs/memory-model.md` §3.8's own worked numbers.
//
// -----------------------------------------------------------------------------
// `X-Test-Clock` ON THE PAGE VS. ON `page.request` — SEE `docs/TESTING.md`
// -----------------------------------------------------------------------------
//
// `page.setExtraHTTPHeaders` pins every `fetch` the mounted React app makes
// (session detail reads, the Submit button's own `POST .../attempts`), but it
// does NOT apply to `page.request` — a separate `APIRequestContext`. Every
// direct `page.request` call below that needs the pinned clock (creating a
// session, submitting an attempt against a specific question, reading the
// queue or the categories/questions catalog) therefore carries
// `'X-Test-Clock'` explicitly in its own headers, even though the page's
// header is *also* kept in sync via `setExtraHTTPHeaders` for the UI-driven
// steps.
//
// -----------------------------------------------------------------------------
// WHY REPEATED DIRECT SUBMISSIONS AGAINST THE SAME QUESTION ARE NOT A BYPASS
// -----------------------------------------------------------------------------
//
// `PracticeController`'s own Swagger description says it plainly: "One
// attempt per question per session: a repeat is a 409. **Answering a question
// again is a new session.**" `ai-evaluation.spec.ts` (#131) already
// establishes the mechanics this spec reuses: `recordAttempt` validates a
// submitted `questionId` only against the session's test version (and
// category, for a `category` session) — never against whatever the session's
// own `nextQuestion` happened to draw — so creating a fresh `quick` session
// and posting a specific, already-known `questionId` against it is a real,
// fully-graded attempt every time, not a bypass of anything the endpoint
// enforces. This is the ONLY way to answer one chosen question repeatedly at
// all: `PracticeService`'s selector is unseen-first / bucket-ordered and will
// not hand a Quick 5 the same question twice by chance, let alone five times
// running against a ~100-question bank.
// =============================================================================

function testEmail(label: string): string {
  return `memory-${label}-${randomUUID()}@test.local`;
}

interface CreateSessionResponse {
  data: {
    session: { id: string; testVersionCode: string };
    nextQuestion: { id: string } | null;
  };
}

interface AttemptResponse {
  data: {
    attempt: { outcome: string; gradingMethod: string };
  };
}

interface PracticeQueueApiResponse {
  data: { due: number; weak: number };
}

/** `POST /api/practice/sessions`, always `kind: 'quick', plannedCount: 1` — a
 *  single-question session, so this spec never has to account for what
 *  happens to any OTHER question in the bank. */
async function createOneQuestionSession(
  page: Page,
  headers: Record<string, string>,
): Promise<{ sessionId: string; nextQuestionId: string; testVersionCode: string }> {
  const response = await page.request.post('/api/practice/sessions', {
    headers,
    data: { kind: 'quick', plannedCount: 1 },
  });
  expect(response.ok(), 'POST /api/practice/sessions').toBe(true);
  const body = (await response.json()) as CreateSessionResponse;
  const nextQuestionId = body.data.nextQuestion?.id;
  if (!nextQuestionId) {
    throw new Error(
      'createOneQuestionSession: the new session reports no nextQuestion — ' +
        'is there any question left in this bank to serve?',
    );
  }
  return {
    sessionId: body.data.session.id,
    nextQuestionId,
    testVersionCode: body.data.session.testVersionCode,
  };
}

/**
 * A fresh `quick` session, immediately answered CORRECTLY against
 * `questionId` — regardless of whichever question that fresh session's own
 * `nextQuestion` actually drew. See this file's header for why that is a
 * real, fully-graded attempt and not a bypass.
 */
async function answerQuestionCorrectly(
  page: Page,
  headers: Record<string, string>,
  questionId: string,
): Promise<void> {
  const createResponse = await page.request.post('/api/practice/sessions', {
    headers,
    data: { kind: 'quick', plannedCount: 1 },
  });
  expect(createResponse.ok(), 'POST /api/practice/sessions').toBe(true);
  const createBody = (await createResponse.json()) as CreateSessionResponse;
  const sessionId = createBody.data.session.id;

  const accepted = await fetchAcceptedAnswer(page, headers, questionId);

  const attemptResponse = await page.request.post(
    `/api/practice/sessions/${sessionId}/attempts`,
    { headers, data: { questionId, responseText: accepted } },
  );
  expect(
    attemptResponse.ok(),
    `POST .../attempts — body: ${await attemptResponse.text().catch(() => '<unreadable>')}`,
  ).toBe(true);
  const attemptBody = (await attemptResponse.json()) as AttemptResponse;
  // Defensive: every attempt in this spec is chosen to be an exact match, so
  // a mismatch here means the fixture's assumption about the accepted answer
  // broke, not that the scheduler did anything wrong — fail loudly rather
  // than let a silently-`incorrect` attempt quietly wreck the day-count math
  // downstream.
  expect(
    attemptBody.data.attempt.outcome,
    `expected a correct attempt for question ${questionId}, got ` +
      JSON.stringify(attemptBody.data.attempt),
  ).toBe('correct');
  expect(attemptBody.data.attempt.gradingMethod).toBe('exact');
}

interface QuestionSummary {
  id: string;
  categoryId: string;
}
interface QuestionListResponse {
  data: { items: QuestionSummary[] };
}
interface CategoryListResponse {
  data: { id: string; name: string }[];
}

/**
 * The display name of the category `questionId` belongs to — read the public
 * way, the same `GET /api/civics/questions` + `GET
 * /api/civics/versions/:code/categories` pair `civics-learn.spec.ts` already
 * treats as public exam content, not a scrape of anything `/progress`
 * itself renders. Needed so this spec can scope its `/progress` assertions to
 * the ONE category its target question is actually in, rather than guessing
 * at one.
 */
async function findCategoryName(
  page: Page,
  headers: Record<string, string>,
  testVersionCode: string,
  questionId: string,
): Promise<string> {
  const listResponse = await page.request.get(
    // `pageSize=100`: `civics-2008.json` (this branch's seeded bank, per
    // `ai-evaluation.spec.ts`'s own header) has exactly 100 questions — the
    // query DTO's own maximum page size, and enough to cover it in one call.
    '/api/civics/questions?pageSize=100',
    { headers },
  );
  expect(listResponse.ok(), 'GET /api/civics/questions').toBe(true);
  const listBody = (await listResponse.json()) as QuestionListResponse;
  const question = listBody.data.items.find((item) => item.id === questionId);
  if (!question) {
    throw new Error(
      `findCategoryName: question ${questionId} not found among ` +
        `${listBody.data.items.length} questions returned.`,
    );
  }

  const categoriesResponse = await page.request.get(
    `/api/civics/versions/${testVersionCode}/categories`,
    { headers },
  );
  expect(categoriesResponse.ok(), 'GET /api/civics/versions/:code/categories').toBe(true);
  const categoriesBody = (await categoriesResponse.json()) as CategoryListResponse;
  const category = categoriesBody.data.find((c) => c.id === question.categoryId);
  if (!category) {
    throw new Error(
      `findCategoryName: category ${question.categoryId} not found among ` +
        `${categoriesBody.data.length} categories returned.`,
    );
  }
  return category.name;
}

/**
 * `/progress`'s per-category card renders `"{masteredCount} of
 * {totalQuestions} mastered"` as plain text inside a `region` named for the
 * category (`CategoryMasteryCard.tsx`: `Card component="section"
 * aria-labelledby={headingId}`, `h3` text = `category.categoryName`). Reads
 * the number back out rather than asserting the whole sentence, because this
 * spec does not know (and should not have to know) the category's
 * `totalQuestions`.
 */
async function readMasteredCount(page: Page, categoryName: string): Promise<number> {
  const region = page.getByRole('region', { name: categoryName });
  await expect(region).toBeVisible();
  const text = await region.getByText(/ of \d+ mastered$/).first().textContent();
  const match = text?.match(/^(\d+) of \d+ mastered$/);
  if (!match) {
    throw new Error(`readMasteredCount: could not parse "${text}" for category "${categoryName}"`);
  }
  return Number(match[1]);
}

/** The `dt`/`dd` pair `PracticeQueueSummary.tsx`'s `Stat` renders — `dt` the
 *  uppercase label, `dd` the count, siblings inside one enclosing `Box`. Same
 *  "walk to the label, then its very next sibling" idiom
 *  `ai-evaluation.spec.ts`'s `requestsValue` already uses for `/settings/ai`. */
async function queueStat(page: Page, label: string): Promise<string> {
  const dt = page.getByText(label, { exact: true });
  const dd = dt.locator('xpath=following-sibling::*[1]');
  return (await dd.textContent()) ?? '';
}

test.describe('Memory: learning to review to due (issue #98), epic #54 (E5)', () => {
  test('a question answered correctly on two distinct days graduates to review, becomes due, and drives the Study Coach', async ({
    page,
  }) => {
    // See this file's header: Row 1 on Day 1, Row 2 on Day 2, `due` confirmed
    // on Day 5 (Row 2's own `dueAt`, `SECOND_REPETITION_INTERVAL_DAYS`, 3).
    const DAY1 = '2026-04-06T12:00:00Z';
    const DAY2 = '2026-04-07T12:00:00Z';
    const DAY5 = '2026-04-10T12:00:00Z';

    const email = testEmail('review-flow');
    const { accessToken } = await seedOnboarding(page, {
      email,
      onboarding: 'full',
    });
    await page.waitForURL('/', { timeout: 10000 });
    const authHeaders = { Authorization: `Bearer ${accessToken}` };

    // Pinned from here on, on the PAGE — rides along on every fetch the
    // mounted app itself makes (the UI-driven Row 1 answer below, and the
    // `/practice` and `/` reads at the end). `page.request` calls below still
    // carry it explicitly — see the header.
    await page.setExtraHTTPHeaders({ 'X-Test-Clock': DAY1 });

    // -------------------------------------------------------------------------
    // ROW 1 (Day 1): a single-question Quick 5, answered correctly THROUGH THE
    // REAL UI — the epic's own "answer a question correctly in a practice
    // session", exercised for real rather than only over the API.
    // -------------------------------------------------------------------------
    const day1Headers = { ...authHeaders, 'X-Test-Clock': DAY1 };
    const { sessionId, nextQuestionId: targetQuestionId } =
      await createOneQuestionSession(page, day1Headers);

    await page.goto(`/practice/sessions/${sessionId}`);
    await expect(page.getByText('Question 1 of 1')).toBeVisible();

    const acceptedAnswer = await fetchAcceptedAnswer(page, day1Headers, targetQuestionId);
    await page.getByLabel('Your answer').fill(acceptedAnswer);
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page.getByText('Correct', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'See your summary' }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Practice summary' }),
    ).toBeVisible();

    // -------------------------------------------------------------------------
    // Advance to Day 2 — Row 1's own `dueAt` — and answer the SAME question
    // correctly again. `learning` -> `review` fires on this very next correct
    // answer (scheduler.ts's `nextStateOnCorrect`), independent of same-day
    // vs. distinct-day bookkeeping (that only matters for `distinctCorrectDays`
    // / mastery promotion — this flow's own next test).
    // -------------------------------------------------------------------------
    await page.setExtraHTTPHeaders({ 'X-Test-Clock': DAY2 });
    const day2Headers = { ...authHeaders, 'X-Test-Clock': DAY2 };
    await answerQuestionCorrectly(page, day2Headers, targetQuestionId);

    // -------------------------------------------------------------------------
    // Advance to Day 5 — Row 2's own `dueAt` (interval 3 days,
    // `SECOND_REPETITION_INTERVAL_DAYS`) — the first instant `state: 'review'`
    // AND `dueAt <= now` both hold, i.e. the first instant
    // `classifyMasteryBucket` actually returns `'due'` for this question.
    // -------------------------------------------------------------------------
    await page.setExtraHTTPHeaders({ 'X-Test-Clock': DAY5 });

    // `/practice`'s "Your queue" band: exactly one question due, none weak —
    // `PracticeQueueSummary.tsx`'s own headline for `reviewCount === 1`.
    await page.goto('/practice');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Practice' }),
    ).toBeVisible();
    await expect(page.getByText('1 question ready to review.')).toBeVisible();
    expect(await queueStat(page, 'Due')).toBe('1');
    expect(await queueStat(page, 'Weak')).toBe('0');

    // Cross-check against the API directly — the UI text above is read FROM
    // this response, so this confirms the assertion is not merely a stale
    // rendering.
    const queueResponse = await page.request.get('/api/practice/queue', {
      headers: { ...authHeaders, 'X-Test-Clock': DAY5 },
    });
    expect(queueResponse.ok(), 'GET /api/practice/queue').toBe(true);
    const queueBody = (await queueResponse.json()) as PracticeQueueApiResponse;
    expect(queueBody.data.due).toBe(1);
    expect(queueBody.data.weak).toBe(0);

    // Home's Next-up card: `recommendStudyAction`'s `review` rung
    // (`study-coach.ts`), title and reason copied VERBATIM from that file —
    // `reviewTitle(1)` and its template literal for `reviewCount === 1`. Not
    // "4 reviews ready" (the epic text's own illustrative number) — this
    // learner has exactly one question in the due-or-weak pool, and the
    // reason sentence's count is always the number that made the card
    // appear (`study-coach.ts`'s own "JUDGMENT CALL" comment).
    await page.goto('/');
    await expect(page.getByText('Review 1 question.')).toBeVisible();
    await expect(
      page.getByText(
        "You have 1 question ready to review — reviewing what you've already learned keeps it from slipping.",
      ),
    ).toBeVisible();
    const reviewLink = page.getByRole('link', { name: 'Go to Practice' });
    await expect(reviewLink).toHaveAttribute('href', '/practice');
  });
});

test.describe('Memory: verified mastery needs three distinct days (issue #98), epic #54 (E5)', () => {
  test('three same-day corrects do not master a question; three distinct-day corrects do', async ({
    page,
  }) => {
    // `nextSchedule`'s `MASTERY_PROMOTION_THRESHOLD` is 3 `distinctCorrectDays`
    // while `state: 'review'`. Trace, per `scheduler.ts`'s own state machine:
    //
    //   Attempt 1 (Day A): new -> learning,  distinctCorrectDays 0 -> 1
    //   Attempt 2 (Day A): learning -> review (unconditional on 2nd correct),
    //                      SAME day as #1 -> distinctCorrectDays stays 1
    //   Attempt 3 (Day A): review -> review (1 < 3),
    //                      SAME day as #1/#2 -> distinctCorrectDays stays 1
    //   -- three corrects, one distinct day: NOT mastered. --
    //   Attempt 4 (Day B): review -> review (2 < 3),
    //                      NEW day -> distinctCorrectDays 1 -> 2
    //   Attempt 5 (Day C): review -> MASTERED (3 >= 3),
    //                      NEW day -> distinctCorrectDays 2 -> 3
    //   -- two MORE corrects, two more distinct days (three total): mastered. --
    const DAY_A = '2026-05-04T12:00:00Z';
    const DAY_B = '2026-05-05T12:00:00Z';
    const DAY_C = '2026-05-06T12:00:00Z';

    const email = testEmail('mastery');
    const { accessToken } = await seedOnboarding(page, {
      email,
      onboarding: 'full',
    });
    await page.waitForURL('/', { timeout: 10000 });
    const authHeaders = { Authorization: `Bearer ${accessToken}` };

    await page.setExtraHTTPHeaders({ 'X-Test-Clock': DAY_A });
    const dayAHeaders = { ...authHeaders, 'X-Test-Clock': DAY_A };

    // Pick the target question the same way `createOneQuestionSession` does
    // for the sibling spec above — whichever question a fresh Quick 5 draws —
    // and hold onto its id for every attempt below. `testVersionCode` is
    // needed to resolve this question's category for the `/progress` reads.
    const { nextQuestionId: targetQuestionId, testVersionCode } =
      await createOneQuestionSession(page, dayAHeaders);
    const categoryName = await findCategoryName(
      page,
      dayAHeaders,
      testVersionCode,
      targetQuestionId,
    );

    // -------------------------------------------------------------------------
    // THREE corrects, immediate succession, all on Day A.
    // -------------------------------------------------------------------------
    await answerQuestionCorrectly(page, dayAHeaders, targetQuestionId);
    await answerQuestionCorrectly(page, dayAHeaders, targetQuestionId);
    await answerQuestionCorrectly(page, dayAHeaders, targetQuestionId);

    await page.goto('/progress');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Progress' }),
    ).toBeVisible();
    expect(
      await readMasteredCount(page, categoryName),
      'three same-day corrects must NOT master the question',
    ).toBe(0);

    // -------------------------------------------------------------------------
    // A fourth correct, Day B — the second of three distinct days. Still not
    // mastered (distinctCorrectDays reaches 2, threshold is 3).
    // -------------------------------------------------------------------------
    await page.setExtraHTTPHeaders({ 'X-Test-Clock': DAY_B });
    const dayBHeaders = { ...authHeaders, 'X-Test-Clock': DAY_B };
    await answerQuestionCorrectly(page, dayBHeaders, targetQuestionId);

    await page.goto('/progress');
    expect(
      await readMasteredCount(page, categoryName),
      'two distinct days of corrects must still NOT master the question',
    ).toBe(0);

    // -------------------------------------------------------------------------
    // A fifth correct, Day C — the THIRD distinct day. Now mastered.
    // -------------------------------------------------------------------------
    await page.setExtraHTTPHeaders({ 'X-Test-Clock': DAY_C });
    const dayCHeaders = { ...authHeaders, 'X-Test-Clock': DAY_C };
    await answerQuestionCorrectly(page, dayCHeaders, targetQuestionId);

    await page.goto('/progress');
    expect(
      await readMasteredCount(page, categoryName),
      'three distinct days of corrects must master the question',
    ).toBe(1);

    // -------------------------------------------------------------------------
    // A light check that `/progress` is reflecting REAL evidence, not zeros:
    // this account has attempted exactly one question, ever (five attempts,
    // all against `targetQuestionId`) — `attempted` counts DISTINCT
    // questions, not attempts, so it must read exactly 1, not 0 and not 5.
    // -------------------------------------------------------------------------
    await expect(page.getByText(/^1 of \d+ questions attempted$/)).toBeVisible();
  });
});

test.describe('Memory: /progress renders real numbers (issue #98), epic #54 (E5)', () => {
  test('coverage and mastery on /progress reflect the attempts just made, not placeholders', async ({
    page,
  }) => {
    const email = testEmail('progress-numbers');
    const { accessToken } = await seedOnboarding(page, {
      email,
      onboarding: 'full',
    });
    await page.waitForURL('/', { timeout: 10000 });

    // No clock pinning needed here — this test makes no claim about `dueAt`
    // or distinct days, only that real attempts produce real, non-zero
    // numbers on the page (`VISION.md`'s honesty rule, the same one
    // `ProgressPage.tsx`'s own header states for its empty state).
    await page.goto('/practice');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Practice' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Start a Quick 5' }).click();
    await expect(page).toHaveURL(/\/practice\/sessions\/[0-9a-f-]{36}$/);
    const sessionId = page.url().split('/').pop();
    if (!sessionId) throw new Error('Could not read the session id from the URL.');

    const authHeaders = { Authorization: `Bearer ${accessToken}` };

    // Two questions is enough to prove the page is not showing a flat
    // zero: one exact-match correct, one skip. `PracticeSessionPage`'s own
    // "Question N of 5" still governs, so this stops after 2 of the planned
    // 5 — the session stays `in_progress`, which does not stop `/progress`
    // from counting the two attempts that were actually written.
    const answerField = page.getByLabel('Your answer');

    await expect(page.getByText('Question 1 of 5')).toBeVisible();
    const q1Response = await page.request.get(`/api/practice/sessions/${sessionId}`, {
      headers: authHeaders,
    });
    expect(q1Response.ok(), 'GET /api/practice/sessions/:id').toBe(true);
    const q1Body = (await q1Response.json()) as CreateSessionResponse;
    const q1Id = q1Body.data.nextQuestion?.id;
    if (!q1Id) throw new Error('Session reported no next question for position 1.');
    const q1Accepted = await fetchAcceptedAnswer(page, authHeaders, q1Id);
    await answerField.fill(q1Accepted);
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page.getByText('Correct', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Next question' }).click();

    await expect(page.getByText('Question 2 of 5')).toBeVisible();
    await page.getByRole('button', { name: 'Skip' }).click();
    await expect(page.getByText('Skipped', { exact: true })).toBeVisible();

    await page.goto('/progress');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Progress' }),
    ).toBeVisible();

    // Real numbers: exactly 2 of this bank's questions attempted (one correct,
    // one skipped — both count, per `ProgressController`'s own description:
    // `attempted = totalQuestions - byState.new`), never a placeholder "0 of
    // 0" or a chart rendered before any evidence exists.
    await expect(page.getByText(/^2 of \d+ questions attempted$/)).toBeVisible();
    const attemptedText = await page
      .getByText(/^2 of \d+ questions attempted$/)
      .textContent();
    const totalMatch = attemptedText?.match(/^2 of (\d+) questions attempted$/);
    expect(totalMatch, `unexpected "attempted" text: ${attemptedText}`).toBeTruthy();
    expect(Number(totalMatch![1])).toBeGreaterThan(2);
  });
});
