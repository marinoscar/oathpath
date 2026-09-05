import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { seedOnboarding, TEST_AI_KEY } from '../helpers/auth.helper';
import { fetchAcceptedAnswer } from '../helpers/practice-questions';

// =============================================================================
// mock-interview-realtime.spec.ts — issue #161, epic #60 (E11 "Realtime")
// =============================================================================
//
// `docs/specs/realtime-interview.md` §10 draws this file's exact boundary:
// "Playwright covers session minting and the fallback, against
// `AI_PROVIDER_FAKE=true`... None of this requires a real WebRTC connection or
// real audio — it is testing this application's own HTTP and routing
// behaviour around the mint, not the realtime conversation itself." §11 is
// where the conversation itself is checked — a person, a microphone, a real
// release — and it is a MANUAL checklist, not a Playwright file.
//
// -----------------------------------------------------------------------------
// THIS SUITE NEVER OPENS A REALTIME CONNECTION, AND SAYS SO ONCE, HERE
// -----------------------------------------------------------------------------
//
// `realtimeConnection.ts`'s own header states the fact that makes this
// impossible to fake honestly: the browser opens a WebRTC connection DIRECTLY
// to `https://api.openai.com/v1/realtime/calls`, on the ephemeral secret this
// application minted. There is no code path in this repository between the
// mint and that URL for a test to intercept without either (a) a real OpenAI
// account and real network egress from the test runner, which this
// environment does not have and CI does not run this suite at all, or (b) a
// fabricated realtime transport standing in for actual speech recognition and
// actual barge-in — at which point the test asserts against a fake of the one
// thing it exists to verify. `docs/specs/realtime-interview.md` §13 rejects
// exactly this by name.
//
// So every scenario below stops at the boundary the real product already
// draws for itself: the MINT (`POST /api/interviews/:id/realtime-session`)
// and the TOOL CONTRACT (`POST /api/interviews/:id/realtime/tool-calls`) are
// both ordinary JSON-over-HTTPS routes this application owns end to end, and
// both are driven for real, against a real API and a real seeded Postgres.
// Driving the tool-call route directly with `page.request` — rather than
// through a live voice conversation — is not a shortcut invented for this
// file: it is the SAME relay contract `useRealtimeInterview.ts`'s own header
// describes ("Three tools arrive over the data channel. Each one is posted,
// unexamined, to `POST /api/interviews/:id/realtime/tool-calls`"), driven by
// this suite standing in for the data channel instead of a live model. What
// is NOT exercised here is whether OpenAI's realtime API actually calls those
// three tools correctly over real audio — that is §11, item by item, by a
// person.
//
// -----------------------------------------------------------------------------
// EXECUTION
// -----------------------------------------------------------------------------
//
// `playwright.config.ts`'s own `webServer` starts the stack with `docker
// compose`, which this sandbox has no daemon for (`docker ps` fails with "no
// such file or directory" on the Docker socket) — so this file was NOT run
// against that compose stack. It WAS, however, actually executed against a
// real, equivalent stack assembled by hand in this sandbox for exactly this
// purpose: a local PostgreSQL 16 server (migrated and seeded with the real
// civics and English content, `npm run prisma:migrate` / `prisma:seed`), the
// real API in `nest start --watch` (`NODE_ENV=development`,
// `AI_PROVIDER_FAKE=true`), and the real Vite dev server proxying `/api` to
// it (`vite.config.ts`'s own proxy, on port 3535 so `playwright.config.ts`'s
// hardcoded health-check URL resolves and the docker `webServer` command is
// never reached). All five tests below passed on their own, several
// consecutive runs in a row with zero flakes, and — the harder check — passed
// running immediately after `mock-interview-text.spec.ts` in one
// `--workers=1` invocation, the sequential mode this file's own `afterAll`
// hook (below) is written for. See the report handed back with this file for
// the exact commands, the selector mistakes this run surfaced and fixed in
// place, and the one genuine cross-file race it also surfaced (documented at
// that hook, not hidden here).
//
// -----------------------------------------------------------------------------
// NO API KEY, NO REAL MICROPHONE, NO REAL OPENAI ACCOUNT
// -----------------------------------------------------------------------------
//
// `AI_PROVIDER_FAKE=true` (non-production only) substitutes `FakeAiProvider`
// for `OpenAiProvider` at the DI layer, so every mint this file drives runs
// in-process with no outbound network call — `fake-ai.provider.ts`'s
// `runRealtimeSession` derives a deterministic `ek_fake_...` secret from the
// model id and role key alone (no clock, no randomness), which is exactly
// what makes "the secret changed" or "the secret leaked" assertions below
// meaningful rather than lucky. `seedOnboarding`'s own `PUT /api/ai/key` call
// gives every learner it seeds a stored key (`TEST_AI_KEY`, imported rather
// than re-guessed) before this file ever runs, satisfying `no_user_key`
// without a network call of its own either.
//
// -----------------------------------------------------------------------------
// TEST ORDER, AND WHY THIS FILE USES `mode: 'serial'`
// -----------------------------------------------------------------------------
//
// AI configuration is one row (`system_settings.key = 'ai'`), shared by every
// learner and every spec file in this suite — the identical "GLOBAL STATE"
// `voice.spec.ts`'s own header discusses, restated here for the same reason:
// Test 1 needs `realtime` UNBOUND; every test after it needs `realtime`
// BOUND. `test.describe.configure({ mode: 'serial' })` forces file order in
// one worker regardless of `playwright.config.ts`'s own `fullyParallel: true`.
//
// -----------------------------------------------------------------------------
// DETERMINISM: NO WALL-CLOCK OR ORDERING DEPENDENCE
// -----------------------------------------------------------------------------
//
// Every civics answer below is read verbatim off `GET /api/civics/questions/:id`
// (`fetchAcceptedAnswer`, unchanged from `practice-questions.ts`) and every
// `grade_answer` call OMITS `confidence` entirely — "absent means unknown,
// never low" (`interview-tool-call.dto.ts`), which keeps every answer clear of
// the `misheard` branch without this file needing to know or care what
// confidence a real recogniser would have reported. No sleep, no wall-clock
// read, and no dependence on which of the seeded civics test versions a fresh
// learner resolves to — every loop below asks the SERVER what question it is
// currently outstanding on (`next.itemId`, the mint route's own tool-call
// response field) rather than predicting an ask-list.
// =============================================================================

