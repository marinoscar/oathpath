import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { seedOnboarding } from '../helpers/auth.helper';
import { fetchAcceptedAnswer } from '../helpers/practice-questions';

// =============================================================================
// mock-interview-text.spec.ts — issue #151, epic #57 (E8 "Mock interview —
// text mode")
// =============================================================================
//
// `docs/specs/mock-interview.md` is the design this spec is checked against.
// Three runs, exactly as the issue asks for, and this file is built around
// them in order: the 2008 civics bank, the 2025 bank against the SAME script
// with no code change between the two, and the two negative properties (no
// verdict before completion, no learner answer text after retention-off).
//
// -----------------------------------------------------------------------------
// EXECUTION
// -----------------------------------------------------------------------------
//
// `playwright.config.ts`'s own `webServer` starts the stack with `docker
// compose`, which the sandbox this file was originally written in has no
// daemon for — every selector, route, heading and copy string below was
// FIRST written by reading it directly out of the shipped source cited beside
// it (`apps/web/src/pages/InterviewStartPage.tsx`, `InterviewPage.tsx`,
// `InterviewDebriefPage.tsx`, the components under
// `apps/web/src/components/interview/`, and `apps/api/src/interviews/`'s
// controller, service and DTOs), never invented or guessed. It was then
// actually run — all three tests, three times in a row for stability — against
// a real API (`AI_PROVIDER_FAKE=true`) and a real seeded Postgres carrying
// both civics banks, and every assertion below is what passed there, not
// merely what was expected to. `npx tsc --noEmit` also passes clean.
//
// One real, reproducible bug surfaced and is fixed in place, documented at
// its own definition below (`seedOnboardingAndSettle`): `AuthContext.tsx`'s
// own background token-refresh, racing this spec's first `page.goto()`, can
// rotate the refresh-token cookie out from under the very page that requested
// it. Every other spec's own setup happens to dodge this by accident (a
// `page.request` call or two before its first `page.goto`); this file is the
// first to hit it deterministically and the fix removes the race at its root
// rather than relying on that incidental delay.
//
// -----------------------------------------------------------------------------
// WHY THE PRACTICE PAGE BAND, NOT HOME'S NEXT-UP CARD
// -----------------------------------------------------------------------------
//
// The issue names both as acceptable entry points and asks this file to pick
// whichever is genuinely reachable. Home's Next-up card only offers
// `nextAction: 'interview'` at journey stage `practicing` or beyond
// (`mock-interview.md` §14.1, `study-coach.ts`'s ranking). A learner seeded by
// `seedOnboarding` starts at stage `uncertain` and moves to `oriented` the
// moment orientation completes (`journey.service.ts`'s `updateProfile`) —
// reaching `practicing` needs a real, multi-day readiness walkthrough this
// spec has no business orchestrating just to reach the start screen, and,
// more importantly, `PracticePage.tsx`'s own header states outright that its own
// "Mock interview" band is "shown to everyone with a resolved test version,
// and NOT gated on the journey stage... a menu that hides an option a learner
// is entitled to choose is a product deciding for them." That band —
// `/practice`'s "Start a mock interview" link to `INTERVIEWS_PATH` — is the
// one that is genuinely reachable for a freshly oriented learner, and it is
// what this spec drives through.
//
// -----------------------------------------------------------------------------
// WHY THE VERSION IS SWITCHED WITH `filingDate`, NEVER `testVersionCode`
// -----------------------------------------------------------------------------
//
// `seedOnboarding`'s own header is explicit: `PUT /api/journey/profile` 400s
// if both `filingDate` and `testVersionCode` are sent, and the version is
// resolved server-side from the filing date
// (`apps/api/src/journey/test-version-resolution.ts`) — a spec that hardcoded
// a version CODE is exactly what that file's header forbids. `ORIENTATION_PROFILE`
// fixes `filingDate: '2020-01-15'`, which resolves to the pre-cutoff bank
// (`resolveTestVersionCode`: `filingDate >= '2025-10-20' ? v2025 : v2008`).
// For the 2025 run, this spec sends one more `PUT /api/journey/profile` with
// only `{ filingDate: <a date on/after the cutoff> }` — every field on that
// DTO is optional and merge-under-a-PUT (`update-journey-profile.dto.ts`'s own
// header), so this changes nothing else on the profile, and orientation stays
// complete (`journey.service.ts`'s `orientationCompleted` guard only fires
// when `orientationCompletedAt === null`, which is already false). This spec
// never asserts a version CODE literal anywhere — not `'v2008'`, not
// `'v2025'` — only the observable behaviour the row drives: the pass
// threshold and the plan size the API itself echoes back.
//
// -----------------------------------------------------------------------------
// WHY EVERY CIVICS ANSWER IS EXACT-MATCHED, NEVER GRADED BY A MODEL
// -----------------------------------------------------------------------------
//
// Identical reasoning to `practice-session.spec.ts` and `readiness.spec.ts`:
// `AiDispatchService`'s `resolve()` checks the system-wide `ai.enabled` switch
// FIRST (`ai-dispatch.service.ts`: `if (!settings.enabled) return
// unavailable('ai_disabled')`), before it ever reaches for a caller's own key,
// and `enabled` defaults to `false` (`ai-settings.schema.ts`'s
// `DEFAULT_AI_SETTINGS`). This spec never touches `/admin/settings/ai` or sets
// `AI_PROVIDER_FAKE`, so the officer's every acknowledgement resolves
// `unavailable` (`cause: 'ai_disabled'`) and the interview proceeds on the
// code-owned neutral fallback line (§5.2, §9.2) — which is fine, because
// nothing this spec asserts depends on the officer's exact wording. What
// DOES have to be exact is the civics grading, and every answer typed below is
// the accepted answer read verbatim off `GET /api/civics/questions/:id`
// (`fetchAcceptedAnswer`, reused unchanged from `practice-questions.ts`) —
// `matchAnswer`'s rung-1 exact/normalised check, never rung 2's AI grader.
// This is what makes "answer correctly until the early stop" a deterministic,
// AI-independent claim rather than one that depends on whatever
// `AI_PROVIDER_FAKE` happens to be configured to in the environment this runs
// in.
//
// -----------------------------------------------------------------------------
// HOW A TURN IS DRIVEN: THE UI FOR THE ACT, THE API FOR "WHAT IS BEING ASKED"
// -----------------------------------------------------------------------------
//
// Every applicant turn is typed into the real `AnswerBox` and sent by clicking
// the real "Answer" button — this is an end-to-end spec of the product, not a
// script that calls `POST /api/interviews/:id/turns` directly. But WHICH
// question is on the table, and whether it is even a civics question, is read
// off `GET /api/interviews/:id`'s own `turns` array before each answer is
// typed — the identical "ask the server what it is currently asking" discipline
// `fetchNextQuestionId`/`fetchAcceptedAnswer` already establish for practice,
// applied here because `InterviewPage` renders no question id anywhere in its
// DOM (by design — §5.1: the id never needs to reach the client for the
// question text to render, since the prompt is assembled server-side) and this
// spec has no business predicting the seeded ask-list itself (§3 — the ask-list
// is a function of the interview's own freshly-generated uuid, unknowable in
// advance).
//
// -----------------------------------------------------------------------------
// WHY EACH CASE IS A FRESH LEARNER
// -----------------------------------------------------------------------------
//
// The readiness `interview` component is `min(mockInterviewsPassed / 2, 1)`
// (`readiness-model.md` §2.8) — a SECOND passed interview for the same learner
// would move it to `1.0`, not `0.5`, and the ground-truth fact this spec checks
// against ("0 to 0.5 after one passed interview") is specifically about the
// FIRST one. Each run below therefore seeds its own learner, so the
// before/after readiness comparison is never contaminated by an earlier run's
// own passed interview.
//
// -----------------------------------------------------------------------------
// GROUND TRUTH USED BELOW, AS SUPPLIED AND VERIFIED LIVE (NOT RE-DERIVED HERE)
// -----------------------------------------------------------------------------
//
// Phase sequence: smalltalk (1 officer turn) -> n400 (3) -> civics -> reading
// (skipped) -> writing (skipped) -> closing. Answering every civics question
// correctly: the 2008 bank stops at exactly 6 of 10 planned
// (`stopReason: 'threshold_reached'`); the 2025 bank stops at exactly 12 of
// 20 — with NO CODE CHANGE between the two, only the filing date. `POST
// /api/interviews` with no body defaults `transcriptRetained` to `false`. With
// retention off, every applicant turn's `text` comes back `''` through `GET
// /api/interviews/:id`, and `practice_attempts.response_text` is `null` (not
// independently checkable through this API — see the report). The debrief's
// `civics` object is `{planned, asked, correct, threshold, passed,
// stoppedEarly, stopReason}`. `readiness.interviewComponent` goes from `0` to
// `0.5` after one passed interview, and `capReason` goes `'typed_only'` to
// `null`. Another learner's interview id is a 404.
//
// -----------------------------------------------------------------------------
// STOP COUNTS ARE READ FROM THE API, NEVER RESTATED AS MAGIC NUMBERS
// -----------------------------------------------------------------------------
//
// The two CASES below carry `expectedThreshold`/`expectedPlanned` so the file
// documents the two known-good numbers as a table (and so a wrong environment
// — content re-seeded with different thresholds — fails loudly rather than
// silently), but the load-bearing assertion is `civics.asked === civics.threshold`
// and `civics.correct === civics.threshold`, read back from the SAME response,
// never a hardcoded `6` or `12` compared against the observed count. That is
// what proves the pass rule is a row this spec's own two cases exercise
// identically, not a constant duplicated once per case.
// =============================================================================

