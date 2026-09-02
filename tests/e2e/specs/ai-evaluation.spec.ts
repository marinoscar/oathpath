import { randomUUID } from 'node:crypto';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { seedOnboarding } from '../helpers/auth.helper';
import {
  fetchAcceptedAnswer,
  fetchNextQuestionId,
} from '../helpers/practice-questions';

// =============================================================================
// ai-evaluation.spec.ts — issue #131, epic #53 (E4)
// =============================================================================
//
// Everything `practice-session.spec.ts` (#84) deliberately left untouched: a
// grading call actually reaching a model, the tutor's streamed explanation,
// the usage it records, and what a learner sees when none of that is
// configured. That earlier spec's own header explains at length why it never
// needed AI turned on; this one is the spec that turns it on, on purpose, and
// is why the two do not conflict — see "GLOBAL STATE" below.
//
// -----------------------------------------------------------------------------
// ENVIRONMENT THIS SPEC REQUIRES, AND WHY IT CANNOT BE SET FROM HERE
// -----------------------------------------------------------------------------
//
// The task that produced this file is explicit that `tests/e2e/**` is the only
// directory this change may touch, so the one thing this file cannot do is
// make itself runnable: an operator must set, on the API service (e.g.
// `infra/compose/.env`, or the API container's environment directly),
//
//   AI_PROVIDER_FAKE=true
//
// with `NODE_ENV` anything other than `production` (true of every dev/test
// compose profile already). `AiModule.resolveAiProvider` is the ONLY place
// that flag is read (see `apps/api/src/ai/ai.module.ts`): with it set, the
// token every consumer injects as `OpenAiProvider` resolves to
// `FakeAiProvider` instead — a real provider that grades deterministically
// from a hand-written table and never leaves the process, so this spec makes
// no outbound network call and needs no OpenAI account. Without the flag, an
// admin's server key is unreachable in this environment and every assertion
// below that depends on a real grading verdict fails for an environment
// reason, not a product one.
//
// This is an ADDITIONAL requirement on top of whatever already makes
// `practice-session.spec.ts` runnable (civics content only loads with
// `CIVICS_ALLOW_UNVERIFIED_CONTENT=true` per `ROADMAP.md`'s own epic-#20
// footnote) — that one predates this file and is not repeated here.
//
// -----------------------------------------------------------------------------
// GLOBAL STATE: THIS SPEC IS THE FIRST TO TOUCH `/api/ai-settings`, AND WHY
// THAT IS SAFE
// -----------------------------------------------------------------------------
//
// AI configuration is ONE row (`system_settings.key = 'ai'`), shared by every
// user and every spec in this suite — there is no per-test tenant to isolate
// it in. Two things make writing to it here safe rather than a source of
// suite-wide flakiness:
//
//   1. **Nothing else in `tests/e2e/specs/` reads it.** `practice-session.spec.ts`'s
//      own header already argues that its one attempt eligible for escalation
//      (the cold wrong submit) resolves however AI happens to be configured
//      AT THAT MOMENT with no change to what it asserts: the fake's grader can
//      only ever return `correct` or `incorrect` for that response (never
//      `partial` — see `fake-ai.provider.ts`'s own header), so the tally that
//      spec checks is unaffected whether that one attempt ends up
//      `gradingMethod: 'exact'` or `'ai'`. `civics-learn.spec.ts` and
//      `journey-shell.spec.ts` do not mention AI at all. `auth.spec.ts` does
//      not touch practice.
//   2. **CI runs this suite with `workers: 1`** (`playwright.config.ts`), so in
//      the environment this file's correctness actually has to hold, every
//      spec file runs to completion before the next one starts — there is no
//      concurrent request to race against. Local, parallel, multi-worker runs
//      could in principle interleave a write from this spec with a read from
//      another, and the note above is why that would still not change any
//      other spec's assertions.
//
// This spec also does not restore AI to a disabled state when it finishes —
// see "PHASE 0" below for why the ordering inside this file makes that
// unnecessary, and point 1 above for why a later spec being unaffected by
// AI being left on does not depend on it.
//
// -----------------------------------------------------------------------------
// WHY AN ADMIN LOGIN GOES THROUGH THE BARE `request` FIXTURE, NEVER `page`
// -----------------------------------------------------------------------------
//
// `page.request` shares the BROWSER'S cookie jar (see `seed-onboarding.ts`'s
// own header on why that is usually exactly what a spec wants). The admin in
// this file never needs a browser at all — every admin action is one API call
// — and logging in as admin through `page.request` would overwrite the
// learner's `refresh_token` cookie with the admin's, which is a foot-gun this
// spec has no reason to accept. Playwright's top-level `request` fixture is a
// SEPARATE `APIRequestContext` with its own, isolated cookie jar (same
// `baseURL`), so the admin's session and the learner's browsing session never
// touch.
//
// -----------------------------------------------------------------------------
// THE PARAPHRASE, AND WHY THIS ONE QUESTION
// -----------------------------------------------------------------------------
//
// `FakeAiProvider`'s `PARAPHRASES` table (`apps/api/src/ai/providers/fake-ai.provider.ts`)
// is a hand-written fixture standing in for a model's judgement, keyed by
// normalised ACCEPTED-ANSWER text. Its `'congress'` entry —
// `['the one that makes the laws', 'makes the laws', 'the law making body', 'the legislature']`
// — is the one entry this spec can reach deterministically: `civics-2008.json`
// (the content this branch's civics bank actually loads, since
// `ORIENTATION_PROFILE`'s filing date resolves every learner here to `v2008`)
// has exactly one question whose FIRST accepted answer is the single word
// "Congress" — question 16, "Who makes federal laws?", `dynamicScope: 'none'`.
// `'none'` matters as much as the word match: this is a fixed, undated fact
// (unlike a `national`/`state` officeholder question, which `ROADMAP.md`'s own
// epic-#20 footnote says the seeded content ships as an unverified
// `[DRAFT PLACEHOLDER]` for), so there is nothing time- or state-dependent to
// get wrong here.
//
// The paraphrase submitted is `PARAPHRASES.get('congress')[0]` VERBATIM: "the
// one that makes the laws". That is deliberately a real semantic paraphrase
// the task asks this spec to use `fake-ai.provider.ts`'s own table for, not
// the content-agnostic "defeat one normalisation rule" trick
// `practice-session.spec.ts` uses for its own case 2 — this spec needs the
// grader to actually be consulted and to actually credit a meaning-based
// match, which a punctuation tweak cannot exercise. Two things confirm the
// deterministic matcher (`matchAnswer`) still misses it, so rung 2 is actually
// reached rather than short-circuited by rung 1: the phrase shares no word
// over three characters with "Congress" (`answer-matching.ts` compares
// normalised STRINGS, not meanings), and — separately — the fake's own
// `judge()` checks "does the response contain this answer's meaningful words"
// BEFORE it checks the paraphrase table, and that check also fails for the
// same reason. Only the explicit table entry can carry this one home, which is
// exactly the case the task asks for.
//
// See `PracticePage.tsx`'s and `practice.service.ts`'s own selection-ordering
// notes for why fetching this specific question by its known, PUBLIC prompt
// text (rather than trying to land it inside a shuffled Quick 5) is the only
// deterministic way to reach it — `recordAttempt` validates a submitted
// `questionId` only against the session's test version (and category, for a
// `category` session), never against whatever the UI's own `nextQuestion`
// happened to draw, so a direct API submission into a `quick` session is a
// real, fully-graded attempt and not a bypass of anything the endpoint
// enforces.
// =============================================================================