/** A fresh, obviously-fake test email per scenario. */
function testEmail(label: string): string {
  return `realtime-${label}-${randomUUID()}@test.local`;
}

/** A key that is obviously fake and obviously not a real OpenAI secret. */
const FAKE_SERVER_KEY = 'sk-e2e-fake-server-key-not-real-realtime';

/** `FAKE_MODEL_IDS` entries `model-classifier.ts` sorts into each family. */
const TUTOR_MODEL = 'gpt-5.4';
const GRADER_MODEL = 'gpt-5.4-mini';
const REALTIME_MODEL = 'gpt-4o-realtime-preview';

// -----------------------------------------------------------------------------
// Wire shapes — the exact fields the DTOs cited beside each declare.
// -----------------------------------------------------------------------------

interface RealtimeSessionOk {
  status: 'ok';
  clientSecret: string;
  expiresAt: string;
  modelId: string;
}
interface RealtimeSessionUnavailable {
  status: 'unavailable';
  cause: string;
  role: string;
}
interface RealtimeSessionFailed {
  status: 'failed';
  errorCode: string;
  error: string;
}
type RealtimeSessionBody =
  | RealtimeSessionOk
  | RealtimeSessionUnavailable
  | RealtimeSessionFailed;
type RealtimeSessionResponse = { data: RealtimeSessionBody };

interface CreatedInterview {
  interview: { id: string; mode: 'text' | 'voice'; status: string };
}
type CreateInterviewResponse = { data: CreatedInterview };

interface InterviewDetail {
  interview: { id: string; mode: 'text' | 'voice'; status: string };
  turns: { role: 'officer' | 'applicant'; phase: string; questionId: string | null }[];
  progress: { civicsAsked: number; civicsPlanned: number };
}
type InterviewDetailResponse = { data: InterviewDetail };

/** `RealtimeToolCallResponse` — every field any of the three tools can return. */
interface ToolCallResult {
  tool: string;
  status: 'ok' | 'rejected';
  itemId?: string | null;
  phase?: string;
  awaitingCompletion?: boolean;
  recorded?: boolean;
  reason?: string;
}
type ToolCallResponse = { data: ToolCallResult };

interface InterviewReadinessSummary {
  score: number;
  capReason: 'typed_only' | null;
  capMessage: string | null;
}
interface DebriefBody {
  civics: { passed: boolean };
  readiness: InterviewReadinessSummary;
}
type CompleteInterviewResponse = { data: DebriefBody };

interface AiStatusResponse {
  data: { systemReady: boolean; unboundRoles: string[] };
}

// -----------------------------------------------------------------------------
// API helpers
// -----------------------------------------------------------------------------