function testEmail(label: string): string {
  return `mock-interview-${label}-${randomUUID()}@test.local`;
}

// -----------------------------------------------------------------------------
// Wire shapes — the exact fields the DTOs cited beside each declare.
// -----------------------------------------------------------------------------

type InterviewStopReason =
  | 'threshold_reached'
  | 'threshold_unreachable'
  | 'all_asked';

interface InterviewTurnRecord {
  id: string;
  turnIndex: number;
  role: 'officer' | 'applicant';
  phase: string;
  questionId: string | null;
  text: string;
  createdAt: string;
}

interface InterviewHeader {
  id: string;
  mode: string;
  status: 'in_progress' | 'completed' | 'abandoned';
  testVersionCode: string;
  seniorExemption: boolean;
  transcriptRetained: boolean;
  startedAt: string;
  completedAt: string | null;
  civicsAsked: number;
  civicsCorrect: number;
  passedCivics: boolean;
}

interface InterviewCivicsResult {
  planned: number;
  asked: number;
  correct: number;
  threshold: number;
  passed: boolean;
  stoppedEarly: boolean;
  stopReason: InterviewStopReason;
}

interface InterviewDebriefQuestion {
  questionId: string;
  number: number;
  prompt: string;
  categoryName: string;
  outcome: 'correct' | 'partial' | 'incorrect' | 'skipped';
  acceptedAnswers: string[];
}

interface InterviewPhaseStatus {
  kind: 'smalltalk' | 'n400' | 'civics' | 'reading' | 'writing' | 'closing';
  status: 'completed' | 'skipped';
}

interface InterviewReadinessSummary {
  score: number;
  previousScore: number | null;
  delta: number | null;
  capReason: 'typed_only' | null;
  capMessage: string | null;
  interviewComponent: { value: number; evidenceCount: number };
}