/** A fresh, obviously-fake test email, namespaced per learner role in this spec. */
function testEmail(label: string): string {
  return `ai-evaluation-${label}-${randomUUID()}@test.local`;
}

/** A key that is obviously fake and obviously not a real OpenAI secret. */
const FAKE_SERVER_KEY = 'sk-e2e-fake-server-key-not-real';

/** The two roles this epic wires. See `ai-model-roles.ts`. */
const TUTOR_MODEL = 'gpt-5.4';
const GRADER_MODEL = 'gpt-5.4-mini';

/** Question 16 of `civics-2008.json`. See the file header. */
const TARGET_PROMPT = 'Who makes federal laws?';
const TARGET_ACCEPTED_ANSWER = 'Congress';
/** `PARAPHRASES.get('congress')[0]`, verbatim — see the file header. */
const TARGET_PARAPHRASE = 'the one that makes the laws';
/** `FEEDBACK['correct:expression']`, verbatim (`fake-ai.provider.ts`). */
const EXPECTED_COACHING =
  'Yes, that is the right idea — your meaning came through clearly.';

/**
 * The six `PracticeFailureCause` values, verbatim from `grading.ts` /
 * `failureCause.ts`. Used only to assert NONE of them ever appears as raw text
 * anywhere on the summary screen — see "NO RAW ENUM VALUE" below.
 */