/**
 * `PUT /api/ai-settings`, as the admin whose bearer token is passed. A
 * REPLACE, not a merge — the exact `models` map matters as much as which
 * fields are present, identically to `voice.spec.ts`'s own helper of the same
 * name and shape.
 */
async function putAiSettings(
  page: Page,
  accessToken: string,
  body: { provider: 'openai'; enabled: boolean; apiKey: string; models: Record<string, string> },
): Promise<void> {
  const response = await page.request.put('/api/ai-settings', {
    headers: { Authorization: `Bearer ${accessToken}` },
    data: body,
    failOnStatusCode: false,
  });
  expect(
    response.ok(),
    `PUT /api/ai-settings — ${JSON.stringify(body)} — ${await response.text().catch(() => '')}`,
  ).toBe(true);
}

async function mintRealtimeSession(
  page: Page,
  headers: Record<string, string>,
  interviewId: string,
): Promise<{ status: number; headers: Record<string, string>; body: RealtimeSessionBody }> {
  const response = await page.request.post(`/api/interviews/${interviewId}/realtime-session`, {
    headers,
    data: {},
    failOnStatusCode: false,
  });
  const json = (await response.json()) as RealtimeSessionResponse;
  return { status: response.status(), headers: response.headers(), body: json.data };
}

async function createInterview(
  page: Page,
  headers: Record<string, string>,
): Promise<CreatedInterview> {
  const response = await page.request.post('/api/interviews', {
    headers,
    data: { transcriptRetained: false },
  });
  expect(response.ok(), 'POST /api/interviews').toBe(true);
  return ((await response.json()) as CreateInterviewResponse).data;
}

async function fetchInterview(
  page: Page,
  headers: Record<string, string>,
  interviewId: string,
): Promise<InterviewDetail> {
  const response = await page.request.get(`/api/interviews/${interviewId}`, { headers });
  expect(response.ok(), 'GET /api/interviews/:id').toBe(true);
  return ((await response.json()) as InterviewDetailResponse).data;
}

async function callTool(
  page: Page,
  headers: Record<string, string>,
  interviewId: string,
  body: Record<string, unknown>,
): Promise<ToolCallResult> {
  const response = await page.request.post(
    `/api/interviews/${interviewId}/realtime/tool-calls`,
    { headers, data: body },
  );
  expect(response.ok(), `POST .../tool-calls — ${JSON.stringify(body)}`).toBe(true);
  return ((await response.json()) as ToolCallResponse).data;
}

/**
 * Drive one civics answer via the tool contract — `next_question` then
 * `grade_answer` — reading the outstanding item and its accepted answer off
 * the SERVER's own responses, never predicted. Returns the `next_question`
 * result that named the item, so a caller can inspect `phase`/`itemId`
 * without a second round trip.
 */
async function answerOneCivicsQuestion(
  page: Page,
  headers: Record<string, string>,
  interviewId: string,
): Promise<ToolCallResult> {
  // `POST /api/interviews` already served the OPENING smalltalk line
  // (`InterviewsService`'s own header: "the opening turn is not this
  // route's"), so the first `next_question` call this file makes consumes
  // that ungraded reply rather than landing on civics directly — and the
  // three ungraded `n400` prompts after it work the same way. Loop past
  // every ungraded turn (`itemId === null`) until the engine actually serves
  // a civics question, exactly as `driveEntireInterview` below already does
  // for the whole interview.
  let next: ToolCallResult;
  for (;;) {
    next = await callTool(page, headers, interviewId, { tool: 'next_question' });
    expect(next.status).toBe('ok');
    if (next.phase === 'civics' && next.itemId) break;
  }

  const questionId = next.itemId!;
  const transcript = await fetchAcceptedAnswer(page, headers, questionId);
  // NO `confidence` FIELD — "absent means unknown, never low"
  // (`interview-tool-call.dto.ts`). Every answer below is graded normally,
  // never misheard, without this file predicting a recogniser's confidence.
  const graded = await callTool(page, headers, interviewId, {
    tool: 'grade_answer',
    questionId,
    transcript,
  });
  expect(graded.status).toBe('ok');
  return next;
}

/**
 * Drive an ENTIRE realtime interview to `awaitingCompletion`, by tool calls
 * alone — smalltalk and the application review are ungraded and simply
 * consumed by the next `next_question` call (§4.1's `consumeUngradedTurn`);
 * civics answers are always the accepted answer, so the stop rule fires via
 * `threshold_reached`; reading and writing (when this deployment's content
 * seeds them) are answered with an arbitrary transcript, which is enough —
 * neither segment's correctness feeds the `interview`/`spoken` readiness
 * components this file's own last scenario checks (`readiness-engine.ts`'s
 * `computeSpoken` reads only `inputMode: 'spoken'` CIVICS attempts, and
 * `computeInterview` reads only whether the interview passed, never which
 * segments it conducted).
 */