interface InterviewDebrief {
  civics: InterviewCivicsResult;
  questions: InterviewDebriefQuestion[];
  phases: InterviewPhaseStatus[];
  focusAreas: string[];
  readiness: InterviewReadinessSummary;
}

interface InterviewStateResponse {
  data: {
    interview: InterviewHeader;
    officerTurns: InterviewTurnRecord[];
    progress: { civicsAsked: number; civicsPlanned: number };
    awaitingCompletion: boolean;
  };
}

interface InterviewDetailResponse {
  data: {
    interview: InterviewHeader;
    turns: InterviewTurnRecord[];
    progress: { civicsAsked: number; civicsPlanned: number };
    awaitingCompletion: boolean;
    debrief: InterviewDebrief | null;
  };
}

interface InterviewDebriefResponse {
  data: InterviewDebrief;
}

interface JourneyProfileResponse {
  data: { profile: { testVersionCode: string | null } };
}

interface ReadinessSnapshotResponse {
  data: {
    score: number;
    capReason: 'typed_only' | null;
  };
}

// -----------------------------------------------------------------------------
// Login, and the one auth race every call site below that later does a full
// `page.goto()` needs settled first.
// -----------------------------------------------------------------------------
//
// `AuthContext.tsx`'s session-check effect (`useEffect(..., [location.pathname])`)
// fires an UNCONDITIONAL `POST /api/auth/refresh` the instant the SPA
// navigates from `/auth/callback` to `/` — its `initRef` guard only blocks a
// SECOND run; the callback page's own render (`location.pathname ===
// '/auth/callback'`) hits the early return WITHOUT setting it, so the very
// next render at `/` runs `initAuth()` for the first time. `seedOnboarding`
// itself returns as soon as its own `page.goto(callbackUrl)` resolves, which
// is well BEFORE that background refresh call — traced end to end against
// the real stack — has even been dispatched.
//
// If a caller then does its OWN `page.goto()` (the only way this spec ever
// reaches `/practice`, `/practice/interviews`, etc. from a cold boot) while
// that background refresh is still in flight, the browser cancels the
// request client-side — but the SERVER may already have received and
// processed it, rotating the refresh-token cookie before the response (and
// its `Set-Cookie`) is ever applied. The next page's own boot-time refresh
// then presents the now-already-rotated cookie and gets a 401 — a real,
// reproducible "refresh token reuse" failure, not a flake to retry past.
//
// Every EXISTING spec's own setup happens to dodge this by accident: each
// one makes a `page.request` call or two (a session read, a question-bank
// fetch) before its first `page.goto`, and that real network round trip is
// enough wall-clock time for the background refresh to complete on its own.
// This spec's own run three has no such call before it needs to reach
// `/practice`, so it hits the race deterministically — confirmed by tracing
// `/api/auth/*` requests against the real stack with and without an
// intervening wait. Waiting for that one background refresh explicitly, once,
// removes the race at its root rather than relying on an incidental delay
// that happens not to apply to every call site here.
// -----------------------------------------------------------------------------

/**
 * `seedOnboarding`, plus the wait above. The listener is registered BEFORE
 * `seedOnboarding` is even called, so it cannot miss the response — the
 * background refresh cannot fire before the login it is triggered by.
 */
async function seedOnboardingAndSettle(
  page: Page,
  options: { email: string; onboarding: 'full' },
): Promise<{ accessToken: string }> {
  const refreshSettled = page
    .waitForResponse((res) => res.url().includes('/api/auth/refresh'), {
      timeout: 5000,
    })
    .catch(() => null);

  const result = await seedOnboarding(page, options);
  await page.waitForURL('/', { timeout: 10000 });
  await refreshSettled;

  return result;
}

// -----------------------------------------------------------------------------
// API helpers
// -----------------------------------------------------------------------------

/** `PUT /api/journey/profile`, `interviews.controller.ts`'s own upstream. */
async function setFilingDate(
  page: Page,
  headers: Record<string, string>,
  filingDate: string,
): Promise<string> {
  const response = await page.request.put('/api/journey/profile', {
    headers,
    data: { filingDate },
  });
  expect(response.ok(), 'PUT /api/journey/profile (filingDate override)').toBe(
    true,
  );
  const body = (await response.json()) as JourneyProfileResponse;
  const code = body.data.profile.testVersionCode;
  if (!code) {
    throw new Error(
      'setFilingDate: profile has no resolved testVersionCode after the update',
    );
  }
  return code;
}

/** The caller's currently-resolved test version code — never hardcoded. */
async function fetchResolvedTestVersionCode(
  page: Page,
  headers: Record<string, string>,
): Promise<string> {
  const response = await page.request.get('/api/journey/profile', { headers });
  expect(response.ok(), 'GET /api/journey/profile').toBe(true);
  const body = (await response.json()) as JourneyProfileResponse;
  const code = body.data.profile.testVersionCode;
  if (!code) {
    throw new Error('fetchResolvedTestVersionCode: no resolved test version');
  }
  return code;
}

async function fetchInterviewDetail(
  page: Page,
  headers: Record<string, string>,
  interviewId: string,
): Promise<InterviewDetailResponse['data']> {
  const response = await page.request.get(`/api/interviews/${interviewId}`, {
    headers,
  });
  expect(response.ok(), 'GET /api/interviews/:id').toBe(true);
  const body = (await response.json()) as InterviewDetailResponse;
  return body.data;
}

/**
 * `POST /api/interviews/:id/complete`, called AFTER the UI has already
 * finished the interview (`EndInterviewControl`'s "Finish and see how it
 * went"). Idempotent (`interviews.controller.ts`'s own doc comment: "a
 * double-tap must not write a second readiness snapshot for one interview") —
 * this call returns the identical stored debrief and computes nothing new, so
 * calling it again here is a READ of what the UI already produced, not a
 * second interview outcome, and is how this spec gets the exact debrief JSON
 * to assert against without scraping every number off the page.
 */
