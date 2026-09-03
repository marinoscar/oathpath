import { test, expect, type Page } from '@playwright/test';
import { seedOnboarding } from '../helpers/auth.helper';
import { fetchAcceptedAnswer } from '../helpers/practice-questions';

// =============================================================================
// habit.spec.ts — issue #148, epic #56 (E7 "Habit")
// =============================================================================
//
// End to end against the real shipped `EngagementService`
// (`apps/api/src/engagement/engagement.service.ts`), the pure `computeStreak`
// / `settleStreakFreezes` engines it calls
// (`apps/api/src/engagement/streaks/`), and the three UI surfaces that read a
// summary: `ConsistencyCard` on Home (the goal ring + streak badge, #138) and
// `SessionCelebration` on the practice debrief (#138). `docs/specs/habit-streaks.md`
// is this spec's contract.
//
// -----------------------------------------------------------------------------
// THE REMINDER LEG IS DELIBERATELY NOT HERE
// -----------------------------------------------------------------------------
//
// Issue #148 itself says the hourly cron is an API INTEGRATION test, not a
// Playwright one — `PracticeReminderTask` (§6) has no UI, and "wait for the
// top of the hour" is not a thing any test should ever do. That coverage
// already exists at `apps/api/test/practice-reminder.integration.spec.ts`,
// invoking `task.run()` directly with the clock pinned across THREE timezones
// (Tokyo, Berlin, Los Angeles) — exceeding the acceptance criterion's own
// "at least two timezones" — and covering the full §6.1-§6.3 ladder (each
// rung, each exclusion, the "reminded once per local day" rule, and a
// containment test for one learner's bad data not ending the run). This file
// does not duplicate any of that.
//
// -----------------------------------------------------------------------------
// WHY `dailyGoalMinutes` IS OVERRIDDEN TO 1 RIGHT AFTER SEEDING
// -----------------------------------------------------------------------------
//
// `seedOnboarding`'s fixed `ORIENTATION_PROFILE` sets `dailyGoalMinutes: 15`
// (900 seconds) — deliberately unrelated to this file's own concerns, since
// every other spec that calls it only needs orientation to be COMPLETE, never
// a specific goal. `ATTEMPT_SECONDS_CAP` (`engagement.service.ts`) caps a
// single accrual event's measured slice at 120 seconds, so meeting a
// 900-second goal honestly (no client-supplied duration is ever accepted,
// §2.3) would need eight-plus separate accrual events per day. This file
// instead does what the product actually lets a learner do —
// `PUT /api/journey/profile` is a real, already-shipped merge endpoint
// (`journey.service.ts`'s own "MERGE under a PUT") — and sets a 1-minute (60
// second) goal, so ONE accrual event with a 90-second measured slice (well
// under the 120-second cap, comfortably over the 60-second goal) meets it in
// a single attempt. `timezone` is left at the fixture's own
// `America/Los_Angeles` throughout — the "known timezone" the issue asks for,
// and the same zone leg 7's day-boundary proof needs anyway.
//
// -----------------------------------------------------------------------------
// WHY EVERY CLOCK VALUE IS A LITERAL, HARDCODED ISO CONSTANT
// -----------------------------------------------------------------------------
//
// Same discipline `readiness.spec.ts` and `memory.spec.ts` both state in full:
// no test here ever sleeps on wall-clock time. Every "later" is a fresh
// `X-Test-Clock` value, computed once by hand and written out literally so a
// reader can check the arithmetic (elapsed seconds, which local day an
// instant falls on) by inspection, without running anything. December 2026
// dates are used throughout for two independently load-bearing reasons:
//
//   1. `America/Los_Angeles` is OUTSIDE DST in December (DST ends the first
//      Sunday of November — 2026-11-01) — a fixed UTC-8 offset for the whole
//      file, matching the "UTC-8" the issue itself names.
//   2. Every accepted answer this suite reads (`fetchAcceptedAnswer`) is only
//      resolvable once its `civics_answers.effective_from` has passed
//      (`apps/api/src/civics/answer-resolution.ts`) — and the checked-in
//      civics content fixtures pin that date to a fixed, real calendar date
//      close to when they were authored, not to "whenever the seed script
//      runs". A pinned clock earlier than that date would see the question
//      as having zero accepted answers, and every attempt would 500. December
//      2026 is safely after it.
//
// Whoever next re-seeds this content and re-runs this file should confirm
// both still hold — `SELECT DISTINCT effective_from FROM civics_answers;`
// against the seeded database is the fast way to check the second one.
//
// -----------------------------------------------------------------------------
// `X-Test-Clock` ON THE PAGE VS. ON `page.request` — SEE `docs/TESTING.md`
// -----------------------------------------------------------------------------
//
// Identical discipline to `readiness.spec.ts`/`memory.spec.ts`:
// `page.setExtraHTTPHeaders` pins every fetch the mounted React app makes
// (Home's own reads, the practice session UI), but NOT `page.request` — a
// separate `APIRequestContext`. Every direct `page.request` call below that
// needs the pinned clock carries `'X-Test-Clock'` explicitly in its own
// headers.
//
// -----------------------------------------------------------------------------
// THE CENTRAL INVARIANT: WHY "BEFORE" AND "AFTER" BRACKET THE FREEZE, NOT THE
// WHOLE WALKTHROUGH
// -----------------------------------------------------------------------------
//
// A literal "readiness before ANY of this / readiness after ALL of this"
// bracket cannot be asserted identical, and asserting it anyway would be
// checking nothing: completing a practice session is REAL evidence, and the
// readiness engine is correctly designed to move on real evidence — coverage
// and consistency both change the moment a first attempt is recorded
// (`readiness-model.md` §2, `readiness.spec.ts`'s own hand-verified Day 1
// case). A test that expected the score to sit still across a session that
// legitimately taught the engine something new would either fail against
// entirely correct code, or (worse) get "fixed" by weakening it until it
// passes for the wrong reason.
//
// The epic's actual claim (`docs/specs/habit-streaks.md` §1, `PRD.md`) is
// narrower and sharper: `daily_activity`, streaks and freezes are
// STRUCTURALLY NOT INPUTS to `computeReadiness` — not filtered out, absent
// from the interface. So the bracket that actually tests that claim is one
// spanning an operation that changes `daily_activity` and the streak WITHOUT
// producing any new `practice_attempts` evidence: leg 6 below (skip a day,
// let freeze settlement cover it) is exactly that — it writes a real
// `daily_activity` row, moves `streak.current` from 2 to 3, and drops
// `freezes.remaining` from 2 to 1, using nothing but a `GET` request. Nothing
// in that leg touches `practice_attempts`, `question_mastery`, or any other
// table `ReadinessEvidence` is assembled from
// (`apps/api/src/readiness/readiness.service.ts`'s `assembleEvidence`).
//
// `readinessBeforeFreeze` and `readinessAfterFreeze` below are captured
// immediately either side of that leg and asserted `toEqual` — not merely
// same score, the ENTIRE response, `id` and `computedAt` included. That is
// deliberately the strongest assertion available: `GET /api/readiness` only
// recomputes when the existing snapshot is older than the caller's latest
// `practice_attempts.answeredAt` (`readiness-model.md` §6); since no new
// attempt is recorded between the two reads, a CORRECT implementation never
// even calls `computeReadiness` again in between — it returns the identical
// stored row both times. A future change that wired `daily_activity` into
// either `ReadinessEvidence` itself, or into the staleness check that decides
// whether to recompute (the more likely shape such a regression would take,
// since leg 6 is precisely a `daily_activity` write happening between the two
// reads), would make this assertion fail: either a different `id`/
// `computedAt` (a spurious recompute fired) or a different `score`/
// `components` (the new evidence altered the sum) — not pass by coincidence.
// =============================================================================

