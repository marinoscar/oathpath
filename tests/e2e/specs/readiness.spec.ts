import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { seedOnboarding } from '../helpers/auth.helper';
import { fetchAcceptedAnswer } from '../helpers/practice-questions';

// =============================================================================
// readiness.spec.ts — issue #146, epic #55 (E6 "Readiness and Progress")
// =============================================================================
//
// End to end against the real shipped `computeReadiness` engine
// (`apps/api/src/readiness/readiness-engine.ts`), `ReadinessService`
// (`apps/api/src/readiness/readiness.service.ts`) and the two UI surfaces
// that read a snapshot: `/progress` (the full dial + breakdown, #139) and
// `/` (the compact widget, #142). `docs/specs/readiness-model.md` is this
// spec's contract; §12 is the worked example this file's own header was
// asked to reproduce.
//
// -----------------------------------------------------------------------------
// STRICTNESS ACHIEVED: EXACT, HAND-VERIFIED NUMBERS — BUT NOT §12's OWN
// 33 / 50 / 59, AND HERE IS EXACTLY WHY NOT
// -----------------------------------------------------------------------------
//
// §12's Dana table is built from an evidence shape (`mastered: 2, review: 6,
// learning: 10, lapsed: 2` out of 20 rows; `partial: 2` among the most recent
// 20 qualifying attempts) that this suite has no honest way to dial to those
// exact counts through the real product surface:
//
//   - `outcome: 'partial'` is a GRADER verdict, never a deterministic-match
//     one. `answer-matching.ts`'s own `matchAnswer` (rung 1) returns only
//     `correct` or `incorrect` — grep it for the string `'partial'` and the
//     result is empty. The only path to `partial` is
//     `PracticeService.escalateToGrader`'s AI rung, and this suite (like
//     `practice-session.spec.ts` before it) runs with no AI configured, so
//     that rung resolves `unavailable` and is never reached deterministically
//     from outside. Driving an exact `partial: 2` would mean either
//     configuring `AI_PROVIDER_FAKE` and reverse-engineering its exact
//     grading behaviour for a chosen response string — a second, undocumented
//     contract this file would then be pinned to — or writing directly to
//     `practice_attempts`, which is not an E2E test of the product at that
//     point.
//   - `lapses: >= 2` on a chosen 2 of 20 rows, with 1 of those 2 already
//     "remediated" back to `review`/`mastered` and the other not, requires
//     orchestrating a precise, individually-tracked sequence of incorrect
//     answers per question, interleaved with the correct-answer sequence
//     that also has to land certain questions in `mastered` vs `review` vs
//     `learning` on an exact day schedule. Doable in principle (every lever
//     is a real API call), but the resulting fixture would be several times
//     longer than this file already is and would break, silently and
//     unhelpfully, on any future change to grading, selection order, or the
//     scheduler's own constants — exactly the "excessive fragility" this
//     task's own instructions name as the reason to prefer the qualitative
//     fallback.
//
// So this file does not reproduce Dana's numbers. What it DOES do, which is
// more than a purely qualitative "the score goes up" claim: it drives a
// SELF-DESIGNED, fully-controlled three-day evidence table — every attempt
// in it graded `correct` by exact deterministic match, no hints, no reveals,
// no incorrect answers ever submitted — chosen specifically because a
// table with zero incorrect/partial attempts is exactly the one this
// suite CAN compute by hand from `docs/specs/readiness-model.md` §2's own
// formulas, and then assert the real engine produced precisely that number,
// component by component, on all three days — not merely that the UI
// agrees with whatever the API happened to say (which would validate
// plumbing, not arithmetic). `capReason` is asserted against real evidence
// too: this suite drives zero spoken-practice and zero mock-interview
// attempts because — see the second `test.describe` block below — there is
// today no product-surface way to produce either at all, so `'typed_only'`
// is not a chosen fixture value here, it is the only value the real system
// can produce right now.
//
// -----------------------------------------------------------------------------
// WHY EACH "DAY" IS A LITERAL, HARDCODED ISO CONSTANT AT NOON UTC
// -----------------------------------------------------------------------------
//
// Same reasoning `memory.spec.ts`'s own header already states in full:
// `consistency`'s distinct-day rule and `nextSchedule`'s own distinct-day
// rule both compare UTC calendar dates, so each pinned instant here is fixed
// at noon UTC — nowhere near a boundary — and `ORIENTATION_PROFILE`'s
// timezone (`America/Los_Angeles`, seven or eight hours behind UTC) can
// never push a noon-UTC instant across a calendar-day line either way.
//
// -----------------------------------------------------------------------------
// `X-Test-Clock` ON THE PAGE VS. ON `page.request` — SEE `docs/TESTING.md`
// -----------------------------------------------------------------------------
//
// Identical discipline to `memory.spec.ts`: `page.setExtraHTTPHeaders` pins
// every fetch the mounted React app makes, but NOT `page.request` — a
// separate `APIRequestContext`. Every direct `page.request` call below that
// needs the pinned clock carries `'X-Test-Clock'` explicitly in its own
// headers.
//
// -----------------------------------------------------------------------------
// WHY ATTEMPTS ARE POSTED AGAINST CHOSEN QUESTION IDS, NOT A SESSION'S OWN
// `nextQuestion`
// -----------------------------------------------------------------------------
//
// Identical mechanics to `memory.spec.ts`'s own header, reused rather than
// re-argued: `recordAttempt` validates a submitted `questionId` only against
// the session's own test version (and category, for a `category` session) —
// never against whatever the session's `nextQuestion` happened to draw — so
// this suite fetches the caller's full question bank once
// (`GET /api/civics/questions?pageSize=100`) and posts specific, chosen ids
// against fresh `quick` sessions. This is the ONLY way to control exactly
// which questions accumulate exactly which evidence.
//
// -----------------------------------------------------------------------------
// EXECUTION
// -----------------------------------------------------------------------------
//
// Not run in this sandbox — no Docker daemon, no Postgres, matching every
// other spec in this directory (`ROADMAP.md`'s own "Playwright never runs in
// CI, no DB in CI"). Confidence here comes from: `npx tsc --noEmit` passing
// clean; every selector below read directly off the shipped JSX
// (`ProgressPage.tsx`, `ReadinessBreakdown.tsx`, `ReadinessScoreDial.tsx`,
// `ReadinessWidget.tsx`, `HomePage.tsx`) rather than assumed; and every
// number this file expects derived, in this file's own comments, from
// `readiness-engine.ts`'s real formulas and `scheduler.ts`'s real state
// machine — the same two files a reader can open to check the arithmetic
// independently of running anything.
// =============================================================================