async function fetchDebrief(
  page: Page,
  headers: Record<string, string>,
  interviewId: string,
): Promise<InterviewDebrief> {
  const response = await page.request.post(
    `/api/interviews/${interviewId}/complete`,
    { headers },
  );
  expect(response.ok(), 'POST /api/interviews/:id/complete (idempotent read)').toBe(
    true,
  );
  const body = (await response.json()) as InterviewDebriefResponse;
  return body.data;
}

async function fetchReadiness(
  page: Page,
  headers: Record<string, string>,
): Promise<ReadinessSnapshotResponse['data']> {
  const response = await page.request.get('/api/readiness', { headers });
  expect(response.ok(), 'GET /api/readiness').toBe(true);
  const body = (await response.json()) as ReadinessSnapshotResponse;
  return body.data;
}

// -----------------------------------------------------------------------------
// UI helpers
// -----------------------------------------------------------------------------

/**
 * `/practice` -> "Start a mock interview" -> `/practice/interviews`
 * (`InterviewStartPage`) -> "Start the interview", retention left at its
 * default (off). Returns the new interview's id, read off the resulting URL —
 * the identical `page.url().split('/').pop()` idiom `practice-session.spec.ts`
 * uses for a freshly created session id.
 *
 * Every string asserted here is read verbatim from `PracticePage.tsx` and
 * `InterviewStartPage.tsx` — see this file's header for the reachability
 * argument for why this is the entry point and not Home's Next-up card.
 */
async function startInterviewFromPracticePage(page: Page): Promise<string> {
  await page.goto('/practice');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Practice' }),
  ).toBeVisible();

  // `PracticePage.tsx`: the "Mock interview" band's own link, a real
  // `RouterLink` to `INTERVIEWS_PATH` ('/practice/interviews'), never a POST.
  const startLink = page.getByRole('link', { name: 'Start a mock interview' });
  await expect(startLink).toHaveAttribute('href', '/practice/interviews');
  await startLink.click();

  await expect(page).toHaveURL('/practice/interviews');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Mock interview' }),
  ).toBeVisible();

  // §10 and §4.1, said on the start screen before the learner commits
  // (`InterviewStartPage.tsx`'s "What to expect" bullets, verbatim).
  await expect(
    page.getByText(
      'You won’t be told how you are doing while it runs. There is no ' +
        'score, no tick and no correction between questions — the real ' +
        'interview doesn’t give you one either. Everything comes at the end.',
    ),
  ).toBeVisible();
  await expect(
    page.getByText(
      'The civics section can finish early, in either direction. An officer ' +
        'who has heard enough correct answers stops, and so does one who has ' +
        'heard enough wrong ones.',
    ),
  ).toBeVisible();

  // §8.1: retention is OFF by default, and this is the one screen that ever
  // asks — `RetentionChoice.tsx`'s own `FormControlLabel`/`Switch`. MUI's
  // `Switch` puts `role="switch"` on the underlying input, never
  // `"checkbox"` — confirmed against this repo's own
  // `FeatureFlagsList.test.tsx`, whose `switchFor` helper queries
  // `getByRole('switch', ...)` for the identical component.
  const retentionSwitch = page.getByRole('switch', {
    name: 'Keep a transcript of this interview',
  });
  await expect(retentionSwitch).not.toBeChecked();
  // Left untouched — this spec exercises the default, private outcome §15
  // says a learner who never touches the control must get.

  // First interview ever for this learner: the history band's honest empty
  // state, never a fabricated "0 interviews" (`InterviewStartPage.tsx`'s own
  // header).
  await expect(
    page.getByText(
      'You haven’t sat a mock interview yet. Once you do, each one ' +
        'shows up here so you can read back how it went.',
    ),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Start the interview' }).click();

  await expect(page).toHaveURL(/\/practice\/interviews\/[0-9a-f-]{36}$/);
  const interviewId = page.url().split('/').pop();
  if (!interviewId) {
    throw new Error(
      'startInterviewFromPracticePage: could not read the interview id off the URL',
    );
  }
  return interviewId;
}

/**
 * One applicant turn: fill `AnswerBox`, click "Answer", and wait for the turn
 * to land — either the box re-arms for the next question, or the interview
 * has run out of phases and shows "Finish and see how it went"
 * (`InterviewPage.tsx`'s `awaitingCompletion` branch).
 *
 * `AnswerBox`'s submit button's own accessible name is `pending ? 'Sending…'
 * : 'Answer'` (`AnswerBox.tsx`), so waiting for the exact name `'Answer'` (or
 * the finish control) to reappear IS waiting for `isStreaming` to have gone
 * false — no arbitrary sleep, no polling loop of our own.
 */
async function waitForNextTurnOrCompletion(page: Page): Promise<void> {
  const answerButton = page.getByRole('button', { name: 'Answer', exact: true });
  const finishButton = page.getByRole('button', {
    name: 'Finish and see how it went',
    exact: true,
  });
  await expect(answerButton.or(finishButton)).toBeVisible({ timeout: 20000 });
}

async function submitAnswer(page: Page, text: string): Promise<void> {
  await page.getByLabel('Your answer').fill(text);
  await page.getByRole('button', { name: 'Answer', exact: true }).click();
  await waitForNextTurnOrCompletion(page);
}

/** Every word `outcomeDisplay` (`components/practice/outcome.ts`) uses for a recorded outcome. */
const VERDICT_WORDS = ['Correct', 'Partly right', 'Not a match', 'Skipped'];

/**
 * `InterviewPage.tsx`'s own load-bearing property, checked from the outside:
 * none of the practice screens' verdict vocabulary is anywhere on this page,
 * whichever answer was just graded. Called after every exchange when
 * `assertNoVerdict` is true (run three).
 */