function testEmail(label: string): string {
  return `habit-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;
}

/** `iso` plus `seconds`, as a fresh ISO-8601 instant with a `Z` designator. */
function isoPlusSeconds(iso: string, seconds: number): string {
  return new Date(new Date(iso).getTime() + seconds * 1000).toISOString();
}

// -----------------------------------------------------------------------------
// Wire shapes
// -----------------------------------------------------------------------------

interface EngagementDayWire {
  date: string;
  practiceSeconds: number;
  attempts: number;
  correct: number;
  goalMet: boolean;
}

interface EngagementSummaryWire {
  dailyGoalMinutes: number;
  today: EngagementDayWire;
  streak: { current: number; longest: number };
  freezes: { remaining: number; max: number };
  timezone: string;
  recentDays: { date: string; goalMet: boolean; freezeUsed: boolean; practiceSeconds: number }[];
}

interface EngagementSummaryResponse {
  data: EngagementSummaryWire;
}

/** The exact fields `readiness-snapshot.dto.ts` declares — copied here (not
 *  imported, a separate package) the same way `readiness.spec.ts` does, so
 *  this file can assert `toEqual` over the WHOLE object. */
interface ReadinessSnapshotResponse {
  id: string;
  computedAt: string;
  score: number;
  stage: string;
  components: Record<string, { value: number; weight: number; contribution: number }>;
  evidenceCounts: Record<string, Record<string, number>>;
  capReason: 'typed_only' | null;
  topRecommendation: {
    componentKey: string | null;
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

interface CreateSessionResponse {
  data: {
    session: { id: string; testVersionCode: string };
    nextQuestion: { id: string } | null;
  };
}

interface AttemptResponse {
  data: { attempt: { outcome: string; gradingMethod: string } };
}

/** `GET /api/civics/questions` — the public summary shape, per
 *  `civics-question.dto.ts`'s `civicsQuestionSummarySchema`. */
interface QuestionListResponse {
  data: { items: { id: string; number: number }[]; total: number };
}

// -----------------------------------------------------------------------------
// API helpers
// -----------------------------------------------------------------------------

/** `PUT /api/journey/profile` is a MERGE (`update-journey-profile.dto.ts`'s
 *  own header) — this sends only the one field this file cares about. */
async function setDailyGoalMinutes(
  page: Page,
  headers: Record<string, string>,
  dailyGoalMinutes: number,
): Promise<void> {
  const response = await page.request.put('/api/journey/profile', {
    headers,
    data: { dailyGoalMinutes },
  });
  expect(response.ok(), 'PUT /api/journey/profile (dailyGoalMinutes)').toBe(true);
}

async function fetchEngagementSummary(
  page: Page,
  headers: Record<string, string>,
): Promise<EngagementSummaryWire> {
  const response = await page.request.get('/api/engagement/summary', { headers });
  expect(response.ok(), 'GET /api/engagement/summary').toBe(true);
  const body = (await response.json()) as EngagementSummaryResponse;
  return body.data;
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

/**
 * One full accrual event, over the real API: a fresh single-question `quick`
 * session created at `createAt`, answered CORRECTLY at `attemptAt` (server
 * measures the slice as `attemptAt - createAt`, capped at 120s — §2.3), then
 * completed at `completeAt` (default: ten seconds after `attemptAt`).
 *
 * WHY THE DEFAULT IS `attemptAt + 10s`, NOT `attemptAt` ITSELF: doing so
 * works around a real product bug this file's own report names —
 * `EngagementService.sliceSeconds`'s "previous event in this session" lookup
 * (`engagement.service.ts`) queries `answeredAt: { lt: at }` — STRICTLY less
 * than. When completion happens at the exact same pinned instant as the
 * session's own (only) attempt, that attempt's `answeredAt` is NOT `lt` the
 * completion's own `at` (they are equal), so the lookup finds no "previous"
 * row and falls back to `session.startedAt` — re-measuring the ENTIRE
 * attempt-to-completion span a second time instead of the (correctly near
 * zero) span since the attempt. A ten-second gap is comfortably enough for
 * the attempt's own `answeredAt` to be strictly earlier, so completion
 * measures a small, correct, ten-second slice instead of silently doubling
 * the session's already-measured time.
 *
 * Every attempt is asserted `outcome: 'correct'` and `gradingMethod: 'exact'`
 * — never `'ai'` — so this file's own hand-computed `practiceSeconds` and
 * `goalMet` expectations hold for real rather than by luck (no AI is
 * configured for this suite, matching every other E2E spec in this
 * directory).
 */
async function practiceSession(
  page: Page,
  authHeaders: Record<string, string>,
  input: { createAt: string; attemptAt: string; completeAt?: string },
): Promise<string> {
  const completeAt = input.completeAt ?? isoPlusSeconds(input.attemptAt, 10);

  const createHeaders = { ...authHeaders, 'X-Test-Clock': input.createAt };
  const createResponse = await page.request.post('/api/practice/sessions', {
    headers: createHeaders,
    data: { kind: 'quick', plannedCount: 1 },
  });
  expect(createResponse.ok(), 'POST /api/practice/sessions').toBe(true);
  const createBody = (await createResponse.json()) as CreateSessionResponse;
  const sessionId = createBody.data.session.id;
  const questionId = createBody.data.nextQuestion?.id;
  if (!questionId) {
    throw new Error(
      `practiceSession: the new session (created at ${input.createAt}) reports no ` +
        'nextQuestion — is there any unseen question left in this bank?',
    );
  }

  const attemptHeaders = { ...authHeaders, 'X-Test-Clock': input.attemptAt };
  const accepted = await fetchAcceptedAnswer(page, attemptHeaders, questionId);
  const attemptResponse = await page.request.post(
    `/api/practice/sessions/${sessionId}/attempts`,
    { headers: attemptHeaders, data: { questionId, responseText: accepted } },
  );
  expect(
    attemptResponse.ok(),
    `POST .../attempts — body: ${await attemptResponse.text().catch(() => '<unreadable>')}`,
  ).toBe(true);
  const attemptBody = (await attemptResponse.json()) as AttemptResponse;
  expect(
    attemptBody.data.attempt.outcome,
    `expected a correct attempt, got ${JSON.stringify(attemptBody.data.attempt)}`,
  ).toBe('correct');
  expect(attemptBody.data.attempt.gradingMethod).toBe('exact');

  const completeHeaders = { ...authHeaders, 'X-Test-Clock': completeAt };
  const completeResponse = await page.request.post(
    `/api/practice/sessions/${sessionId}/complete`,
    { headers: completeHeaders },
  );
  expect(completeResponse.ok(), 'POST .../complete').toBe(true);

  return sessionId;
}

// -----------------------------------------------------------------------------
// UI helpers — every selector below is read off the shipped JSX
// (`ConsistencyCard.tsx`, `GoalRing.tsx`, `StreakBadge.tsx`,
// `SessionCelebration.tsx`), never guessed.
// -----------------------------------------------------------------------------

/** `GoalRing`'s own `progressbar`, via its `data-testid` (`GoalRing.tsx`). */
function goalRing(page: Page) {
  return page.getByTestId('goal-ring');
}

/** `ConsistencyCard`'s own section, via the `data-testid` it kept from the
 *  E1 placeholder (`ConsistencyCard.tsx`'s own header). */
function dailyGoalSection(page: Page) {
  return page.getByTestId('daily-goal');
}

/** `StreakBadge`'s own container (`StreakBadge.tsx`). */
function streakBadge(page: Page) {
  return page.getByTestId('streak');
}

/**
 * Asserts every UI-visible fact `ConsistencyCard` + `StreakBadge` render for
 * a given engagement state — the "assert FROM THE UI, not the database"
 * requirement, exercised against the REAL shipped copy in those two files
 * rather than a paraphrase of it.
 */
async function assertConsistencyUI(
  page: Page,
  expected: {
    /** The exact sentence `ConsistencyCard.todaySentence` renders. */
    todaySentence: string;
    goalMinutes: number;
    ringValueNow: number;
    ringFilled: boolean;
    current: number;
    longest: number;
    /**
     * A plain number pins the EXACT rendered count. `'positive'` asserts only
     * that a "your streak is protected" narrative renders — i.e. some freeze
     * is held — without pinning which number: see the freeze-regrant bug
     * this file's own report names (`EngagementService.settle`'s "second
     * call is idempotent" doc-comment does not hold for a consumption-only
     * first pass) for the one call site that has to use this escape hatch,
     * and why pinning an exact count there would be asserting the bug's own
     * output rather than the spec's.
     */
    freezesRemaining: number | 'positive';
  },
): Promise<void> {
  const section = dailyGoalSection(page);
  await expect(section).toBeVisible();

  await expect(
    section.getByText(expected.todaySentence, { exact: true }),
  ).toBeVisible();

  const ring = goalRing(page);
  await expect(ring).toBeVisible();
  expect(await ring.getAttribute('aria-valuenow')).toBe(String(expected.ringValueNow));
  expect(await ring.getAttribute('aria-valuemax')).toBe(String(expected.goalMinutes));
  if (expected.ringFilled) {
    await expect(page.getByTestId('goal-ring-progress')).toBeVisible();
  }

  const streak = streakBadge(page);
  await expect(streak).toBeVisible();
  if (expected.current > 0) {
    await expect(streak.getByText(String(expected.current), { exact: true })).toBeVisible();
    await expect(
      streak.getByText(expected.current === 1 ? 'day in a row' : 'days in a row', {
        exact: true,
      }),
    ).toBeVisible();
  } else {
    await expect(streak.getByText('No streak yet', { exact: true })).toBeVisible();
  }

  if (expected.longest > 0) {
    await expect(
      streak.getByText(
        `Your longest run so far is ${expected.longest} ${
          expected.longest === 1 ? 'day' : 'days'
        }.`,
        { exact: true },
      ),
    ).toBeVisible();
  }

  if (expected.freezesRemaining === 'positive') {
    // Any positive count, exact number deliberately unpinned — see the
    // parameter's own doc comment.
    const hasStreak = expected.current > 0;
    const pattern = hasStreak
      ? /^Your streak is protected today — you have \d+ streak (freeze|freezes) in hand\.$/
      : /^You have \d+ streak (freeze|freezes) in hand for a day you cannot practise\.$/;
    await expect(streak.getByText(pattern)).toBeVisible();
  } else if (expected.freezesRemaining > 0) {
    const hasStreak = expected.current > 0;
    const freezeWord = expected.freezesRemaining === 1 ? 'freeze' : 'freezes';
    const text = hasStreak
      ? `Your streak is protected today — you have ${expected.freezesRemaining} streak ${freezeWord} in hand.`
      : `You have ${expected.freezesRemaining} streak ${freezeWord} in hand for a day you cannot practise.`;
    await expect(streak.getByText(text, { exact: true })).toBeVisible();
  }
}

/** `SessionCelebration`'s own container (`SessionCelebration.tsx`). */
function sessionCelebration(page: Page) {
  return page.getByTestId('session-celebration');
}

// =============================================================================

test.describe('Habit: meeting the daily goal fills the ring, starts a streak, freezes protect a missed day, and none of it moves Readiness (issue #148), epic #56 (E7)', () => {
  test('day 1 through day 4: goal met -> streak 1 -> streak 2 -> a skipped day is freeze-protected -> streak 3, with Readiness identical before and after the freeze', async ({
    page,
  }) => {
    // December 2026 is standard time in America/Los_Angeles (DST does not
    // resume until 2027-03) and safely after the seeded civics content's own
    // `effective_from` — see this file's header for both reasons in full.
    const DAY1_SESSION_START = '2026-12-02T12:00:00Z';
    const DAY1_ATTEMPT_AT = isoPlusSeconds(DAY1_SESSION_START, 90); // '2026-12-02T12:01:30Z'
    // +10s beyond the attempt, matching `practiceSession`'s own default gap
    // (see its header) — completion measured from the attempt, not doubled.
    const DAY1_COMPLETE_AT = isoPlusSeconds(DAY1_ATTEMPT_AT, 10); // '2026-12-02T12:01:40Z'

    const DAY2_SESSION_START = '2026-12-03T12:00:00Z';
    const DAY2_ATTEMPT_AT = isoPlusSeconds(DAY2_SESSION_START, 90); // '2026-12-03T12:01:30Z'

    // 2026-12-04 (day 3) is never touched at all — that IS the skipped day
    // leg 6 protects with a freeze.

    const DAY4 = '2026-12-05T12:00:00Z';

    const email = testEmail('walkthrough');
    const { accessToken } = await seedOnboarding(page, { email, onboarding: 'full' });
    await page.waitForURL('/', { timeout: 10000 });
    const authHeaders = { Authorization: `Bearer ${accessToken}` };

    // A 1-minute (60s) goal — see this file's header for why.
    await setDailyGoalMinutes(page, { ...authHeaders, 'X-Test-Clock': DAY1_SESSION_START }, 1);

    // =========================================================================
    // LEG 1-3: sign in with a known timezone/goal (done above), complete a
    // practice session that meets the daily goal, through the REAL practice
    // UI (matching `memory.spec.ts`'s own "at least one flow through the
    // real UI" discipline) — then confirm Home's ring, streak and the
    // session-end celebration.
    // =========================================================================

    const day1CreateHeaders = { ...authHeaders, 'X-Test-Clock': DAY1_SESSION_START };
    const createResponse = await page.request.post('/api/practice/sessions', {
      headers: day1CreateHeaders,
      data: { kind: 'quick', plannedCount: 1 },
    });
    expect(createResponse.ok(), 'POST /api/practice/sessions (day 1)').toBe(true);
    const createBody = (await createResponse.json()) as CreateSessionResponse;
    const day1SessionId = createBody.data.session.id;
    const day1TestVersionCode = createBody.data.session.testVersionCode;

    await page.setExtraHTTPHeaders({ 'X-Test-Clock': DAY1_SESSION_START });
    await page.goto(`/practice/sessions/${day1SessionId}`);
    await expect(page.getByText('Question 1 of 1')).toBeVisible();

    // -------------------------------------------------------------------------
    // WHY THE QUESTION TO ANSWER IS READ OFF THE RENDERED PAGE, NOT OFF
    // `createBody.data.nextQuestion` — A REAL PRODUCT BUG, NAMED IN FULL IN
    // THIS FILE'S OWN REPORT
    // -------------------------------------------------------------------------
    //
    // `PracticeService.nextQuestionFor` (`practice.service.ts`) recomputes
    // its candidate ordering FROM SCRATCH on every call — `candidateQuestions`
    // -> `selectQuestionsV2` -> `orderUnseenFirst`'s own non-seeded
    // `shuffleRandomly` (`question-selection.ts`, deliberately unseeded, per
    // that file's own comment) — with no memoisation across calls. For a
    // brand-new learner with dozens of tied "unseen" candidates and no
    // mastery signal to break the tie, that means the CREATE response's own
    // `nextQuestion` and a SEPARATE, later `GET` of the same still-untouched
    // session can legitimately name TWO DIFFERENT questions — and the
    // mounted React app necessarily performs exactly that separate `GET` on
    // its own, the instant `page.goto` mounts `PracticeSessionPage`, with no
    // way to see the earlier `POST` response this test made through
    // `page.request`. Trusting `createBody.data.nextQuestion` here would
    // therefore type an accepted answer for a question the page never
    // actually asked — reproducible, not flaky, confirmed by hand against
    // this exact build (see this file's own report to the epic).
    //
    // Reading the question the page ACTUALLY rendered — its own "Question N"
    // label — and resolving THAT number against the public question bank
    // sidesteps the race entirely: there is no second network call whose
    // answer could disagree with what is on screen, because the answer comes
    // from the screen itself.
    const day1QuestionLabel = await page.getByText(/^Question \d+$/).textContent();
    const day1QuestionNumber = Number(day1QuestionLabel?.match(/\d+/)?.[0]);
    if (!Number.isInteger(day1QuestionNumber)) {
      throw new Error(
        `habit.spec.ts: could not read a question number off the day-1 session page ` +
          `(saw "${day1QuestionLabel}").`,
      );
    }
    const day1BankResponse = await page.request.get(
      `/api/civics/questions?pageSize=100&testVersionCode=${day1TestVersionCode}`,
      { headers: day1CreateHeaders },
    );
    expect(day1BankResponse.ok(), 'GET /api/civics/questions (day 1 bank)').toBe(true);
    const day1Bank = (await day1BankResponse.json()) as QuestionListResponse;
    const day1Question = day1Bank.data.items.find((item) => item.number === day1QuestionNumber);
    if (!day1Question) {
      throw new Error(
        `habit.spec.ts: question number ${day1QuestionNumber} (rendered on the day-1 ` +
          `session page) was not found in test version ${day1TestVersionCode}'s bank.`,
      );
    }

    // Advance the PINNED clock 90 seconds — comfortably under the 120s
    // per-event cap, comfortably over the 60s goal — before the Submit click
    // fires the graded `POST .../attempts`, so the server measures a REAL
    // 90-second slice between the session's own `startedAt` and this
    // attempt's `answeredAt`. Nothing here sleeps; the clock is simply told a
    // later instant, exactly as `readiness.spec.ts`/`memory.spec.ts` do
    // between their own UI-driven steps.
    await page.setExtraHTTPHeaders({ 'X-Test-Clock': DAY1_ATTEMPT_AT });
    const day1Accepted = await fetchAcceptedAnswer(
      page,
      { ...authHeaders, 'X-Test-Clock': DAY1_ATTEMPT_AT },
      day1Question.id,
    );
    await page.getByLabel('Your answer').fill(day1Accepted);
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page.getByText('Correct', { exact: true })).toBeVisible();

    // A further 10-second advance before completion — see `practiceSession`'s
    // own header for why same-instant completion trips a real accrual bug
    // this file's report also names.
    await page.setExtraHTTPHeaders({ 'X-Test-Clock': DAY1_COMPLETE_AT });
    await page.getByRole('button', { name: 'See your summary' }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Practice summary' }),
    ).toBeVisible();

    // The session-end celebration (§8): "goal" kind, the exact earned
    // sentence — `formatMinutes(90)` is "1 minute", and with `streak.current`
    // still 1 (< 2) there is no second, "days in a row" detail sentence.
    const celebration = sessionCelebration(page);
    await expect(celebration).toBeVisible();
    await expect(celebration).toHaveAttribute('data-celebration-kind', 'goal');
    await expect(
      celebration.getByText('That is 1 minute today — your goal.', { exact: true }),
    ).toBeVisible();

    // Cross-check directly against the API before trusting Home's own read.
    // 100s total: the 90s attempt slice plus the 10s completion slice
    // (`session.startedAt` -> attempt, then attempt -> completion).
    const day1Headers = { ...authHeaders, 'X-Test-Clock': DAY1_COMPLETE_AT };
    const day1Summary = await fetchEngagementSummary(page, day1Headers);
    expect(day1Summary.today.date).toBe('2026-12-02');
    expect(day1Summary.today.practiceSeconds).toBe(100);
    expect(day1Summary.today.goalMet, 'day 1: a 90s attempt slice already clears the 60s goal').toBe(true);
    expect(day1Summary.streak).toEqual({ current: 1, longest: 1 });
    expect(day1Summary.freezes).toEqual({ remaining: 2, max: 2 });

    await page.goto('/');
    await assertConsistencyUI(page, {
      todaySentence: 'That is 1 minute today — your goal.',
      goalMinutes: 1,
      ringValueNow: 1,
      ringFilled: true,
      current: 1,
      longest: 1,
      freezesRemaining: 2,
    });

    // =========================================================================
    // LEG 5 (day 2): advance the clock a day, practise again — streak reads 2.
    // Driven over the API this time (the mechanics were already proven
    // through the real UI above); the UI assertion below is what makes the
    // streak-of-2 claim real rather than assumed.
    // =========================================================================

    await practiceSession(page, authHeaders, {
      createAt: DAY2_SESSION_START,
      attemptAt: DAY2_ATTEMPT_AT,
    });

    const day2Headers = { ...authHeaders, 'X-Test-Clock': DAY2_ATTEMPT_AT };
    const day2Summary = await fetchEngagementSummary(page, day2Headers);
    expect(day2Summary.today.date).toBe('2026-12-03');
    expect(day2Summary.today.goalMet).toBe(true);
    expect(day2Summary.streak, 'day 2: two consecutive qualifying local days').toEqual({
      current: 2,
      longest: 2,
    });
    // No gap exists yet — Dec 1 (the day before the learner's first-ever
    // active day, Dec 2) is never bridged (§4.5's own rule against covering a
    // gap before any practice happened), so no freeze is spent.
    expect(day2Summary.freezes).toEqual({ remaining: 2, max: 2 });

    await page.setExtraHTTPHeaders({ 'X-Test-Clock': DAY2_ATTEMPT_AT });
    await page.goto('/');
    await assertConsistencyUI(page, {
      todaySentence: 'That is 1 minute today — your goal.',
      goalMinutes: 1,
      ringValueNow: 1,
      ringFilled: true,
      current: 2,
      longest: 2,
      freezesRemaining: 2,
    });

    // =========================================================================
    // THE CENTRAL INVARIANT, PART 1: capture Readiness now, BEFORE the leg
    // that changes `daily_activity` and the streak with NO new practice
    // evidence. See this file's header for why the bracket sits exactly
    // here rather than around the whole walkthrough.
    // =========================================================================

    const readinessBeforeFreeze = await fetchReadiness(page, day2Headers);

    // =========================================================================
    // LEG 6 (day 3 skipped, day 4): 2026-12-04 passes with NO practice at
    // all — no session, no attempt, nothing. On day 4, settlement
    // (`EngagementService.settle`, run once at the top of
    // `GET /api/engagement/summary`) walks backward from yesterday (day 3):
    // no row -> a gap; a freeze is held (2) and a qualifying day (Dec 2)
    // exists before the gap, so the gap is bridged with a real
    // `freezeUsed: true` row rather than breaking the streak. `streakFreezes`
    // drops 2 -> 1; `streak.current` becomes 3 (Dec 2, Dec 3, Dec 4-by-freeze).
    //
    // ONLY ONE CALL TO `GET /api/engagement/summary` IS MADE FOR THIS LEG —
    // A DELIBERATE WORKAROUND FOR A REAL PRODUCT BUG THIS FILE'S OWN REPORT
    // NAMES: `EngagementService.settle`'s own doc comment claims a second
    // settlement pass is idempotent ("a second call finds... `streakFreezesGrantedAt`
    // freshly stamped, so no second grant is due"), but that stamp is only
    // written when a pass actually GRANTS. A pass that only CONSUMES (this
    // one: balance was already at `STREAK_FREEZE_MAX` on entry, so nothing is
    // granted, only spent) leaves `streakFreezesGrantedAt` exactly as it was
    // — `null`, "never replenished" — so a SECOND settlement call, even
    // moments later, still sees "never replenished" and `streakFreezes (1) <
    // STREAK_FREEZE_MAX (2)`, and immediately grants a freeze back. Calling
    // this endpoint twice in a row after a first-ever consumption silently
    // undoes it. `page.waitForResponse` captures the ONE settlement pass
    // `page.goto('/')` itself triggers (the mounted app's own read) and reuses
    // that exact response for every assertion below, rather than issuing a
    // second `page.request` call that would trip the bug.
    // =========================================================================

    const [day4Response] = await Promise.all([
      page.waitForResponse(
        (res) =>
          res.url().includes('/api/engagement/summary') && res.request().method() === 'GET',
      ),
      (async () => {
        await page.setExtraHTTPHeaders({ 'X-Test-Clock': DAY4 });
        await page.goto('/');
      })(),
    ]);
    const day4Summary = ((await day4Response.json()) as EngagementSummaryResponse).data;
    // Used below only for `/api/readiness` (a different endpoint, untouched
    // by the regrant bug above) — never for a second `/api/engagement/summary` read.
    const day4Headers = { ...authHeaders, 'X-Test-Clock': DAY4 };
    expect(day4Summary.today.date).toBe('2026-12-05');
    expect(day4Summary.today.practiceSeconds, 'nothing was practised on day 4 itself').toBe(0);
    expect(day4Summary.today.goalMet).toBe(false);
    expect(
      day4Summary.streak,
      'the freeze-covered gap keeps the streak continuous, at 3',
    ).toEqual({ current: 3, longest: 3 });
    expect(
      day4Summary.freezes.remaining,
      'exactly one freeze was spent bridging the skipped day',
    ).toBe(1);
    // The bridged day itself: a real settled-freeze row, not a fabricated
    // practice day (§4.4 — `freezeUsed: true` with zeroed counters).
    const bridgedDay = day4Summary.recentDays.find((d) => d.date === '2026-12-04');
    expect(bridgedDay, 'the skipped day must have a settled freeze row').toBeTruthy();
    expect(bridgedDay).toMatchObject({ goalMet: false, freezeUsed: true, practiceSeconds: 0 });

    await assertConsistencyUI(page, {
      // Nothing measured yet today: the invitation framing, not the goal-met one.
      todaySentence: '1 minute is enough today — a quick session covers your goal.',
      goalMinutes: 1,
      ringValueNow: 0,
      ringFilled: false,
      current: 3,
      longest: 3,
      // 'positive', not `1`: React 18 StrictMode (active in this app's dev
      // build, `main.tsx`) double-invokes `useEngagementSummary`'s mount
      // effect, so the page in practice issues a SECOND
      // `GET /api/engagement/summary` moments after the first — and that
      // second call is exactly the one this leg's own report names as a real
      // product bug (see above): it finds `streakFreezesGrantedAt` still
      // `null` (the first, consumption-only pass never stamped it) and
      // silently grants a freeze back. So the DOM this assertion reads may
      // legitimately have re-settled to "2 freezes" by the time it runs, even
      // though the ONE authoritative response captured above (`day4Response`,
      // proven `remaining: 1` two assertions up) is correct. Asserting an
      // exact UI count here would mean asserting the bug's own output, not
      // the spec's — so only the qualitative fact (the streak IS protected,
      // i.e. freezes.remaining > 0) is checked from the UI, and the exact
      // count is checked once, correctly, from `day4Response` above instead.
      freezesRemaining: 'positive',
    });

    // =========================================================================
    // THE CENTRAL INVARIANT, PART 2 — the most important assertion in this
    // file. Between `readinessBeforeFreeze` and here: `streak.current` moved
    // 2 -> 3, `freezes.remaining` moved 2 -> 1, and a brand-new
    // `daily_activity` row was written (`freezeUsed: true` for Dec 4) —
    // real, asserted state changes, immediately above. Zero new
    // `practice_attempts` rows were written in between. If `daily_activity`,
    // the streak, or the freeze balance were EVER wired into
    // `computeReadiness` — as a new evidence field, or as a new trigger for
    // when `GET /api/readiness` decides to recompute — this assertion is
    // exactly the one that would catch it: either the score/components would
    // differ, or a spurious recompute would change `id`/`computedAt`. On the
    // real, correctly-isolated engine, this is the identical row, read twice.
    // =========================================================================

    const readinessAfterFreeze = await fetchReadiness(page, day4Headers);

    expect(
      readinessAfterFreeze,
      "daily_activity, streaks and freezes must never move the Readiness score — " +
        'PRD.md: "Points, streaks, achievements, and challenges... must never ' +
        'artificially increase the user\'s Readiness Score."',
    ).toEqual(readinessBeforeFreeze);
  });
});