function testEmail(label: string): string {
  return `readiness-${label}-${randomUUID()}@test.local`;
}

// -----------------------------------------------------------------------------
// Wire shapes — the exact fields `readiness-snapshot.dto.ts` declares.
// -----------------------------------------------------------------------------

type EarnableComponentKey = 'coverage' | 'recall' | 'retention' | 'consistency' | 'remediation';
type UnwiredComponentKey = 'english' | 'spoken' | 'interview';
type ReadinessComponentKey = EarnableComponentKey | UnwiredComponentKey;

interface ReadinessComponentResult {
  value: number;
  weight: number;
  contribution: number;
}

interface ReadinessSnapshotResponse {
  id: string;
  computedAt: string;
  score: number;
  stage: string;
  components: Record<ReadinessComponentKey, ReadinessComponentResult>;
  evidenceCounts: Record<string, Record<string, number>>;
  capReason: 'typed_only' | null;
  topRecommendation: {
    componentKey: ReadinessComponentKey | null;
    title: string;
    reason: string;
    path: string;
  };
  narrative: string | null;
  narrativeGeneratedAt: string | null;
}

interface ReadinessResponse {
  data: ReadinessSnapshotResponse;
}

interface ReadinessHistoryResponse {
  data: {
    items: ReadinessSnapshotResponse[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  };
}

interface QuestionListResponse {
  data: { items: { id: string }[]; total: number };
}

interface CreateSessionResponse {
  data: { session: { id: string } };
}

interface AttemptResponse {
  data: { attempt: { outcome: string; gradingMethod: string } };
}

// -----------------------------------------------------------------------------
// API helpers
// -----------------------------------------------------------------------------

/**
 * The caller's full question bank for their own resolved test version, and
 * its true total — the same `totalQuestionsInVersion` denominator
 * `readiness-engine.ts`'s `coverage` component reads, obtained independently
 * of the readiness API itself (a `GET /api/civics/questions` read, exactly
 * as `memory.spec.ts`'s own `findCategoryName` treats civics content as
 * public exam material).
 */
async function fetchQuestionBank(
  page: Page,
  headers: Record<string, string>,
): Promise<{ ids: string[]; total: number }> {
  const response = await page.request.get('/api/civics/questions?pageSize=100', { headers });
  expect(response.ok(), 'GET /api/civics/questions').toBe(true);
  const body = (await response.json()) as QuestionListResponse;
  return { ids: body.data.items.map((item) => item.id), total: body.data.total };
}

/**
 * A fresh `quick` session, `questionIds.length` planned, each id answered
 * CORRECTLY by exact deterministic match (the accepted answer typed
 * verbatim — no hint, no reveal), then completed — the synchronous
 * readiness-recompute trigger (a) (`docs/specs/readiness-model.md` §7(a)).
 *
 * Every attempt is asserted `outcome: 'correct'` and `gradingMethod:
 * 'exact'` — never `'ai'` — so this file's own hand-computed expectations
 * (which assume zero incorrect/partial evidence, ever) hold for real rather
 * than by luck.
 */
async function answerQuestionsInNewSession(
  page: Page,
  headers: Record<string, string>,
  questionIds: string[],
): Promise<string> {
  const createResponse = await page.request.post('/api/practice/sessions', {
    headers,
    data: { kind: 'quick', plannedCount: questionIds.length },
  });
  expect(createResponse.ok(), 'POST /api/practice/sessions').toBe(true);
  const createBody = (await createResponse.json()) as CreateSessionResponse;
  const sessionId = createBody.data.session.id;

  for (const questionId of questionIds) {
    const accepted = await fetchAcceptedAnswer(page, headers, questionId);
    const attemptResponse = await page.request.post(
      `/api/practice/sessions/${sessionId}/attempts`,
      { headers, data: { questionId, responseText: accepted } },
    );
    expect(
      attemptResponse.ok(),
      `POST .../attempts for ${questionId} — body: ` +
        `${await attemptResponse.text().catch(() => '<unreadable>')}`,
    ).toBe(true);
    const attemptBody = (await attemptResponse.json()) as AttemptResponse;
    expect(
      attemptBody.data.attempt.outcome,
      `expected a correct attempt for question ${questionId}, got ` +
        JSON.stringify(attemptBody.data.attempt),
    ).toBe('correct');
    expect(attemptBody.data.attempt.gradingMethod).toBe('exact');
  }

  const completeResponse = await page.request.post(
    `/api/practice/sessions/${sessionId}/complete`,
    { headers },
  );
  expect(completeResponse.ok(), 'POST .../complete').toBe(true);

  return sessionId;
}

async function fetchReadiness(
  page: Page,
  headers: Record<string, string>,
): Promise<ReadinessSnapshotResponse> {
  const response = await page.request.get('/api/readiness', { headers });
  expect(response.ok(), 'GET /api/readiness').toBe(true);
  const body = (await response.json()) as ReadinessResponse;
  return body.data;
}

async function fetchReadinessHistory(
  page: Page,
  headers: Record<string, string>,
): Promise<ReadinessHistoryResponse['data']> {
  const response = await page.request.get('/api/readiness/history?page=1&pageSize=30', {
    headers,
  });
  expect(response.ok(), 'GET /api/readiness/history').toBe(true);
  const body = (await response.json()) as ReadinessHistoryResponse;
  return body.data;
}

// -----------------------------------------------------------------------------
// UI helpers — every selector below is read off the shipped JSX (see this
// file's own header), never guessed.
// -----------------------------------------------------------------------------

/**
 * `/progress`'s headline number, read from the real `CircularProgress`'s own
 * `aria-valuenow` (`ReadinessScoreDial.tsx`) rather than parsed off visible
 * text — the same element carries a stable, unambiguous `aria-label`
 * ("Readiness score: N out of 100"), which the individual breakdown bars'
 * OWN `aria-label`s ("Material covered: N%", etc.) cannot be confused with.
 */
async function readProgressScore(page: Page): Promise<number> {
  const dial = page.getByRole('progressbar', { name: /^Readiness score: \d+ out of 100$/ });
  await expect(dial).toBeVisible();
  const valueNow = await dial.getAttribute('aria-valuenow');
  if (valueNow === null) {
    throw new Error('readProgressScore: the readiness dial has no aria-valuenow');
  }
  return Number(valueNow);
}

/**
 * Home's compact widget score (`ReadinessWidget.tsx`) — plain text, "N /
 * 100" inside the `region` its own `h2` ("Readiness") names. `/progress`'s
 * dial renders "out of 100" instead (no "/"), so this pattern cannot
 * accidentally match the wrong page.
 */
async function readWidgetScore(page: Page): Promise<number> {
  const region = page.getByRole('region', { name: 'Readiness' });
  await expect(region).toBeVisible();
  const text = (await region.textContent()) ?? '';
  const match = text.match(/(\d+)\s*\/\s*100/);
  if (!match) {
    throw new Error(`readWidgetScore: could not find "N / 100" in region text: "${text}"`);
  }
  return Number(match[1]);
}

/**
 * One breakdown row's `dd` text (`ReadinessBreakdown.tsx`: a `<dl>` of
 * `dt`/`dd` `Typography` siblings) — the identical "walk to the label, then
 * its very next sibling" idiom `memory.spec.ts`'s own `queueStat` already
 * uses for `PracticeQueueSummary.tsx`'s matching `dt`/`dd` shape. Scoped to
 * the "Readiness" region so it can never accidentally match unrelated page
 * text.
 */
async function readinessComponentText(page: Page, label: string): Promise<string> {
  const region = page.getByRole('region', { name: 'Readiness' });
  const dt = region.getByText(label, { exact: true });
  const dd = dt.locator('xpath=following-sibling::*[1]');
  return (await dd.textContent()) ?? '';
}

/** §3's fixed cap copy, verbatim — `top-recommendation.ts`'s `cappedRecommendation()`. */
const CAP_TITLE = 'Limited interview practice';
const CAP_REASON =
  'Your civics knowledge is strong, but you have limited interview practice. ' +
  'Completing two mock interviews is the best way to strengthen your readiness now.';

async function assertCapMessageVisible(page: Page): Promise<void> {
  await expect(page.getByText(CAP_TITLE, { exact: true })).toBeVisible();
  await expect(page.getByText(CAP_REASON, { exact: true })).toBeVisible();
}

/** `readiness.ts`'s own worked-example labels (`READINESS_COMPONENT_LABELS`), copied here rather than imported — a separate package, same convention every other spec in this directory already follows. */
const EARNABLE_LABELS: Record<EarnableComponentKey, string> = {
  coverage: 'Material covered',
  recall: 'Recall without help',
  retention: 'Long-term retention',
  consistency: 'Practice consistency',
  remediation: 'Fixing weak spots',
};

const UNWIRED_LABELS: Record<UnwiredComponentKey, string> = {
  english: 'Spoken English practice',
  spoken: 'Spoken practice',
  interview: 'Mock interviews',
};

// -----------------------------------------------------------------------------
// Formula helpers — §2's table, copied verbatim into arithmetic a reader can
// check against that document directly.
// -----------------------------------------------------------------------------

/** §2's weight column, the five currently-earnable components only. */
const WEIGHTS: Record<EarnableComponentKey, number> = {
  coverage: 0.15,
  recall: 0.2,
  retention: 0.2,
  consistency: 0.1,
  remediation: 0.1,
};

/** `Math.round(fraction * 100)` — the identical rounding `readiness-engine.ts` and `ReadinessBreakdown.tsx` both apply. */
function pct(fraction: number): number {
  return Math.round(fraction * 100);
}

/**
 * §5: `score = round(sum(value * weight) * 100)`. `english`/`spoken`/
 * `interview` are omitted — every fixture in this file drives zero evidence
 * for all three, so their contribution is always exactly `0` and adding
 * three `+ 0` terms would only obscure the arithmetic.
 */
function expectedScore(fractions: Record<EarnableComponentKey, number>): number {
  const sum = (Object.keys(WEIGHTS) as EarnableComponentKey[]).reduce(
    (total, key) => total + fractions[key] * WEIGHTS[key],
    0,
  );
  return Math.round(sum * 100);
}

async function assertBreakdown(
  page: Page,
  fractions: Record<EarnableComponentKey, number>,
  day: string,
): Promise<void> {
  for (const key of Object.keys(EARNABLE_LABELS) as EarnableComponentKey[]) {
    const label = EARNABLE_LABELS[key];
    const text = await readinessComponentText(page, label);
    expect(text, `${label} (${key}) on ${day}`).toBe(`${pct(fractions[key])}%`);
  }
  for (const label of Object.values(UNWIRED_LABELS)) {
    const text = await readinessComponentText(page, label);
    expect(text, `${label} on ${day}`).toBe('No evidence yet');
  }
}

// =============================================================================

test.describe('Readiness: the score rises across three practice days and the breakdown names what moved (issue #146), epic #55 (E6)', () => {
  test('coverage, recall, retention and consistency move exactly as §2\'s formulas predict, and the typed-only cap never lifts', async ({
    page,
  }) => {
    const DAY1 = '2026-04-06T12:00:00Z';
    const DAY2 = '2026-04-08T12:00:00Z';
    const DAY3 = '2026-04-10T12:00:00Z';

    const email = testEmail('walkthrough');
    const { accessToken } = await seedOnboarding(page, { email, onboarding: 'full' });
    await page.waitForURL('/', { timeout: 10000 });
    const authHeaders = { Authorization: `Bearer ${accessToken}` };

    await page.setExtraHTTPHeaders({ 'X-Test-Clock': DAY1 });
    const day1Headers = { ...authHeaders, 'X-Test-Clock': DAY1 };

    const { ids: bank, total } = await fetchQuestionBank(page, day1Headers);
    // 10 (Day 1) + 8 more (Day 2) + 5 more (Day 3) = 23 distinct questions,
    // plus 5 of Day 1's own questions reattempted on Day 2 and again on Day
    // 3 — comfortably inside a ~100-question bank (`civics-2008.json`, per
    // `memory.spec.ts`'s own header).
    if (bank.length < 23) {
      throw new Error(
        `readiness.spec.ts needs at least 23 questions in the caller's bank to run ` +
          `its fixed evidence schedule — got ${bank.length}.`,
      );
    }

    const day1Ids = bank.slice(0, 10);
    const day2NewIds = bank.slice(10, 18);
    const day3NewIds = bank.slice(18, 23);
    // The first 5 of Day 1's own 10 questions — reattempted on Day 2 (their
    // SECOND correct answer, which graduates `learning -> review`
    // unconditionally, per `scheduler.ts`'s `nextStateOnCorrect`) and again
    // on Day 3 (their THIRD correct answer, on a THIRD distinct day, which
    // is exactly `MASTERY_PROMOTION_THRESHOLD` — `review -> mastered`).
    const reattemptIds = day1Ids.slice(0, 5);

    // ---------------------------------------------------------------------
    // DAY 1 — 10 brand-new questions, each answered once. Every one lands
    // in `question_mastery.state: 'learning'` (§2.3: `new -> learning` on
    // the first correct answer) — none in `review` or `mastered` yet, so
    // `retention` is exactly 0. `recall` is exactly 1.0: all 10 qualifying
    // attempts (no hint, no reveal) are correct, well past the 5-attempt
    // floor (§2.2). `remediation` is exactly 1.0: zero incorrect answers
    // have ever been submitted, so `everWeakCount === 0` (§2.5's "full
    // credit for nothing to remediate"). `consistency` is exactly
    // `min(1, 7) / 7` — one distinct practice day so far (§2.4).
    // ---------------------------------------------------------------------
    await answerQuestionsInNewSession(page, day1Headers, day1Ids);

    const day1Fractions: Record<EarnableComponentKey, number> = {
      coverage: day1Ids.length / total,
      recall: 1.0,
      retention: 0,
      consistency: Math.min(1, 7) / 7,
      remediation: 1.0,
    };
    const day1ExpectedScore = expectedScore(day1Fractions);

    // Cross-check the API directly BEFORE ever touching the UI — this
    // confirms the hand-computed expectation matches the real engine's own
    // output, independent of anything the page renders.
    const day1Api = await fetchReadiness(page, day1Headers);
    expect(day1Api.score, 'Day 1 API score').toBe(day1ExpectedScore);
    expect(day1Api.components.coverage.value).toBeCloseTo(day1Fractions.coverage, 10);
    expect(day1Api.components.recall.value).toBe(1.0);
    expect(day1Api.components.retention.value).toBe(0);
    expect(day1Api.components.consistency.value).toBeCloseTo(day1Fractions.consistency, 10);
    expect(day1Api.components.remediation.value).toBe(1.0);
    expect(day1Api.evidenceCounts.spoken.attempts).toBe(0);
    expect(day1Api.evidenceCounts.interview.attempts).toBe(0);
    expect(day1Api.capReason).toBe('typed_only');
    expect(day1Api.topRecommendation).toEqual({
      componentKey: null,
      title: CAP_TITLE,
      reason: CAP_REASON,
      path: '/practice',
    });

    await page.goto('/progress');
    await expect(page.getByRole('heading', { level: 1, name: 'Progress' })).toBeVisible();

    const day1UiScore = await readProgressScore(page);
    expect(day1UiScore, 'Day 1 UI score').toBe(day1ExpectedScore);

    await assertBreakdown(page, day1Fractions, 'Day 1');
    await assertCapMessageVisible(page);

    const day1History = await fetchReadinessHistory(page, day1Headers);
    expect(day1History.total, 'Day 1 history point count').toBe(1);

    // ---------------------------------------------------------------------
    // DAY 2 — the 5 reattempted questions graduate `learning -> review`
    // (their second correct answer, unconditional on the state machine).
    // 8 brand-new questions join at `learning`. `retention`'s numerator is
    // now `5 * 0.6` over an 18-question denominator (10 Day-1 + 8 Day-2 —
    // the 5 reattempts were already counted). `recall` stays 1.0: the most
    // recent 20 qualifying attempts are still 100% correct, regardless of
    // exactly which of the 10 same-timestamp Day-1 rows a query's tie-break
    // happens to keep (all 10 are correct, so it cannot matter — see this
    // file's own header). `consistency` is now `min(2, 7) / 7`.
    // ---------------------------------------------------------------------
    await page.setExtraHTTPHeaders({ 'X-Test-Clock': DAY2 });
    const day2Headers = { ...authHeaders, 'X-Test-Clock': DAY2 };
    await answerQuestionsInNewSession(page, day2Headers, [...reattemptIds, ...day2NewIds]);

    const day2DistinctAttempted = day1Ids.length + day2NewIds.length; // 18
    const day2ReviewCount = reattemptIds.length; // 5
    const day2Fractions: Record<EarnableComponentKey, number> = {
      coverage: day2DistinctAttempted / total,
      recall: 1.0,
      retention: (day2ReviewCount * 0.6) / day2DistinctAttempted,
      consistency: Math.min(2, 7) / 7,
      remediation: 1.0,
    };
    const day2ExpectedScore = expectedScore(day2Fractions);
    expect(day2ExpectedScore, 'Day 2 score must exceed Day 1 — strictly more real evidence, none of it negative').toBeGreaterThan(day1ExpectedScore);

    const day2Api = await fetchReadiness(page, day2Headers);
    expect(day2Api.score, 'Day 2 API score').toBe(day2ExpectedScore);
    expect(day2Api.components.retention.value).toBeCloseTo(day2Fractions.retention, 10);
    expect(day2Api.evidenceCounts.retention).toEqual({
      masteredCount: 0,
      reviewCount: day2ReviewCount,
      totalAttemptedQuestions: day2DistinctAttempted,
    });
    expect(day2Api.capReason, 'Day 2 is still typed-only — nothing produced spoken or interview evidence').toBe('typed_only');

    await page.goto('/progress');
    const day2UiScore = await readProgressScore(page);
    expect(day2UiScore, 'Day 2 UI score').toBe(day2ExpectedScore);
    expect(day2UiScore, 'Day 2 score rose from Day 1, on the real page, not just the API').toBeGreaterThan(day1UiScore);
    await assertBreakdown(page, day2Fractions, 'Day 2');
    await assertCapMessageVisible(page);

    const day2History = await fetchReadinessHistory(page, day2Headers);
    expect(day2History.total, 'Day 2 history point count').toBe(2);

    // ---------------------------------------------------------------------
    // DAY 3 — the 5 reattempted questions get their THIRD correct answer on
    // a THIRD distinct calendar day: `distinctCorrectDays` reaches 3
    // (`MASTERY_PROMOTION_THRESHOLD`), so `review -> mastered`
    // (`scheduler.ts`'s `nextStateOnCorrect`). 5 more brand-new questions
    // join at `learning`. `retention`'s numerator is now `5 * 1.0` (full
    // credit for `mastered`, none left in `review`) over a 23-question
    // denominator. `consistency` is now `min(3, 7) / 7`.
    // ---------------------------------------------------------------------
    await page.setExtraHTTPHeaders({ 'X-Test-Clock': DAY3 });
    const day3Headers = { ...authHeaders, 'X-Test-Clock': DAY3 };
    await answerQuestionsInNewSession(page, day3Headers, [...reattemptIds, ...day3NewIds]);

    const day3DistinctAttempted = day2DistinctAttempted + day3NewIds.length; // 23
    const day3MasteredCount = reattemptIds.length; // 5
    const day3Fractions: Record<EarnableComponentKey, number> = {
      coverage: day3DistinctAttempted / total,
      recall: 1.0,
      retention: (day3MasteredCount * 1.0) / day3DistinctAttempted,
      consistency: Math.min(3, 7) / 7,
      remediation: 1.0,
    };
    const day3ExpectedScore = expectedScore(day3Fractions);
    expect(day3ExpectedScore, 'Day 3 score must exceed Day 2').toBeGreaterThan(day2ExpectedScore);

    const day3Api = await fetchReadiness(page, day3Headers);
    expect(day3Api.score, 'Day 3 API score').toBe(day3ExpectedScore);
    expect(day3Api.evidenceCounts.retention).toEqual({
      masteredCount: day3MasteredCount,
      reviewCount: 0,
      totalAttemptedQuestions: day3DistinctAttempted,
    });
    expect(day3Api.capReason, 'Day 3 is STILL typed-only — see the second describe block below for why that can never change through the real product today').toBe('typed_only');

    await page.goto('/progress');
    const day3UiScore = await readProgressScore(page);
    expect(day3UiScore, 'Day 3 UI score').toBe(day3ExpectedScore);
    expect(day3UiScore, 'Day 3 score rose from Day 2, on the real page').toBeGreaterThan(day2UiScore);
    await assertBreakdown(page, day3Fractions, 'Day 3');
    await assertCapMessageVisible(page);

    // The one explicit "cross-check the UI's rendered numbers against the
    // API's, exactly" this file's own brief calls for: the trend's newest
    // history row and the page's own headline score must be the identical
    // number, and there must be exactly 3 points now.
    const day3History = await fetchReadinessHistory(page, day3Headers);
    expect(day3History.total, 'Day 3 history point count').toBe(3);
    expect(day3History.items[0].score, 'newest history row (item 0) must be the Day 3 snapshot').toBe(day3ExpectedScore);
    expect(day3History.items[0].score).toBe(day3UiScore);
  });
});

test.describe('Readiness: the typed-only cap (issue #146), epic #55 (E6)', () => {
  test('the cap message is exactly §3\'s PRD sentence, and there is today no product-surface way to lift it', async ({
    page,
  }) => {
    // =========================================================================
    // WHY THIS TEST DOES NOT DRIVE THE CAP-LIFT TRANSITION
    // =========================================================================
    //
    // `capReason` becomes `null` the instant EITHER `evidenceCounts.spoken
    // .attempts` or `evidenceCounts.interview.attempts` is nonzero (§3).
    // Reading the SHIPPED `ReadinessService.assembleEvidence`
    // (`apps/api/src/readiness/readiness.service.ts`) directly, both are
    // produced from real Prisma queries, not hardcoded — but their real
    // queries can never return nonzero today:
    //
    //   - `spoken` reads `practice_attempts` rows with
    //     `inputMode: 'spoken'`. `PracticeService.recordAttempt`
    //     (`apps/api/src/practice/practice.service.ts`) is the ONLY writer
    //     of that table, and it hardcodes `source: 'practice'` with no
    //     request field that could set `inputMode` to anything but its
    //     schema default (`typed`) — there is no endpoint anywhere in this
    //     API that accepts an `inputMode` at all.
    //   - `interview` reads `practice_attempts` rows with
    //     `source: 'mock_interview'`, grouped into completed interview
    //     sessions. The same `recordAttempt` hardcodes `source: 'practice'`
    //     unconditionally; `practice_sessions.kind` has no `mock_interview`
    //     value in its own five-value enum (`quick`/`category`/`review`/
    //     `weak`/`mixed`) for a session to even be created as one.
    //
    // Epic #55's own "Out of scope (deliberately)" list (§10 of
    // `docs/specs/readiness-model.md`) names this outright: "Producing
    // spoken, interview, or English evidence itself. E8 (mock interviews),
    // E9 (spoken practice), and E11 ... are the epics that ever write the
    // `practice_attempts` rows `spoken`, `english`, and `interview` read.
    // This epic declares the three components and their formulas and
    // leaves every one of them at `0` until its producer ships." Faking a
    // `source: 'mock_interview'` row by writing directly to the database
    // (bypassing every service in this application) would not be testing
    // this product — E8/E9 do not exist yet for this suite to exercise.
    //
    // So this test asserts the one half of the cap's contract that IS real
    // and testable today: given a real snapshot computed by the real
    // engine from real (if minimal) evidence, `capReason` reads
    // `'typed_only'`, and the UI renders §3's fixed sentence for it,
    // verbatim, every time — never a softened paraphrase, never a live
    // count spliced in.
    // =========================================================================

    const CLOCK = '2026-04-06T12:00:00Z';
    const email = testEmail('cap');
    const { accessToken } = await seedOnboarding(page, { email, onboarding: 'full' });
    await page.waitForURL('/', { timeout: 10000 });
    const headers = { Authorization: `Bearer ${accessToken}`, 'X-Test-Clock': CLOCK };
    await page.setExtraHTTPHeaders({ 'X-Test-Clock': CLOCK });

    const { ids: bank } = await fetchQuestionBank(page, headers);
    if (bank.length < 3) {
      throw new Error('readiness.spec.ts (cap test) needs at least 3 questions in the bank.');
    }
    await answerQuestionsInNewSession(page, headers, bank.slice(0, 3));

    const snapshot = await fetchReadiness(page, headers);
    expect(snapshot.evidenceCounts.spoken.attempts, 'no product surface can produce spoken evidence yet').toBe(0);
    expect(snapshot.evidenceCounts.interview.attempts, 'no product surface can produce mock-interview evidence yet').toBe(0);
    expect(snapshot.capReason).toBe('typed_only');
    expect(snapshot.topRecommendation).toEqual({
      componentKey: null,
      title: CAP_TITLE,
      reason: CAP_REASON,
      path: '/practice',
    });

    await page.goto('/progress');
    await expect(page.getByRole('heading', { level: 1, name: 'Progress' })).toBeVisible();
    await assertCapMessageVisible(page);

    // The recommendation card's own "Go" button — `topRecommendation.path`
    // rendered as a real link, not merely a string the API happened to send.
    // `exact: true` matters here specifically: Playwright's default
    // accessible-name matching is a substring match, and "Go" would
    // otherwise also match a "Go to Practice" button if this page's mastery
    // section happened to be in its own empty state.
    const goButton = page.getByRole('link', { name: 'Go', exact: true });
    await expect(goButton).toHaveAttribute('href', '/practice');
  });
});

test.describe('Readiness: the Home widget matches the Progress page (issue #146), epic #55 (E6)', () => {
  test('the same snapshot renders the same score on both surfaces', async ({ page }) => {
    const CLOCK = '2026-04-06T12:00:00Z';
    const email = testEmail('parity');
    const { accessToken } = await seedOnboarding(page, { email, onboarding: 'full' });
    await page.waitForURL('/', { timeout: 10000 });
    const headers = { Authorization: `Bearer ${accessToken}`, 'X-Test-Clock': CLOCK };
    await page.setExtraHTTPHeaders({ 'X-Test-Clock': CLOCK });

    const { ids: bank } = await fetchQuestionBank(page, headers);
    if (bank.length < 5) {
      throw new Error('readiness.spec.ts (parity test) needs at least 5 questions in the bank.');
    }
    await answerQuestionsInNewSession(page, headers, bank.slice(0, 5));

    const apiSnapshot = await fetchReadiness(page, headers);

    await page.goto('/');
    await expect(page.getByRole('heading', { level: 2, name: 'Readiness' })).toBeVisible();

    const widgetScore = await readWidgetScore(page);
    expect(widgetScore, 'Home widget score must equal the API snapshot').toBe(apiSnapshot.score);

    const seeProgressLink = page.getByRole('link', { name: 'See your Progress', exact: true });
    await expect(seeProgressLink).toHaveAttribute('href', '/progress');

    await seeProgressLink.click();
    await expect(page).toHaveURL(/\/progress$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Progress' })).toBeVisible();

    const progressScore = await readProgressScore(page);
    expect(progressScore, 'Progress page score must equal the API snapshot').toBe(apiSnapshot.score);
    expect(progressScore, 'Home and Progress must render the identical score').toBe(widgetScore);
  });
});

test.describe('Readiness: a fresh learner sees an honest zero-evidence state (issue #146), epic #55 (E6)', () => {
  test('score is exactly 10 — never 0, and never a fabricated confidence number', async ({
    page,
  }) => {
    // =========================================================================
    // WHY 10, NOT 0 — AND WHY THIS NUMBER IS EXACT REGARDLESS OF BANK SIZE
    // =========================================================================
    //
    // With zero attempts ever recorded, `readiness-engine.ts`'s own formulas
    // (§2) resolve every one of the eight components without ambiguity:
    //
    //   coverage:     0 attempted / T total = 0            (weight 0.15 -> 0)
    //   recall:       0 qualifying attempts, below the      (weight 0.20 -> 0)
    //                 5-attempt floor (§2.2) -> 0
    //   retention:    `safeRatio(0, 0)` = 0, never NaN       (weight 0.20 -> 0)
    //                 (`readiness-engine.ts`'s own `safeRatio`)
    //   consistency:  0 distinct practice days -> 0          (weight 0.10 -> 0)
    //   remediation:  `everWeakCount === 0` -> FULL CREDIT,   (weight 0.10 -> 0.10)
    //                 1.0, not 0 (§2.5's own deliberate rule:
    //                 "there is nothing to remediate, so there
    //                 is nothing to be penalized for not having
    //                 remediated")
    //   english/spoken/interview: 0 each                      (weight 0.25 -> 0)
    //
    // `score = round((0.10 * 1.0) * 100) = 10` — independent of `T`
    // (`coverage`'s numerator is 0 regardless of the denominator), and
    // independent of which questions exist in the bank at all. This is the
    // one number in this entire file that needs no fixture-specific
    // arithmetic: it falls out of the formulas for EVERY learner on their
    // very first `GET /api/readiness`, which is exactly why it is the
    // strongest possible proof that this page does not fabricate
    // confidence — a learner who has done nothing sees a real, specific,
    // reproducible 10, not a blank chart and not a hollow round 0.
    // =========================================================================

    const email = testEmail('fresh');
    const { accessToken } = await seedOnboarding(page, { email, onboarding: 'full' });
    await page.waitForURL('/', { timeout: 10000 });
    const headers = { Authorization: `Bearer ${accessToken}` };

    await page.goto('/progress');
    await expect(page.getByRole('heading', { level: 1, name: 'Progress' })).toBeVisible();

    const uiScore = await readProgressScore(page);
    expect(uiScore, 'a fresh learner\'s score is exactly 10, never 0 and never fabricated').toBe(10);

    const zeroFractions: Record<EarnableComponentKey, number> = {
      coverage: 0,
      recall: 0,
      retention: 0,
      consistency: 0,
      remediation: 1.0,
    };
    await assertBreakdown(page, zeroFractions, 'a fresh learner');
    await assertCapMessageVisible(page);

    // The mastery section (E5, a wholly separate data source from
    // readiness — see `ProgressPage.tsx`'s own header on why the two are
    // independently loaded) has its own, differently-worded honest empty
    // state: no chart, no ring, no fabricated zero.
    await expect(
      page.getByRole('heading', { level: 2, name: 'Nothing to show yet' }),
    ).toBeVisible();
    await expect(
      page.getByText(
        'You haven’t practised yet, so there’s no evidence to show. ' +
          'Once you answer some questions, your coverage and mastery show up here, by section.',
      ),
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'Go to Practice', exact: true }),
    ).toHaveAttribute('href', '/practice');

    // Cross-check the exact same facts directly against the API.
    const apiSnapshot = await fetchReadiness(page, headers);
    expect(apiSnapshot.score).toBe(10);
    expect(apiSnapshot.capReason).toBe('typed_only');
    expect(apiSnapshot.components.coverage.value).toBe(0);
    expect(apiSnapshot.components.recall.value).toBe(0);
    expect(apiSnapshot.components.retention.value).toBe(0);
    expect(apiSnapshot.components.consistency.value).toBe(0);
    expect(apiSnapshot.components.remediation.value).toBe(1.0);
    expect(apiSnapshot.evidenceCounts.recall.qualifyingAttempts).toBe(0);
    expect(apiSnapshot.evidenceCounts.remediation).toEqual({
      everWeakCount: 0,
      remediatedCount: 0,
    });
  });
});