async function assertNoVerdictOnScreen(page: Page): Promise<void> {
  for (const word of VERDICT_WORDS) {
    await expect(page.getByText(word, { exact: true })).toHaveCount(0);
  }
}

/**
 * Drive the interview to `awaitingCompletion`, answering every civics
 * question CORRECTLY (the accepted answer read verbatim off
 * `GET /api/civics/questions/:id`, via `fetchAcceptedAnswer`) and every
 * non-civics officer turn (smalltalk, the three n400 prompts) with arbitrary
 * text — neither is graded (§2.1, §2.2). Never types the applicant's turn
 * from anything the client already computed; the loop asks the server what
 * is being asked, every time, before it types an answer.
 *
 * When `assertNoVerdict` is true, checks `assertNoVerdictOnScreen` after
 * every single exchange, including the very last one that lands on
 * "awaiting completion" — run three's negative property 1 has to hold at
 * EVERY point before completion, not only mid-interview.
 */
async function driveThroughInterview(
  page: Page,
  headers: Record<string, string>,
  interviewId: string,
  options: {
    assertNoVerdict?: boolean;
    /** Text to submit for the FIRST civics question — a hook run three uses to answer it wrong on purpose. Every other civics question is answered correctly. */
    firstCivicsAnswerOverride?: string;
  } = {},
): Promise<void> {
  const { assertNoVerdict = false, firstCivicsAnswerOverride } = options;
  let civicsQuestionsSeen = 0;

  await waitForNextTurnOrCompletion(page);
  if (assertNoVerdict) await assertNoVerdictOnScreen(page);

  const finishButton = page.getByRole('button', {
    name: 'Finish and see how it went',
    exact: true,
  });

  while (!(await finishButton.isVisible().catch(() => false))) {
    const detail = await fetchInterviewDetail(page, headers, interviewId);
    const lastTurn = detail.turns[detail.turns.length - 1];
    if (!lastTurn || lastTurn.role !== 'officer') {
      throw new Error(
        `driveThroughInterview: expected the last turn to be the officer's, got ${JSON.stringify(
          lastTurn,
        )}`,
      );
    }

    let text = 'Practicing my answer, the way I would say it out loud.';
    if (lastTurn.phase === 'civics' && lastTurn.questionId) {
      civicsQuestionsSeen += 1;
      if (civicsQuestionsSeen === 1 && firstCivicsAnswerOverride !== undefined) {
        text = firstCivicsAnswerOverride;
      } else {
        text = await fetchAcceptedAnswer(page, headers, lastTurn.questionId);
      }
    }

    await submitAnswer(page, text);
    if (assertNoVerdict) await assertNoVerdictOnScreen(page);
  }
}

// -----------------------------------------------------------------------------
// Copy — copied verbatim from `components/interview/debriefCopy.ts` and
// `readiness/top-recommendation.ts`'s cap sentence (by way of
// `readiness.spec.ts`), the same "a separate package, copy the string" house
// convention every spec in this directory already follows for cross-package
// copy it cannot import.
// -----------------------------------------------------------------------------

/** `debriefCopy.ts`'s `civicsVerdictLabel`. */
function civicsVerdictLabel(passed: boolean): string {
  return passed ? 'Civics section passed' : 'Civics section not passed';
}

/** `debriefCopy.ts`'s `civicsCountsSentence`. */
function civicsCountsSentence(civics: InterviewCivicsResult): string {
  return (
    `${civics.correct} of ${civics.asked} answered correctly. ` +
    `${civics.threshold} of ${civics.planned} is the pass mark for this test.`
  );
}

/** `debriefCopy.ts`'s `stopReasonSentence`, the `threshold_reached` branch — the only one this spec's all-correct runs ever reach. */
function thresholdReachedSentence(civics: InterviewCivicsResult): string {
  return (
    `The officer stopped after ${civics.asked} of ${civics.planned} questions: ` +
    `${civics.threshold} correct is the pass mark, and it had been reached. ` +
    'The real interview ends the civics section the same way.'
  );
}

/** `readiness/top-recommendation.ts`'s `cappedRecommendation()`, copied from `readiness.spec.ts`. */
const CAP_TITLE = 'Limited interview practice';
const CAP_REASON =
  'Your civics knowledge is strong, but you have limited interview practice. ' +
  'Completing two mock interviews is the best way to strengthen your readiness now.';

// =============================================================================
// RUN ONE & RUN TWO — one parameterised body, two civics banks, no code
// change between them.
// =============================================================================
//
// This is the strongest available evidence that the pass rule is a row and
// not a constant (`mock-interview.md` §4's own argument, restated as a test
// structure rather than a comment): the SAME script below runs twice, against
// two different `civics_test_versions` rows, and the only thing that differs
// between the two test bodies is which row a fresh learner's filing date
// resolves to.

interface InterviewVersionCase {
  label: string;
  /** `undefined` uses `seedOnboarding`'s own pre-cutoff default. A string overrides it via `PUT /api/journey/profile`. */
  filingDateOverride?: string;
  /** The known-good numbers as of this writing (`mock-interview.md` §4) — a documentation table, not the source of truth the assertions below read from. */
  expectedThreshold: number;
  expectedPlanned: number;
}

const VERSION_CASES: InterviewVersionCase[] = [
  {
    label: '2008 civics bank (pre-cutoff filing date)',
    expectedThreshold: 6,
    expectedPlanned: 10,
  },
  {
    label: '2025 civics bank (post-cutoff filing date)',
    filingDateOverride: '2026-01-15',
    expectedThreshold: 12,
    expectedPlanned: 20,
  },
];