const RAW_FAILURE_CAUSES = [
  'not_known',
  'not_recalled',
  'expression',
  'misheard',
  'nervous',
  'unknown',
] as const;

interface TestLoginResponse {
  accessToken: string;
}

/**
 * Log in as a fresh admin, through the API only — no browser page is ever
 * involved. See the file header for why this is the bare `request` fixture
 * and not `page.request`.
 */
async function loginAsAdminApi(
  request: APIRequestContext,
): Promise<TestLoginResponse> {
  const email = testEmail('admin');
  const response = await request.post('/api/auth/test/login', {
    data: { email, role: 'admin' },
    maxRedirects: 0,
    failOnStatusCode: false,
  });

  if (response.status() !== 302) {
    const body = await response.text().catch(() => '<unreadable body>');
    throw new Error(
      'loginAsAdminApi: POST /api/auth/test/login did not 302-redirect as ' +
        `expected — got HTTP ${response.status()}. Response body: ${body}`,
    );
  }

  const location = response.headers()['location'];
  if (!location) {
    throw new Error(
      'loginAsAdminApi: POST /api/auth/test/login returned a 302 with no ' +
        'Location header — cannot recover the access token.',
    );
  }

  const callbackUrl = new URL(location, response.url());
  const accessToken = callbackUrl.searchParams.get('token');
  if (!accessToken) {
    throw new Error(
      'loginAsAdminApi: the /auth/callback redirect is missing "token" — ' +
        `got: ${callbackUrl.toString()}`,
    );
  }

  return { accessToken };
}

/**
 * `PUT /api/ai-settings`, as the given admin bearer token.
 *
 * A REPLACE, not a merge — `AiSettingsController`'s own Swagger description
 * says so, and `AiSettingsService.update` runs `aiSettingsSchema.parse` over
 * exactly what is passed here. So every call below states the WHOLE
 * configuration it wants, rather than assuming anything survives from an
 * earlier write.
 */
async function putAiSettings(
  request: APIRequestContext,
  accessToken: string,
  body: {
    provider: 'openai' | null;
    enabled: boolean;
    apiKey?: string;
    models?: Record<string, string>;
  },
): Promise<void> {
  const response = await request.put('/api/ai-settings', {
    headers: { Authorization: `Bearer ${accessToken}` },
    data: body,
    failOnStatusCode: false,
  });

  if (!response.ok()) {
    const responseBody = await response.text().catch(() => '<unreadable body>');
    throw new Error(
      `putAiSettings: PUT /api/ai-settings failed — HTTP ${response.status()}. ` +
        `Body sent: ${JSON.stringify(body)}. Response: ${responseBody}`,
    );
  }
}

interface QuestionSummary {
  id: string;
  prompt: string;
}

interface QuestionListResponse {
  data: { items: QuestionSummary[]; total: number; totalPages: number };
}

/**
 * The id of question 16 ("Who makes federal laws?"), read the PUBLIC way —
 * see `fetchAcceptedAnswer` in `../helpers/practice-questions` for the same
 * argument applied to a question this spec does not already know the id of.
 *
 * `pageSize=100` in one call because `civics-2008.json` — the bank every
 * learner in this spec resolves to (see the file header) — has exactly 100
 * questions, the query DTO's own maximum page size.
 */
async function findFederalLawsQuestionId(
  page: Page,
  authHeaders: Record<string, string>,
): Promise<string> {
  const response = await page.request.get(
    '/api/civics/questions?pageSize=100',
    { headers: authHeaders },
  );
  expect(response.ok(), 'GET /api/civics/questions').toBe(true);
  const body = (await response.json()) as QuestionListResponse;

  const match = body.data.items.find((item) => item.prompt === TARGET_PROMPT);
  if (!match) {
    throw new Error(
      `findFederalLawsQuestionId: no question with prompt "${TARGET_PROMPT}" ` +
        `among ${body.data.items.length} of ${body.data.total} questions returned. ` +
        'Has the civics-2008 content bank changed? See this file\'s header for ' +
        'why this specific, public, undated fact is what the paraphrase case ' +
        'is built on.',
    );
  }

  return match.id;
}