async function driveEntireInterview(
  page: Page,
  headers: Record<string, string>,
  interviewId: string,
): Promise<void> {
  for (;;) {
    const next = await callTool(page, headers, interviewId, { tool: 'next_question' });
    expect(next.status).toBe('ok');
    if (next.awaitingCompletion) return;

    if (!next.itemId) continue; // An ungraded turn — nothing to answer.

    const transcript =
      next.phase === 'civics'
        ? await fetchAcceptedAnswer(page, headers, next.itemId)
        : 'an arbitrary spoken reply, ungraded by this suite';

    const graded = await callTool(page, headers, interviewId, {
      tool: 'grade_answer',
      questionId: next.itemId,
      transcript,
    });
    expect(graded.status).toBe('ok');
  }
}

// =============================================================================
// TEST 1 — `realtime` unbound: the text interview runs unchanged, and
// `AiNotReady` names the role
// =============================================================================

test.describe('Realtime mock interview (issue #161), epic #60 (E11)', () => {
  test.describe.configure({ mode: 'serial' });

  // ---------------------------------------------------------------------------
  // LEAVE `realtime` UNBOUND WHEN THIS FILE IS DONE
  // ---------------------------------------------------------------------------
  //
  // Unlike `voice.spec.ts`'s own header ("this spec does not restore AI to a
  // disabled state when it finishes... nothing LATER... depends on AI being
  // off again"), something later DOES depend on this one role specifically:
  // `mock-interview-text.spec.ts`'s `startInterviewFromPracticePage` clicks a
  // button named `'Start the interview'`, which is
  // `InterviewStartPage.tsx`'s own OWN text only while `realtime` has no
  // model bound — the moment it does, that same button reads `'Start by
  // typing instead'` instead (the spoken option takes the primary slot). A
  // real run of this suite in alphabetical order puts this file BEFORE that
  // one, so leaving `realtime` bound here would silently break a sibling
  // file's selector with no changes to that file at all — discovered by
  // actually running both, in order, against one shared database, not
  // reasoned about in the abstract. Restoring the exact `tutor`+`grader`-only
  // shape this file's own first test already put in place is not a NEW side
  // effect; it is undoing the one this file adds beyond it.
  //
  // THE HONEST LIMIT OF THIS FIX: it closes the SEQUENTIAL case (this file
  // finishes, THEN a sibling starts — what `--workers=1` guarantees, and what
  // running one file at a time always gives for free). It does not close a
  // TRUE race — a sibling file's own test reading the AI settings row at the
  // exact moment `realtime` is bound but this file has not yet reached this
  // hook, which `playwright.config.ts`'s own `fullyParallel: true` can produce
  // if multiple spec files are handed to one `npx playwright test` invocation
  // with more than one worker. `CLAUDE.md`'s CI section runs no Playwright at
  // all, and `voice.spec.ts`'s own header already accepts the identical
  // exposure for the AI settings row in general ("workers: 1 in CI... makes
  // this unnecessary there") — this hook narrows the SAME accepted gap for one
  // more role, it does not invent a new one or promise to close it outright.
  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    const { accessToken } = await seedOnboarding(page, {
      email: testEmail('unbind-admin'),
      role: 'admin',
      onboarding: 'full',
    });
    await putAiSettings(page, accessToken, {
      provider: 'openai',
      enabled: true,
      apiKey: FAKE_SERVER_KEY,
      models: { tutor: TUTOR_MODEL, grader: GRADER_MODEL },
    });
    await page.close();
  });

  test('with `realtime` unbound, the spoken option is absent, AiNotReady names it, and the text interview is unaffected', async ({
    page,
  }) => {
    // Admin, so `AiNotReady`'s admin-only naming line ("no model is bound to
    // realtime") is on screen to assert against — the concrete, on-screen
    // proof the role is actually named, not merely that the code follows the
    // convention (`voice.spec.ts`'s own Test 1 does the identical thing for
    // `transcribe`).
    const email = testEmail('unbound');
    const { accessToken } = await seedOnboarding(page, {
      email,
      role: 'admin',
      onboarding: 'full',
    });
    const headers = { Authorization: `Bearer ${accessToken}` };
    await page.waitForURL('/', { timeout: 10000 });

    // `tutor`/`grader` bound, `realtime` deliberately absent from the map —
    // `systemReady: true` (text AI fully configured), `realtime` unbound.
    await putAiSettings(page, accessToken, {
      provider: 'openai',
      enabled: true,
      apiKey: FAKE_SERVER_KEY,
      models: { tutor: TUTOR_MODEL, grader: GRADER_MODEL },
    });

    const statusResponse = await page.request.get('/api/ai/status', { headers });
    expect(statusResponse.ok(), 'GET /api/ai/status').toBe(true);
    const status = ((await statusResponse.json()) as AiStatusResponse).data;
    expect(status.systemReady).toBe(true);
    expect(status.unboundRoles).toContain('realtime');

    // ---- The UI: no spoken option, and the role named on screen -----------
    await page.goto('/practice/interviews');
    await expect(page.getByRole('heading', { level: 1, name: 'Mock interview' })).toBeVisible();

    // HIDDEN, NOT DISABLED (`InterviewStartPage.tsx`'s own header: "a
    // greyed-out control is an affordance for an action that cannot
    // succeed"). `queryCount` rather than `not.toBeVisible()`, so a button
    // rendered-but-hidden-by-CSS would still be caught.
    await expect(
      page.getByRole('button', { name: 'Start a spoken interview' }),
    ).toHaveCount(0);

    // `InterviewStartPage.tsx` passes `feature="A spoken interview"`, so
    // `AiNotReady`'s title is the feature-specific sentence, never the
    // generic "This is not available yet" fallback that renders only when
    // no `feature` prop is given.
    await expect(page.getByText('A spoken interview is not available yet')).toBeVisible();
    await expect(
      page.getByText('As an administrator: no model is bound to realtime.'),
    ).toBeVisible();

    // ---- Stored state: the text interview runs, unaffected ----------------
    // `page.getByRole('button', ...)` rather than a second `handleStart`
    // helper: this file asks the least of the UI it needs to, because
    // `mock-interview-text.spec.ts` already owns the full text-transport
    // battery — this is the "unchanged" half of the acceptance criterion,
    // not a second copy of that suite.
    await page.getByRole('button', { name: 'Start the interview' }).click();
    await expect(page).toHaveURL(/\/practice\/interviews\/[0-9a-f-]{36}$/);
    const interviewId = page.url().split('/').pop()!;

    // STORED STATE, not navigation: no realtime mint was ever attempted for
    // this interview, so `mode` never left its `text` default — the fact
    // `realtime-interview.md` §3 states records "whether this interview was
    // EVER conducted by voice", one-way and server-side only.
    const detail = await fetchInterview(page, headers, interviewId);
    expect(detail.interview.mode).toBe('text');
    expect(detail.interview.status).toBe('in_progress');

    // And the text interview genuinely works end to end — the tool-call
    // route is a distinct endpoint no unbound `realtime` role touches, so a
    // real answer through the ORDINARY text UI proves nothing about voice
    // silently degraded it.
    await expect(page.getByLabel('Your answer')).toBeVisible();
    // Smalltalk is ungraded (§2.1) — anything typed here advances the turn.
    await page.getByLabel('Your answer').fill('hello, thank you for having me');
    await page.getByRole('button', { name: 'Answer', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Answer', exact: true }).or(
        page.getByRole('button', { name: 'Finish and see how it went', exact: true }),
      ),
    ).toBeVisible({ timeout: 20000 });

    const advanced = await fetchInterview(page, headers, interviewId);
    expect(advanced.turns.length).toBeGreaterThan(detail.turns.length);
    expect(advanced.interview.mode).toBe('text');
  });

  // ===========================================================================
  // From here on, `realtime` is bound for the rest of this file.
  // ===========================================================================

  test('binds `realtime` for the remaining scenarios', async ({ page }) => {
    const { accessToken } = await seedOnboarding(page, {
      email: testEmail('bind-admin'),
      role: 'admin',
      onboarding: 'full',
    });
    await putAiSettings(page, accessToken, {
      provider: 'openai',
      enabled: true,
      apiKey: FAKE_SERVER_KEY,
      models: { tutor: TUTOR_MODEL, grader: GRADER_MODEL, realtime: REALTIME_MODEL },
    });
  });

  // ===========================================================================
  // TEST 2 — minting: succeeds for the owner, 404s for anyone else, and never
  // carries a long-lived key — in the response, its headers, or client storage
  // ===========================================================================

  test('mints for the owner, 404s for anyone else, and carries no long-lived key anywhere', async ({
    page,
    browser,
  }) => {
    const owner = await seedOnboarding(page, {
      email: testEmail('owner'),
      onboarding: 'full',
    });
    const ownerHeaders = { Authorization: `Bearer ${owner.accessToken}` };
    await page.waitForURL('/', { timeout: 10000 });

    // A SEPARATE BROWSER CONTEXT for the stranger — the identical isolation
    // `civics-learn.spec.ts`'s own cross-user scenario uses: the owner and
    // the stranger are two different, simultaneously live sessions, so the
    // owner's own cookies must never be the ones a "stranger" request
    // happens to carry. Only its bearer token is used below; the context is
    // otherwise unused.
    const strangerContext = await browser.newContext();
    const strangerPage = await strangerContext.newPage();
    const stranger = await seedOnboarding(strangerPage, {
      email: testEmail('stranger'),
      onboarding: 'full',
    });
    const strangerHeaders = { Authorization: `Bearer ${stranger.accessToken}` };

    const created = await createInterview(page, ownerHeaders);
    const interviewId = created.interview.id;

    // ---- 404 for anyone else, BEFORE the owner's own mint. A rejection body
    // would confirm the id names a real interview belonging to somebody;
    // `requireInterview` 404s on a `where` clause scoped to the caller. -----
    const strangerAttempt = await mintRealtimeSession(strangerPage, strangerHeaders, interviewId);
    expect(strangerAttempt.status).toBe(404);
    await strangerContext.close();

    // ---- Succeeds for the owner ---------------------------------------------
    const minted = await mintRealtimeSession(page, ownerHeaders, interviewId);
    expect(minted.status).toBe(200);
    expect(minted.body.status).toBe('ok');
    if (minted.body.status !== 'ok') return;

    expect(minted.body.clientSecret).toMatch(/^ek_fake_/);
    expect(minted.body.modelId).toBe(REALTIME_MODEL);
    expect(typeof minted.body.expiresAt).toBe('string');

    // ---- No long-lived key ANYWHERE the response carries information ------
    // 1. The response JSON itself: the exact literal `seedOnboarding` stored
    //    for this learner, and the exact literal this file bound as the
    //    server/admin credential, must not appear — not truncated, not
    //    substring-matched into the secret by coincidence.
    const rawBody = JSON.stringify(minted.body);
    expect(rawBody).not.toContain(TEST_AI_KEY);
    expect(rawBody).not.toContain(FAKE_SERVER_KEY);

    // 2. The HEADERS. `Cache-Control: no-store` is the mint route's own
    //    stated contract (`interviews.controller.ts`'s `@Header`) — a cached
    //    mint response is a bearer credential sitting in a shared or disk
    //    cache for longer than it is valid — and no header may carry either
    //    key either.
    expect(minted.headers['cache-control']).toContain('no-store');
    const headerBlob = JSON.stringify(minted.headers);
    expect(headerBlob).not.toContain(TEST_AI_KEY);
    expect(headerBlob).not.toContain(FAKE_SERVER_KEY);

    // 3. CLIENT STORAGE. `realtimeConnection.ts`'s own header states the
    //    secret "is never written to `localStorage`, `sessionStorage`, a
    //    cookie, or a module-level variable that outlives the connection" —
    //    checked here from the OUTSIDE, against the real browser storage
    //    this page's origin can see, not by reading that file's source and
    //    trusting it. A mint made via `page.request` never touches the page's
    //    JS runtime at all, so this also stands as the honest baseline: if
    //    THIS is clean, a real UI-driven mint (which only ever holds the
    //    secret in the same React state `useRealtimeInterview.ts` already
    //    keeps, never in a store) cannot be dirtier.
    const storageDump = await page.evaluate(() => {
      const dump = (store: Storage) => {
        const entries: string[] = [];
        for (let i = 0; i < store.length; i += 1) {
          const key = store.key(i);
          if (key !== null) entries.push(`${key}=${store.getItem(key)}`);
        }
        return entries.join('\n');
      };
      return {
        local: dump(window.localStorage),
        session: dump(window.sessionStorage),
      };
    });
    expect(storageDump.local).not.toContain(TEST_AI_KEY);
    expect(storageDump.local).not.toContain(FAKE_SERVER_KEY);
    expect(storageDump.local).not.toContain(minted.body.clientSecret);
    expect(storageDump.session).not.toContain(TEST_AI_KEY);
    expect(storageDump.session).not.toContain(FAKE_SERVER_KEY);
    expect(storageDump.session).not.toContain(minted.body.clientSecret);

    // And the closed field list itself — nothing beyond the three documented
    // fields ever rides along, which is the field-level echo of the same
    // "the list is closed" rule `interview-realtime-session.dto.ts` states
    // for itself.
    expect(Object.keys(minted.body).sort()).toEqual(
      ['clientSecret', 'expiresAt', 'modelId', 'status'].sort(),
    );

    // The first successful mint recorded this as a voice interview — the
    // durable, one-way fact §3 describes, checked as STORED STATE.
    const detail = await fetchInterview(page, ownerHeaders, interviewId);
    expect(detail.interview.mode).toBe('voice');
  });

  // ===========================================================================
  // TEST 3 — a mint failure mid-interview falls back to text with the SAME
  // interview id and progress intact, asserted on stored state
  // ===========================================================================

  test('a mint failure mid-interview falls back to text, with progress intact', async ({
    page,
  }) => {
    const { accessToken } = await seedOnboarding(page, {
      email: testEmail('fallback'),
      onboarding: 'full',
    });
    const headers = { Authorization: `Bearer ${accessToken}` };
    await page.waitForURL('/', { timeout: 10000 });

    const created = await createInterview(page, headers);
    const interviewId = created.interview.id;

    // The FIRST mint succeeds for real, against the fake provider — this is
    // what a learner who actually started a voice session experienced, and
    // it is what flips `mode` to `voice` before anything goes wrong.
    const firstMint = await mintRealtimeSession(page, headers, interviewId);
    expect(firstMint.status).toBe(200);
    expect(firstMint.body.status).toBe('ok');

    // Real progress, made by real tool calls — exactly what a live voice
    // session would have produced over the data channel, driven here without
    // one (see the file header). Two questions in, both correct.
    await answerOneCivicsQuestion(page, headers, interviewId);
    await answerOneCivicsQuestion(page, headers, interviewId);

    const beforeFallback = await fetchInterview(page, headers, interviewId);
    expect(beforeFallback.progress.civicsAsked).toBe(2);
    expect(beforeFallback.interview.status).toBe('in_progress');

    // Now the connection drops and the client re-mints — and THIS mint fails.
    // `page.route` intercepts the exact route the real product calls when it
    // re-mints (`useRealtimeInterview.ts`'s own re-mint-on-drop path, §3),
    // returning the identical `failed` shape the DTO declares — an HTTP 200
    // with `status: 'failed'`, never a non-2xx (`interview-realtime-session
    // .dto.ts`'s own header: a non-2xx would discard the one fact this
    // response exists to carry). This is the ONE simulated failure this file
    // injects, and it stands in for the fake provider itself failing — which
    // `FakeAiProvider.runRealtimeSession` (#156) is deliberately
    // deterministic and never does — not for the real WebRTC handshake.
    //
    // `page.route` only intercepts requests the BROWSER PAGE itself makes —
    // never `page.request.*`, which is a separate API context with no route
    // table of its own — so the re-mint below is driven through the REAL
    // `RealtimeInterviewPage` UI (the "Start the spoken interview" button,
    // which calls the identical `createRealtimeSession` this interview's
    // first, successful mint already went through) rather than a second
    // `page.request.post` call.
    await page.route('**/api/interviews/*/realtime-session', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            status: 'failed',
            errorCode: 'simulated_e2e_failure',
            error: 'Simulated for issue #161 — never a real provider response.',
          },
        }),
      });
    });

    await page.goto(`/practice/interviews/${interviewId}/voice`);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Spoken mock interview' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Start the spoken interview' }).click();

    // `mint_failed` — distinct from `ai_unavailable` — is what
    // `useRealtimeInterview.ts` reports for "the mint was attempted and did
    // not produce a usable session" (§7), and `FallbackPanel` always offers
    // the text interview as its primary action.
    const continueByTyping = page.getByRole('link', { name: 'Continue by typing' });
    await expect(continueByTyping).toBeVisible({ timeout: 15000 });

    await page.unroute('**/api/interviews/*/realtime-session');

    // ---- PROGRESS INTACT, asserted on STORED STATE ------------------------
    // Not "the UI navigated to the text screen" — the two attempts already
    // made are still there, the phase has not rewound, and the interview is
    // still `in_progress` under the SAME id, exactly as §7 promises: "the
    // engine state that actually matters... is server-side and untouched by
    // which transport is driving it."
    const afterFallback = await fetchInterview(page, headers, interviewId);
    expect(afterFallback.interview.id).toBe(interviewId);
    expect(afterFallback.interview.status).toBe('in_progress');
    expect(afterFallback.progress.civicsAsked).toBe(2);
    expect(afterFallback.turns.length).toBe(beforeFallback.turns.length);

    // And the SAME engine can finish it over the text transport — via the
    // fallback panel's own primary action, the concrete instance of "both
    // transports drive the identical engine" (§7), proven by actually
    // landing on a working `AnswerBox`, not merely by the id matching.
    // `InterviewPage` resumes at exactly the next question the engine
    // already knew was next.
    await continueByTyping.click();
    await expect(page).toHaveURL(`/practice/interviews/${interviewId}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Mock interview' })).toBeVisible();
    await expect(page.getByLabel('Your answer')).toBeVisible({ timeout: 15000 });

    // `mode` stays `voice` — a coarse, one-way summary of whether this
    // interview was EVER conducted by voice, never reverted by a later
    // fallback (§3's own rule, checked as stored state one more time).
    expect(afterFallback.interview.mode).toBe('voice');
  });

  // ===========================================================================
  // TEST 4 — a completed voice interview credits BOTH `interview` and
  // `spoken`, and lifts the typed-only cap — asserted on the debrief's own
  // readiness numbers, never merely "the page changed"
  // ===========================================================================

  test('a completed voice interview raises interview and spoken, and lifts the cap', async ({
    page,
  }) => {
    const { accessToken } = await seedOnboarding(page, {
      email: testEmail('readiness'),
      onboarding: 'full',
    });
    const headers = { Authorization: `Bearer ${accessToken}` };
    await page.waitForURL('/', { timeout: 10000 });

    const created = await createInterview(page, headers);
    const interviewId = created.interview.id;

    const minted = await mintRealtimeSession(page, headers, interviewId);
    expect(minted.body.status).toBe('ok');

    // Every civics answer correct (via `driveEntireInterview`'s own
    // `fetchAcceptedAnswer` lookups), every civics `practice_attempts` row
    // therefore `inputMode: 'spoken'` AND `outcome: 'correct'` (§6) — exactly
    // what `computeSpoken` counts, and a passed civics section — exactly
    // what `computeInterview` counts, regardless of which segments this
    // rehearsal's reading/writing phases happened to conduct.
    await driveEntireInterview(page, headers, interviewId);

    const response = await page.request.post(`/api/interviews/${interviewId}/complete`, {
      headers,
    });
    expect(response.ok(), 'POST /api/interviews/:id/complete').toBe(true);
    const debrief = ((await response.json()) as CompleteInterviewResponse).data;

    expect(debrief.civics.passed).toBe(true);

    // THE CAP MESSAGE CHANGES: a learner with zero prior evidence of either
    // kind starts `typed_only`-capped, and this interview alone credits BOTH
    // `spoken` (via the civics attempts it just wrote) and `interview` (via
    // passing) — either one alone already lifts the cap
    // (`readiness-engine.ts`: `evidenceCounts.spoken.attempts === 0 &&
    // evidenceCounts.interview.attempts === 0`), so crediting both at once is
    // not a borderline case. `capMessage` goes from the server's own
    // sentence to `null` — never re-derived by this file, only compared.
    expect(debrief.readiness.capReason).toBeNull();
    expect(debrief.readiness.capMessage).toBeNull();

    // STORED STATE, not merely the one response: `GET /api/readiness`
    // independently agrees, and names the two components by their own
    // evidence counts — the concrete numbers §8.1 walks through.
    const readinessResponse = await page.request.get('/api/readiness', { headers });
    expect(readinessResponse.ok(), 'GET /api/readiness').toBe(true);
    const readiness = (await readinessResponse.json()) as {
      data: {
        capReason: string | null;
        evidenceCounts: {
          spoken: { attempts: number };
          interview: { attempts: number };
        };
      };
    };
    expect(readiness.data.capReason).toBeNull();
    expect(readiness.data.evidenceCounts.interview.attempts).toBe(1);
    expect(readiness.data.evidenceCounts.spoken.attempts).toBeGreaterThan(0);

    // A light UI echo, never the primary assertion: the debrief's own
    // readiness section renders `capMessage` only `capReason !== null && capMessage`
    // (`ReadinessMovement.tsx`), so with both null this alert is simply
    // absent rather than showing stale or contradictory copy.
    await page.goto(`/practice/interviews/${interviewId}/debrief`);
    // A generous timeout: the debrief page's own load fetches the completed
    // interview and computes readiness copy client-side, and a freshly
    // completed voice interview's debrief carries more sections (the E11
    // realtime debrief, #160) than a plain text one — slower than the
    // library default's 5s on a loaded runner, not hung.
    await expect(
      page.getByRole('heading', { level: 1, name: 'Interview debrief' }),
    ).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole('status').filter({ hasText: 'typed' })).toHaveCount(0);
  });
});