for (const versionCase of VERSION_CASES) {
  test.describe(`Mock interview civics section — ${versionCase.label} (issue #151), epic #57 (E8)`, () => {
    test('answering every civics question correctly stops the section early at exactly the row\'s own threshold, and the debrief and readiness both show it', async ({
      page,
    }) => {
      // A real UI-plus-SSE round trip per turn (smalltalk + n400 + up to 20
      // civics questions for the 2025 case), not the pure `page.request` loop
      // `readiness.spec.ts` drives at similar scale — the default 30s test
      // timeout is comfortable for that, not for this.
      test.setTimeout(120_000);

      const email = testEmail(
        versionCase.filingDateOverride ? 'v2025' : 'v2008',
      );
      const { accessToken } = await seedOnboardingAndSettle(page, {
        email,
        onboarding: 'full',
      });
      const headers = { Authorization: `Bearer ${accessToken}` };

      if (versionCase.filingDateOverride) {
        await setFilingDate(page, headers, versionCase.filingDateOverride);
      }
      const resolvedVersionCode = await fetchResolvedTestVersionCode(
        page,
        headers,
      );

      // ---------------------------------------------------------------------
      // BASELINE READINESS, before the interview exists at all. A fresh
      // learner with zero attempts scores EXACTLY 10 regardless of which
      // civics bank they resolved to (`readiness.spec.ts`'s own ground truth:
      // coverage's numerator is 0 regardless of the denominator, and
      // `remediation` gives full credit for nothing to remediate — the only
      // nonzero term is `0.10 * 1.0 = 10`). `capReason` is `'typed_only'`:
      // zero spoken and zero interview evidence.
      // ---------------------------------------------------------------------
      const baseline = await fetchReadiness(page, headers);
      expect(baseline.score, 'fresh learner baseline score').toBe(10);
      expect(baseline.capReason).toBe('typed_only');

      // ---------------------------------------------------------------------
      // START, THROUGH THE UI — the Practice page band, not Home's Next-up
      // card. See this file's header for why.
      // ---------------------------------------------------------------------
      const interviewId = await startInterviewFromPracticePage(page);

      // The interview was created against the profile's OWN resolved version
      // — never a client-supplied one (`create-interview.dto.ts`'s compile-time
      // proof that no such field exists). Cross-checked against the profile
      // read moments ago, not against a hardcoded literal.
      const created = await fetchInterviewDetail(page, headers, interviewId);
      expect(created.interview.testVersionCode).toBe(resolvedVersionCode);
      expect(created.interview.transcriptRetained).toBe(false);

      // ---------------------------------------------------------------------
      // DRIVE THE WHOLE INTERVIEW, answering every civics question correctly.
      // ---------------------------------------------------------------------
      await driveThroughInterview(page, headers, interviewId);

      await page.getByRole('button', { name: 'Finish and see how it went' }).click();
      await expect(page).toHaveURL(
        new RegExp(`/practice/interviews/${interviewId}/debrief$`),
      );
      await expect(
        page.getByRole('heading', { level: 1, name: 'Interview debrief' }),
      ).toBeVisible();

      const debrief = await fetchDebrief(page, headers, interviewId);

      // -----------------------------------------------------------------
      // THE PASS RULE IS A ROW: cross-checked against this file's own
      // documentation table (confirms the right version's content is
      // seeded), and then DERIVED — the observed stop is read against the
      // row's own numbers from the SAME response, never a hardcoded
      // per-case magic number. See this file's header.
      // -----------------------------------------------------------------
      expect(
        debrief.civics.threshold,
        `${versionCase.label}: pass threshold`,
      ).toBe(versionCase.expectedThreshold);
      expect(
        debrief.civics.planned,
        `${versionCase.label}: planned question count`,
      ).toBe(versionCase.expectedPlanned);

      expect(debrief.civics.stopReason).toBe('threshold_reached');
      expect(debrief.civics.passed).toBe(true);
      expect(debrief.civics.stoppedEarly).toBe(true);
      // DERIVED, not restated: every answer was correct, so the early stop
      // fires exactly when `correct` reaches `threshold` — proving the
      // relationship the row defines, rather than asserting a second copy
      // of the number.
      expect(debrief.civics.correct).toBe(debrief.civics.threshold);
      expect(debrief.civics.asked).toBe(debrief.civics.threshold);
      expect(debrief.civics.asked).toBeLessThan(debrief.civics.planned);

      // -----------------------------------------------------------------
      // PER-QUESTION RESULTS — this is how this spec verifies the
      // `practice_attempts` rows this interview wrote (`source:
      // 'mock_interview'`) THROUGH THE API rather than by reading the
      // database: `debrief.questions` is built by
      // `InterviewsService.loadDebriefAttempts`
      // (`apps/api/src/interviews/interviews.service.ts`), a direct query of
      // `practiceAttempt.findMany({ where: { mockInterviewId, userId } })` —
      // exactly the rows the issue asks this spec to verify, exposed through
      // the one API surface that serves them. There is no OTHER endpoint
      // that lists an interview's `practice_attempts` rows directly (no
      // `GET /api/practice/attempts` of any kind exists in this API) — this
      // is the only door.
      // -----------------------------------------------------------------
      expect(debrief.questions.length).toBe(debrief.civics.asked);
      for (const question of debrief.questions) {
        expect(question.outcome, `question ${question.number}`).toBe('correct');
        expect(question.acceptedAnswers.length).toBeGreaterThan(0);
      }
      // Nothing was missed, so the deterministic focus-area aggregation
      // (`debriefCopy.ts`/`debrief.ts`'s own `focusAreasFrom`) is empty.
      expect(debrief.focusAreas).toEqual([]);

      // -----------------------------------------------------------------
      // ALL SIX PHASES, HONESTLY REPORTED (§2.4) — civics `completed` even
      // though it stopped early; reading/writing `skipped`, never omitted.
      // -----------------------------------------------------------------
      const phaseByKind = new Map(debrief.phases.map((p) => [p.kind, p.status]));
      expect(phaseByKind.get('smalltalk')).toBe('completed');
      expect(phaseByKind.get('n400')).toBe('completed');
      expect(phaseByKind.get('civics')).toBe('completed');
      expect(phaseByKind.get('reading')).toBe('skipped');
      expect(phaseByKind.get('writing')).toBe('skipped');
      expect(phaseByKind.get('closing')).toBe('completed');

      // -----------------------------------------------------------------
      // READINESS: the interview component moves off zero, and the cap
      // lifts — the exact ground-truth fact this spec was handed.
      // -----------------------------------------------------------------
      expect(debrief.readiness.interviewComponent.value).toBe(0.5);
      expect(debrief.readiness.interviewComponent.evidenceCount).toBe(1);
      expect(debrief.readiness.capReason).toBeNull();
      expect(debrief.readiness.capMessage).toBeNull();
      expect(debrief.readiness.previousScore).toBe(baseline.score);
      expect(debrief.readiness.delta).toBe(
        debrief.readiness.score - baseline.score,
      );
      expect(
        debrief.readiness.score,
        'the score must have actually moved, not merely the component',
      ).toBeGreaterThan(baseline.score);

      // -----------------------------------------------------------------
      // THE SAME FACTS, ON THE REAL DEBRIEF SCREEN — `CivicsResultPanel`,
      // `DebriefQuestion`, `PhaseCoverage` and `ReadinessMovement`, every
      // string built from THIS interview's own numbers via the copy
      // functions copied verbatim above.
      // -----------------------------------------------------------------
      const civicsRegion = page.getByRole('region', {
        name: 'How the civics section went',
      });
      await expect(civicsRegion).toBeVisible();
      await expect(
        civicsRegion.getByText(civicsVerdictLabel(true), { exact: true }),
      ).toBeVisible();
      await expect(
        civicsRegion.getByText(civicsCountsSentence(debrief.civics)),
      ).toBeVisible();
      await expect(
        civicsRegion.getByText(thresholdReachedSentence(debrief.civics)),
      ).toBeVisible();

      // A passed section renders no "missed questions" intro and no "Where
      // to focus" band at all (`debriefCopy.ts`'s `missedQuestionsIntro`/
      // `focusAreasIntro`, both null when there is nothing to report).
      await expect(
        page.getByRole('heading', { level: 2, name: 'Where to focus' }),
      ).toHaveCount(0);

      const questionsRegion = page.getByRole('region', {
        name: 'Question by question',
      });
      await expect(questionsRegion).toBeVisible();
      // Direct children of the OUTER `<ul>` only — `getByRole('listitem')`
      // here would also match the NESTED `<ul>` `DebriefQuestion.tsx` renders
      // per question when it has more than one accepted answer ("Any one of
      // these is accepted", lines ~124-129 of that file: a
      // `Stack component="ul"` of `Typography component="li"` INSIDE each
      // outer `<li>`), so an unscoped `listitem` query counts question items
      // and accepted-answer items together — a count that varies with how
      // many of the selected questions happen to have multiple accepted
      // answers, not with how many questions there are. The outer `<ul>`
      // (`InterviewDebriefPage.tsx`'s own `Stack component="ul"`, line ~318)
      // is a direct child of this region, and each `DebriefQuestion` is a
      // direct child of THAT `<ul>` — so `'> ul > li'` reaches exactly the
      // question items and nothing nested inside any one of them.
      const questionItems = questionsRegion.locator('> ul > li');
      await expect(questionItems).toHaveCount(debrief.questions.length);
      // Indexed, NOT text-filtered by "Question N": `DebriefQuestion.tsx`
      // renders that as an exact substring ("Question 1", "Question 10",
      // "Question 11", ...), and run two's up-to-12 questions means a
      // substring filter on "Question 1" would match four different items.
      // `debrief.questions` is already in the exact order
      // `InterviewsService.loadDebriefAttempts` queried them in
      // (`orderBy: [{ answeredAt: 'asc' }, { id: 'asc' }]`) — the same order
      // `InterviewDebriefPage.tsx` maps them into the `<ul>` — so index and
      // render position agree by construction.
      for (const [index, question] of debrief.questions.entries()) {
        const item = questionItems.nth(index);
        await expect(
          item.getByText(`Question ${question.number}`, { exact: true }),
        ).toBeVisible();
        await expect(item.getByText('Correct', { exact: true })).toBeVisible();
        await expect(item.getByText(question.prompt)).toBeVisible();
      }

      const phasesRegion = page.getByRole('region', {
        name: 'What this rehearsal covered',
      });
      await expect(phasesRegion).toBeVisible();
      await expect(
        phasesRegion.getByText('Reading test', { exact: true }),
      ).toBeVisible();
      await expect(
        phasesRegion.getByText('Writing test', { exact: true }),
      ).toBeVisible();
      await expect(
        phasesRegion.getByText('Not part of this rehearsal yet', { exact: true }).first(),
      ).toBeVisible();

      const readinessRegion = page.getByRole('region', { name: 'Readiness' });
      await expect(readinessRegion).toBeVisible();
      await expect(
        readinessRegion.getByText('Mock interviews passed: 1', { exact: true }),
      ).toBeVisible();
      await expect(
        readinessRegion.getByText('Interview component: 0.5 of 1', {
          exact: true,
        }),
      ).toBeVisible();
      // The cap lifted — no cap message anywhere on this screen any more.
      await expect(page.getByText(CAP_TITLE, { exact: true })).toHaveCount(0);
      await expect(page.getByText(CAP_REASON, { exact: true })).toHaveCount(0);
    });
  });
}