interface QuestionDetailResponse {
  data: {
    answerResolution: 'resolved' | 'state_required';
    answers: { text: string }[];
  };
}

/**
 * Defensive check that question 16 still accepts exactly what this spec
 * assumes — fail loudly here rather than have a wrong-but-passing assertion
 * later blame the fake's grader for a content change.
 */
async function assertTargetAnswerUnchanged(
  page: Page,
  authHeaders: Record<string, string>,
  questionId: string,
): Promise<void> {
  const response = await page.request.get(
    `/api/civics/questions/${questionId}`,
    { headers: authHeaders },
  );
  expect(response.ok(), 'GET /api/civics/questions/:id').toBe(true);
  const body = (await response.json()) as QuestionDetailResponse;

  const firstAnswer = body.data.answers[0]?.text;
  if (body.data.answerResolution !== 'resolved' || firstAnswer !== TARGET_ACCEPTED_ANSWER) {
    throw new Error(
      `assertTargetAnswerUnchanged: expected question ${questionId}'s first ` +
        `accepted answer to be "${TARGET_ACCEPTED_ANSWER}" (resolved), got ` +
        `resolution "${body.data.answerResolution}" and answer ${JSON.stringify(firstAnswer)}.`,
    );
  }
}

interface UsageResponse {
  data: {
    calls: number;
    byRole: { key: string; calls: number; totalTokens: number }[];
  };
}