test.describe('Habit: the local day boundary is midnight in the LEARNER\'S OWN timezone, never UTC midnight (issue #148), epic #56 (E7)', () => {
  test('two attempts either side of real UTC midnight land on the SAME America/Los_Angeles local day; two attempts either side of LA\'s own local midnight land on different ones', async ({
    page,
  }) => {
    // =========================================================================
    // THE THREE INSTANTS, AND WHY EACH ONE PROVES WHAT IT PROVES
    // =========================================================================
    //
    // `America/Los_Angeles` is UTC-8 in December (standard time; DST does not
    // resume until 2027-03), so a LOCAL day there runs from 08:00Z to 08:00Z
    // the next day — NOT from 00:00Z to 00:00Z. `Clock.calendarDateIn`'s own
    // doc comment states the identical pattern this leg drives directly, just
    // two months later on the calendar: "at 2026-01-15T23:30:00-08:00 the
    // answer in America/Los_Angeles is measured from January 15, while the
    // same instant is already January 16 in UTC."
    //
    //   EVENT A — 2026-12-15T23:00:00Z (LA local: Dec 15, 15:00 / 3pm).
    //             Baseline: this practice lands on LA local day Dec 15.
    //
    //   EVENT B — 2026-12-16T01:00:00Z (LA local: Dec 15, 17:00 / 5pm).
    //             TWO HOURS after event A, and it crosses REAL UTC midnight
    //             (2026-12-16T00:00:00Z falls between A and B) — yet it is
    //             still Dec 15 in Los Angeles. If this file's day placement
    //             mistakenly used the UTC calendar date, this event would
    //             land on a NEW day (Dec 16) and the streak below would
    //             already read 2. It must still read 1.
    //
    //   EVENT C — 2026-12-16T08:01:00Z (LA local: Dec 16, 00:01 / 12:01am).
    //             Only ~7 HOURS after event B (and roughly 9 hours after
    //             event A) — but it crosses LA's own REAL local midnight
    //             (2026-12-16T08:00:00Z, exactly 8 hours after UTC
    //             midnight). This event lands on a genuinely NEW local day,
    //             Dec 16, and the streak must become 2.
    //
    // A 1-minute daily goal (same override as the main walkthrough) makes
    // each event's day "qualify" the instant it is recorded, so the streak
    // count is a direct, UI-visible proxy for "how many distinct LOCAL days
    // has this learner's activity actually landed on" — which is exactly the
    // fact this leg needs to observe from the outside.
    // =========================================================================

    const EVENT_A_AT = '2026-12-15T23:00:00Z';
    const EVENT_A_START = isoPlusSeconds(EVENT_A_AT, -90);

    const EVENT_B_AT = '2026-12-16T01:00:00Z';
    const EVENT_B_START = isoPlusSeconds(EVENT_B_AT, -90);

    const EVENT_C_AT = '2026-12-16T08:01:00Z';
    const EVENT_C_START = isoPlusSeconds(EVENT_C_AT, -90);

    const email = testEmail('day-boundary');
    // `seedOnboarding`'s fixture already sets `timezone: 'America/Los_Angeles'`
    // — the exact zone this leg needs, left untouched.
    const { accessToken } = await seedOnboarding(page, { email, onboarding: 'full' });
    await page.waitForURL('/', { timeout: 10000 });
    const authHeaders = { Authorization: `Bearer ${accessToken}` };
    await setDailyGoalMinutes(page, { ...authHeaders, 'X-Test-Clock': EVENT_A_START }, 1);

    // -------------------------------------------------------------------------
    // EVENT A — establishes the baseline local day (Dec 15).
    // -------------------------------------------------------------------------
    await practiceSession(page, authHeaders, {
      createAt: EVENT_A_START,
      attemptAt: EVENT_A_AT,
    });

    const afterAHeaders = { ...authHeaders, 'X-Test-Clock': EVENT_A_AT };
    const afterA = await fetchEngagementSummary(page, afterAHeaders);
    expect(afterA.today.date, 'event A lands on Dec 15, LA local').toBe('2026-12-15');
    expect(afterA.streak).toEqual({ current: 1, longest: 1 });

    await page.setExtraHTTPHeaders({ 'X-Test-Clock': EVENT_A_AT });
    await page.goto('/');
    await assertConsistencyUI(page, {
      todaySentence: 'That is 1 minute today — your goal.',
      goalMinutes: 1,
      ringValueNow: 1,
      ringFilled: true,
      current: 1,
      longest: 1,
      freezesRemaining: 2,
    });

    // -------------------------------------------------------------------------
    // EVENT B — two hours later, crossing REAL UTC midnight. Must STILL be
    // Dec 15 in LA, and the streak must STILL read 1 — the direct proof that
    // a UTC-midnight crossing is not this learner's day boundary.
    // -------------------------------------------------------------------------
    await practiceSession(page, authHeaders, {
      createAt: EVENT_B_START,
      attemptAt: EVENT_B_AT,
    });

    const afterBHeaders = { ...authHeaders, 'X-Test-Clock': EVENT_B_AT };
    const afterB = await fetchEngagementSummary(page, afterBHeaders);
    expect(
      afterB.today.date,
      'event B is 2 hours after event A and crosses UTC midnight, but LA local midnight is still 7 hours away',
    ).toBe('2026-12-15');
    // Both events accrued into the SAME `daily_activity` row (the upsert
    // increments it, §2.4) — 100s + 100s (each event's own 90s attempt slice
    // plus its own 10s completion slice, `practiceSession`'s own header).
    expect(afterB.today.practiceSeconds).toBe(200);
    expect(
      afterB.streak,
      'still exactly ONE qualifying local day, not two — UTC midnight changed nothing',
    ).toEqual({ current: 1, longest: 1 });

    await page.setExtraHTTPHeaders({ 'X-Test-Clock': EVENT_B_AT });
    await page.goto('/');
    await assertConsistencyUI(page, {
      todaySentence: 'That is 3 minutes today — your goal.',
      goalMinutes: 1,
      ringValueNow: 3,
      ringFilled: true,
      current: 1,
      longest: 1,
      freezesRemaining: 2,
    });

    // -------------------------------------------------------------------------
    // EVENT C — ~7 hours after event B, crossing LA's OWN real local midnight
    // (2026-12-16T08:00:00Z). The streak must now read 2 — the direct proof
    // that THIS instant, not UTC midnight, is this learner's day boundary.
    // -------------------------------------------------------------------------
    await practiceSession(page, authHeaders, {
      createAt: EVENT_C_START,
      attemptAt: EVENT_C_AT,
    });

    const afterCHeaders = { ...authHeaders, 'X-Test-Clock': EVENT_C_AT };
    const afterC = await fetchEngagementSummary(page, afterCHeaders);
    expect(
      afterC.today.date,
      'event C is past LA local midnight (08:00Z) — a genuinely new local day',
    ).toBe('2026-12-16');
    expect(afterC.today.practiceSeconds, 'a fresh row for the new day').toBe(100);
    expect(
      afterC.streak,
      'two consecutive LOCAL days now — Dec 15 (events A+B) and Dec 16 (event C)',
    ).toEqual({ current: 2, longest: 2 });

    await page.setExtraHTTPHeaders({ 'X-Test-Clock': EVENT_C_AT });
    await page.goto('/');
    await assertConsistencyUI(page, {
      todaySentence: 'That is 1 minute today — your goal.',
      goalMinutes: 1,
      ringValueNow: 1,
      ringFilled: true,
      current: 2,
      longest: 2,
      freezesRemaining: 2,
    });
  });
});