// =============================================================================
// RUN THREE — the two negative properties
// =============================================================================
//
// 1. No verdict or feedback is visible ANYWHERE on `/practice/interviews/:id`
//    at any point before completion — checked after every single exchange,
//    on a mix of a correct and an incorrect civics answer (so the property is
//    exercised on both grading outcomes, not only the all-correct path runs
//    one and two already take), and again on the finished-but-not-yet-clicked
//    "awaiting completion" screen. Then, as a contrast check that the
//    assertion was actually looking at something real, the SAME words are
//    confirmed present on the debrief the moment it renders.
// 2. After a retention-off run (the default — never touched here either),
//    no learner answer text is retrievable through the API. §8.2's own
//    table is explicit that `mock_interview_turns.text` is written EMPTY for
//    an applicant turn with retention off, so this is checked exactly there:
//    `GET /api/interviews/:id`'s `turns` array, every `role: 'applicant'`
//    row.
//
//    `practice_attempts.response_text` is the other column §8.2 names as
//    withheld, and this spec could NOT independently confirm it through the
//    API: no field of `InterviewDebriefQuestion` or any other response this
//    API returns carries a raw `responseText` at all (the debrief's own
//    `acceptedAnswers` come from the frozen `answer_snapshot`, never from
//    what the learner typed) — there is simply no door through which a
//    learner's own response text is ever served back, retained or not. That
//    is a STRONGER form of "not retrievable" than a value that comes back
//    null, but it does mean this spec cannot show a null specifically
//    labelled `response_text` the way the ground truth was verified against
//    the database directly. See the report handed back with this file.
// =============================================================================