test.describe('AI evaluation (issue #131), epic #53 (E4)', () => {
  test('the grading ladder, a streamed explanation, recorded usage, and graceful degradation', async ({
    page,
    request,
  }) => {
    const admin = await loginAsAdminApi(request);

    // =========================================================================
    // PHASE 0 — AI OFF, explicitly. Practice still completes; the shared
    // "not ready" component is what learners see, never a broken loop.
    // =========================================================================
    //
    // Set BEFORE any learner in this test logs in, and BEFORE the "ready"
    // phase below turns AI on — an explicit baseline rather than trusting
    // whatever a previous run of this same spec left behind (see the file
    // header on why this row is global and this spec does not restore it
    // afterwards: putting the degraded phase FIRST is what makes that safe —
    // nothing later in this file needs AI to be off again).
    await putAiSettings(request, admin.accessToken, {
      provider: null,
      enabled: false,
    });

    const degradedLearnerEmail = testEmail('degraded');
    await seedOnboarding(page, {
      email: degradedLearnerEmail,
      onboarding: 'full',
    });
    // `seedOnboarding` does not itself wait for '/' — see its own header.
    await page.waitForURL('/', { timeout: 10000 });

    await page.goto('/practice');
    await page.getByRole('button', { name: 'Start a Quick 5' }).click();
    await expect(page).toHaveURL(/\/practice\/sessions\/[0-9a-f-]{36}$/);

    const explainButton = page.getByRole('button', {
      name: 'Why is that the answer?',
    });

    for (let position = 1; position <= 5; position += 1) {
      await expect(page.getByText(`Question ${position} of 5`)).toBeVisible();

      // A skip is the fastest way to a graded (well, skipped) attempt on every
      // question — what happened to the answer is not what this phase is
      // about. `ExplainPanel` mounts on ANY recorded attempt, skip included.
      await page.getByRole('button', { name: 'Skip' }).click();
      await expect(page.getByText('Skipped', { exact: true })).toBeVisible();

      if (position === 1) {
        // -------------------------------------------------------------------
        // THE DEGRADED STATE ITSELF. `AiDispatchService.resolve` refuses on
        // the master switch before it ever looks at a user's key
        // (`ai-dispatch.service.ts` line order: `ai_disabled` first) — so this
        // is true for EVERY learner, key or no key, which is the whole point
        // of `AiNotReady`'s "this is not a problem with your key" sentence.
        // -------------------------------------------------------------------
        await expect(explainButton).toBeVisible();
        await expect(explainButton).toBeDisabled();

        // `AiNotReady`'s FEATURE_NAME is a constant inside `ExplainPanel.tsx`
        // ("An explanation"), independent of the `label` prop the page passes
        // it — see that file. So the heading reads this regardless of the
        // button's own visible text above.
        await expect(
          page.getByText('An explanation is not available yet'),
        ).toBeVisible();
        // THE ONE SENTENCE `AiNotReady` EXISTS FOR (`components/ai/AiNotReady.tsx`).
        await expect(
          page.getByText('This is not a problem with your key.'),
        ).toBeVisible();
        // Never rendered to a non-admin learner (`isAdmin` gate in `AiNotReady`).
        await expect(
          page.getByText('Open AI settings'),
        ).toHaveCount(0);
      }

      const isLastQuestion = position === 5;
      await page
        .getByRole('button', {
          name: isLastQuestion ? 'See your summary' : 'Next question',
        })
        .click();
    }

    // THE PRACTICE LOOP STILL COMPLETES. Nothing about grading, skipping, or
    // finishing a session depends on AI being configured at all.
    await expect(
      page.getByRole('heading', { level: 1, name: 'Practice summary' }),
    ).toBeVisible();

    // =========================================================================
    // PHASE 1 — an administrator finishes AI setup, for real, through the
    // real endpoint. `AI_PROVIDER_FAKE=true` (see the file header) is what
    // makes what happens next a real `FakeAiProvider` call rather than an
    // attempt to reach the real OpenAI with a key that is obviously not one.
    // =========================================================================
    //
    // `enabled: true` alone is not enough — `AiDispatchService.resolve` checks
    // it, then whether the provider can serve the role's capability family,
    // then whether a model is bound to it (`role_unbound`), before it ever
    // reaches for the CALLER's own key. Both wired roles need a binding.
    await putAiSettings(request, admin.accessToken, {
      provider: 'openai',
      enabled: true,
      apiKey: FAKE_SERVER_KEY,
      models: { tutor: TUTOR_MODEL, grader: GRADER_MODEL },
    });

    // =========================================================================
    // PHASE 2 — a fresh learner (a fresh `page.goto` inside `seedOnboarding`,
    // so `AiStatusProvider` fetches `/api/ai/status` for the first time AFTER
    // the write above, never a stale cached answer from before AI was ready —
    // see `AiStatusContext.tsx`'s own "fetched once, not per render" header).
    // =========================================================================
    const readyLearnerEmail = testEmail('ready');
    const { accessToken: learnerToken } = await seedOnboarding(page, {
      email: readyLearnerEmail,
      onboarding: 'full',
    });
    await page.waitForURL('/', { timeout: 10000 });
    const authHeaders = { Authorization: `Bearer ${learnerToken}` };

    await page.goto('/practice');
    await page.getByRole('button', { name: 'Start a Quick 5' }).click();
    await expect(page).toHaveURL(/\/practice\/sessions\/[0-9a-f-]{36}$/);
    const rungSessionId = page.url().split('/').pop();
    if (!rungSessionId) throw new Error('Could not read the session id from the URL.');

    // -------------------------------------------------------------------------
    // RUNG 1 — an EXACT match makes NO AI call. Asserted on the rendered
    // provenance, exactly as the task asks: `AiFeedbackCard` renders
    // `gradingMethodNote('exact')` as `null` (see `outcome.ts`), so
    // "Graded by the assistant." must be absent, and — because `gradingMethod`
    // is `'exact'` here — `attempt.aiFeedback` is null so there is no coaching
    // sentence to render either.
    // -------------------------------------------------------------------------
    const rungQuestionId = await fetchNextQuestionId(
      page,
      authHeaders,
      rungSessionId,
    );
    const rungAccepted = await fetchAcceptedAnswer(
      page,
      authHeaders,
      rungQuestionId,
    );

    await page.getByLabel('Your answer').fill(rungAccepted);
    await page.getByRole('button', { name: 'Submit' }).click();

    await expect(page.getByText('Correct', { exact: true })).toBeVisible();
    await expect(
      page.getByText('That matches an accepted answer.'),
    ).toBeVisible();
    // NO AI CALL: the provenance note only ever appears for `'self'` or
    // `'ai'` — never `'exact'`.
    await expect(page.getByText('Graded by the assistant.')).toHaveCount(0);
    await expect(
      page.getByText('You marked this one correct yourself.'),
    ).toHaveCount(0);

    // -------------------------------------------------------------------------
    // EXPLAIN — opened on this same, just-answered question. Asserted
    // INCREMENTALLY, by reading the actual `text/event-stream` body Playwright
    // captured for the request the click made — not by polling the DOM for a
    // flicker, which would only prove text eventually appeared. Counting real
    // `event: delta` frames is what the task asks for: "more than one chunk,
    // not merely that text eventually appeared".
    // -------------------------------------------------------------------------
    await expect(explainButton).toBeVisible();
    await expect(explainButton).toBeEnabled();

    const [explainResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().includes('/explain') &&
          response.request().method() === 'POST',
      ),
      explainButton.click(),
    ]);

    const sseBody = await explainResponse.text();
    const deltaFrameCount = (sseBody.match(/event:\s*delta/g) ?? []).length;
    expect(
      deltaFrameCount,
      `expected more than one "event: delta" frame in the SSE body, got ` +
        `${deltaFrameCount}. Raw body:\n${sseBody}`,
    ).toBeGreaterThan(1);
    expect(sseBody).toMatch(/event:\s*done/);

    // TERMINAL STATE, announced in its own region (`ExplainPanel.tsx`'s
    // `role="status"` caption, mounted once and only ever re-texted).
    await expect(page.getByText('Explanation finished.')).toBeVisible();
    // REAL CONTENT arrived, from the fake's own deterministic sentence
    // (`explanationFor` in `fake-ai.provider.ts`) — not a placeholder and not
    // an empty region that merely reported "finished".
    await expect(page.locator('[aria-label="Explanation"]')).toContainText(
      'This answer comes from the fake AI provider',
    );

    // =========================================================================
    // RUNG 2 — a paraphrase the deterministic matcher misses and the fake's
    // grader accepts. Submitted directly against the API for question 16 —
    // see the file header for why that is a real, fully-graded attempt and
    // not a bypass, and for why no shuffled Quick 5 could land this
    // deterministically otherwise. This intentionally abandons `rungSessionId`
    // (`PracticeService.createSession` marks any other `in_progress` session
    // abandoned) — every assertion this spec needs from it is already made.
    // =========================================================================
    const targetQuestionId = await findFederalLawsQuestionId(page, authHeaders);
    await assertTargetAnswerUnchanged(page, authHeaders, targetQuestionId);

    const createSessionResponse = await page.request.post(
      '/api/practice/sessions',
      {
        headers: authHeaders,
        data: { kind: 'quick', plannedCount: 1 },
      },
    );
    expect(createSessionResponse.ok(), 'POST /api/practice/sessions').toBe(true);
    const createSessionBody = (await createSessionResponse.json()) as {
      data: { session: { id: string } };
    };
    const paraphraseSessionId = createSessionBody.data.session.id;

    const attemptResponse = await page.request.post(
      `/api/practice/sessions/${paraphraseSessionId}/attempts`,
      {
        headers: authHeaders,
        data: { questionId: targetQuestionId, responseText: TARGET_PARAPHRASE },
      },
    );
    expect(
      attemptResponse.ok(),
      `POST .../attempts for the paraphrase — body: ${await attemptResponse
        .text()
        .catch(() => '<unreadable>')}`,
    ).toBe(true);
    const attemptBody = (await attemptResponse.json()) as {
      data: {
        attempt: {
          outcome: string;
          gradingMethod: string;
          aiFeedback: { feedback: string } | null;
        };
      };
    };
    // API-LEVEL confirmation before the UI-level one below: the deterministic
    // matcher missed (this would be `'exact'` had it matched) and the fake's
    // grader is what produced this verdict.
    expect(attemptBody.data.attempt.gradingMethod).toBe('ai');
    expect(attemptBody.data.attempt.outcome).toBe('correct');
    expect(attemptBody.data.attempt.aiFeedback?.feedback).toBe(EXPECTED_COACHING);

    const completeResponse = await page.request.post(
      `/api/practice/sessions/${paraphraseSessionId}/complete`,
      { headers: authHeaders },
    );
    expect(completeResponse.ok(), 'POST .../complete').toBe(true);

    // THE RENDERED PROVENANCE — the same `AiFeedbackCard` the live session
    // screen uses, this time via the summary's per-question review row
    // (`AttemptReview.tsx`), which is the only place a directly-submitted
    // attempt can be SEEN rather than merely asserted over JSON.
    await page.goto(`/practice/sessions/${paraphraseSessionId}/summary`);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Practice summary' }),
    ).toBeVisible();

    const reviewRow = page
      .getByRole('listitem')
      .filter({ hasText: TARGET_PROMPT });
    await expect(reviewRow).toHaveCount(1);

    await expect(reviewRow.getByText('Correct', { exact: true })).toBeVisible();
    await expect(reviewRow.getByText('Graded by the assistant.')).toBeVisible();
    // THE PLAIN-LANGUAGE EXPLANATION — the fake's own coaching sentence for
    // `correct:expression`. This is what a learner reads in place of the raw
    // enum value the server actually computed (see the check below).
    await expect(reviewRow.getByText(EXPECTED_COACHING)).toBeVisible();

    // NO RAW ENUM VALUE ANYWHERE ON THIS PAGE. This is not a redundant check
    // against the assertions above: `PracticeAttempt.aiFeedback.failureCause`
    // on the WIRE genuinely carries the literal string "expression" (grading.ts
    // nulls the top-level `failureCause` column on a correct verdict, but never
    // touches the `aiFeedback` JSON blob it is nested inside — see
    // `practice.service.ts`'s `escalateToGrader`). `AiFeedbackCard` never reads
    // that nested field; this assertion is what would catch a future edit that
    // started to.
    const pageText = await page.locator('body').innerText();
    for (const cause of RAW_FAILURE_CAUSES) {
      expect(
        new RegExp(`\\b${cause}\\b`).test(pageText),
        `raw failure-cause value "${cause}" must never appear in the DOM`,
      ).toBe(false);
    }

    // =========================================================================
    // USAGE — a row exists for this learner covering BOTH calls just made, and
    // the STREAMED one (`tutor`) recorded real, non-null token counts. This is
    // issue #37's silent-failure case: without `stream_options:
    // { include_usage: true }` on the streamed request, every streamed call
    // records zero and nothing fails loudly to say so.
    // =========================================================================
    const usageResponse = await page.request.get('/api/ai/usage', {
      headers: authHeaders,
    });
    expect(usageResponse.ok(), 'GET /api/ai/usage').toBe(true);
    const usageBody = (await usageResponse.json()) as UsageResponse;

    // Exactly two calls: this is a freshly seeded learner (a random-UUID
    // email with no prior history), and the only two AI calls made anywhere
    // in this test for THIS learner are the explain stream and the grading
    // escalation above.
    expect(usageBody.data.calls).toBe(2);

    const tutorUsage = usageBody.data.byRole.find((row) => row.key === 'tutor');
    const graderUsage = usageBody.data.byRole.find((row) => row.key === 'grader');
    expect(
      tutorUsage,
      `expected a "tutor" row in byRole, got: ${JSON.stringify(usageBody.data.byRole)}`,
    ).toBeDefined();
    expect(
      graderUsage,
      `expected a "grader" row in byRole, got: ${JSON.stringify(usageBody.data.byRole)}`,
    ).toBeDefined();
    // THE STREAMED CALL, specifically — see #37 above. A regression here would
    // record `totalTokens: 0` while `calls` still counted the request as
    // successful, which is exactly the silent failure this line exists to
    // catch.
    expect(tutorUsage?.totalTokens ?? 0).toBeGreaterThan(0);
    expect(graderUsage?.totalTokens ?? 0).toBeGreaterThan(0);

    // THE SAME FACT, VISIBLE ON `/settings/ai` — a learner reads this page,
    // not the JSON above.
    await page.goto('/settings/ai');
    await expect(
      page.getByRole('heading', { level: 1, name: 'AI key' }),
    ).toBeVisible();

    const requestsLabel = page.getByText('Requests', { exact: true });
    const requestsValue = requestsLabel.locator('xpath=following-sibling::*[1]');
    await expect(requestsValue).toHaveText('2');

    const tutorRow = page.getByRole('row').filter({ hasText: 'tutor' });
    await expect(tutorRow).toHaveCount(1);
    const tutorCells = await tutorRow.getByRole('cell').allInnerTexts();
    // [Name, Requests, Tokens] — see `Breakdown` in `UserAiKeyPage.tsx`.
    expect(Number(tutorCells[2].replace(/,/g, ''))).toBeGreaterThan(0);

    const graderRow = page.getByRole('row').filter({ hasText: 'grader' });
    await expect(graderRow).toHaveCount(1);
    const graderCells = await graderRow.getByRole('cell').allInnerTexts();
    expect(Number(graderCells[2].replace(/,/g, ''))).toBeGreaterThan(0);
  });
});