test.describe('Mock interview — no verdict before completion, and no answer text after retention-off (issue #151), epic #57 (E8)', () => {
  test('the live screen never shows a verdict, and the API never returns the learner\'s own words', async ({
    page,
  }) => {
    // See the identical note on run one/two's test: a full interview driven
    // through the real UI and a real SSE round trip per turn outgrows the
    // default 30s test timeout.
    test.setTimeout(120_000);

    const email = testEmail('negative-properties');
    const { accessToken } = await seedOnboardingAndSettle(page, {
      email,
      onboarding: 'full',
    });
    const headers = { Authorization: `Bearer ${accessToken}` };

    const interviewId = await startInterviewFromPracticePage(page);

    const created = await fetchInterviewDetail(page, headers, interviewId);
    // The default this run relies on for property 2 — never touched on the
    // start screen (`startInterviewFromPracticePage` already asserts the
    // switch is unchecked there).
    expect(created.interview.transcriptRetained).toBe(false);

    // ---------------------------------------------------------------------
    // PROPERTY 1, exercised on a mix of outcomes: the FIRST civics question
    // is answered deliberately wrong, and the `assertNoVerdict: true` loop
    // checks for the practice vocabulary after every single exchange —
    // smalltalk, all three n400 prompts, every civics question (both the
    // wrong first one and the correct ones after it), and the final
    // "awaiting completion" screen.
    // ---------------------------------------------------------------------
    await driveThroughInterview(page, headers, interviewId, {
      assertNoVerdict: true,
      firstCivicsAnswerOverride:
        'This response is deliberately wrong and matches no accepted answer.',
    });

    // Still true on the "ready to finish" screen itself, before the button
    // is pressed — §10 holds up to and including this moment.
    await assertNoVerdictOnScreen(page);
    await expect(
      page.getByText(
        'That’s the end of the interview. Finish it to see how it ' +
          'went — question by question, with the accepted answers.',
      ),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Finish and see how it went' }).click();
    await expect(page).toHaveURL(
      new RegExp(`/practice/interviews/${interviewId}/debrief$`),
    );
    await expect(
      page.getByRole('heading', { level: 1, name: 'Interview debrief' }),
    ).toBeVisible();

    // CONTRAST CHECK: the same word the interview screen never showed is now
    // on screen at least once — the deliberately-wrong first answer's own
    // chip — proving `assertNoVerdictOnScreen` was checking a locator that
    // really does match real content, not one that was silently broken.
    await expect(page.getByText('Not a match', { exact: true }).first()).toBeVisible();
    // And at least one correct verdict too, from every question after it.
    await expect(page.getByText('Correct', { exact: true }).first()).toBeVisible();

    const debrief = await fetchDebrief(page, headers, interviewId);
    expect(debrief.civics.correct).toBeGreaterThan(0);
    expect(
      debrief.questions.some((q) => q.outcome !== 'correct'),
      'at least the deliberately-wrong first answer must be recorded as a miss',
    ).toBe(true);
    // The miss produced at least one focus area — the deterministic
    // aggregation this spec's other two runs never exercise, since those
    // never miss a question.
    expect(debrief.focusAreas.length).toBeGreaterThan(0);

    // ---------------------------------------------------------------------
    // PROPERTY 2: no learner answer text is retrievable through the API.
    // ---------------------------------------------------------------------
    const detail = await fetchInterviewDetail(page, headers, interviewId);
    expect(detail.interview.transcriptRetained).toBe(false);
    expect(detail.interview.status).toBe('completed');

    const applicantTurns = detail.turns.filter((t) => t.role === 'applicant');
    expect(
      applicantTurns.length,
      'this interview must have recorded at least one applicant turn to make the property meaningful',
    ).toBeGreaterThan(0);
    for (const turn of applicantTurns) {
      expect(
        turn.text,
        `applicant turn ${turn.turnIndex} must come back empty with retention off`,
      ).toBe('');
    }

    // Officer turns are UNAFFECTED — they are product copy plus public
    // database question text, never anything the learner produced (§8.2).
    const officerTurns = detail.turns.filter((t) => t.role === 'officer');
    expect(officerTurns.some((t) => t.text.length > 0)).toBe(true);
  });
});

// =============================================================================
// UNTOUCHED FILES
// =============================================================================
//
// This spec adds exactly one new file. `auth.spec.ts` and `habit.spec.ts` are
// not imported, not edited, and carry no dependency on anything declared
// above.
