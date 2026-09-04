import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { seedOnboarding } from '../helpers/auth.helper';
import { fetchAcceptedAnswer, fetchNextQuestionId } from '../helpers/practice-questions';
import { closeDbPool, countStorageObjectsUploadedBy } from '../helpers/db';

// =============================================================================
// voice.spec.ts — issue #114, epic #58 (E9 "Voice foundation")
// =============================================================================
//
// `docs/specs/voice.md` is the design this spec is checked against — §3
// (confirm-before-grade, `ASR_CONFIDENCE_THRESHOLD` 0.6), §3.2 (supersession),
// §4 (audio is never stored). The six scenarios below map onto that document
// exactly:
//
//   1. A spoken attempt end to end                     -> §3, §3.1, §8
//   2. Low confidence -> retry, not a bare incorrect    -> §3, §3.1, §3.2, §3.3
//   3. `spoken` readiness rises, the cap message moves  -> §3.2 ("no change
//      needed"), `readiness-model.md` §3
//   4. `transcribe` unbound -> text mode, role named    -> §1's table
//   5. Voice -> text mid-session keeps progress         -> §5
//   6. No `storage_objects` row, no audio on the wire    -> §4
//
// -----------------------------------------------------------------------------
// EXECUTION
// -----------------------------------------------------------------------------
//
// Every selector, route, copy string and DTO field below was read directly out
// of the shipped source cited beside it — `apps/web/src/pages/
// PracticeSessionPage.tsx`, `apps/web/src/components/voice/*`, `apps/web/src/
// hooks/useAudioCapture.ts` and `useVoiceAvailability.ts`,
// `apps/web/src/components/ai/AiNotReady.tsx`, `apps/api/src/ai/
// ai-speech.controller.ts`, `apps/api/src/ai/providers/fake-ai.provider.ts`,
// and `apps/api/src/practice/practice.service.ts` — never invented or
// guessed. `npx tsc --noEmit -p tests/e2e/tsconfig.json` passes clean. This
// sandbox has no daemon for `playwright.config.ts`'s own `webServer` (`docker
// compose`) and no reachable API at `http://localhost:3535`, so the suite
// itself was **not executed** — see the report handed back with this file for
// exactly what was and was not verified another way.
//
// -----------------------------------------------------------------------------
// NO API KEY, NO REAL MICROPHONE — HOW
// -----------------------------------------------------------------------------
//
// `AI_PROVIDER_FAKE=true` (non-production only; `AiModule.resolveAiProvider`)
// substitutes `FakeAiProvider` for `OpenAiProvider` at the DI layer, so every
// call this spec makes to `POST /api/ai/speech/transcribe` runs in-process,
// with no OpenAI account and no outbound network call. This is an
// ENVIRONMENT requirement this file cannot set for itself — see
// `ai-evaluation.spec.ts`'s own header for the identical note, which this
// file does not repeat mechanics for twice.
//
// The microphone is real Chromium, not a stub: `playwright.config.ts`'s
// `--use-fake-device-for-media-stream` and `--use-fake-ui-for-media-stream`
// (added by this issue) make `getUserMedia({ audio: true })` resolve with a
// real, silent `MediaStream` and no permission prompt. `test.use({
// permissions: ['microphone'] })` below is belt-and-suspenders on top of the
// launch flags — Playwright's own permission model is a second gate some
// Chromium builds still consult independently of the CLI flags.
//
// -----------------------------------------------------------------------------
// THE MARKER CONVENTION — DRIVING `FakeAiProvider.runTranscription` FOR REAL
// -----------------------------------------------------------------------------
//
// `fake-ai.provider.ts`'s own header spells out the contract: the "recording"
// is read as UTF-8 (well, latin1 — see that file) and searched for two
// markers, `TRANSCRIPT:<text>` and `LOWCONF`. A test drives it by controlling
// THE BYTES THE BROWSER UPLOADS. The one part of that path this suite has no
// audio for is `MediaRecorder` itself: Chromium's fake device produces a real
// but SILENT stream, which `MediaRecorder` would encode into real (silent)
// opus/webm bytes containing no marker at all.
//
// So this file stubs `window.MediaRecorder` with a page-level init script
// (`installFakeMediaRecorder`, below) — installed with `page.addInitScript`,
// which re-applies itself to every subsequent navigation on the same `page`.
// The fake class still takes the real `MediaStream` `useAudioCapture.ts`
// hands it (so every check upstream of encoding — permission, device
// selection, track lifecycle — is exercised for real) and, on `.stop()`,
// synchronously emits a `Blob` built from `window.__oathpathVoiceMarker`
// instead of encoding the stream. That variable is set with `page.evaluate`
// immediately before each recording (see `answerWithVoice` below), so a
// single stub serves every marker this file needs without reinstalling
// itself per question.
//
// The button is driven by KEYBOARD, not a pointer hold:
// `PushToTalkButton.tsx`'s own header documents Space/Enter as a TOGGLE
// (start on the first press, stop on the second) specifically so a
// non-pointer client can drive it — which is exactly what a synchronous fake
// recorder needs, since a real `pointerdown`/`pointerup` pair has no
// guaranteed ordering relative to Playwright's own event queue the way two
// sequential `.press('Enter')` calls do.
//
// -----------------------------------------------------------------------------
// WHY `grader` IS DELIBERATELY LEFT UNBOUND, EVEN THOUGH `tutor`/`grader` ARE
// BOUND FOR SCENARIO 4
// -----------------------------------------------------------------------------
//
// `FakeAiProvider`'s `PARAPHRASES` table credits "head of the executive" (no
// trailing word) as a paraphrase of "President" — a literal substring of
// `MISHEARD_TRANSCRIPT` ("the head of the executive ranch", the fixture
// `LOWCONF` produces). If the AI grader (rung 2) were reachable, a Quick 5
// that happened to draw a question whose accepted answer is "President"
// would grade the low-confidence scenario's garbled transcript CORRECT via
// that paraphrase — an intermittent, content-dependent flake with nothing to
// do with this issue. `answer-matching.ts`'s own header rules out any such
// fuzzy match at rung 1 ("no edit distance, no substring containment, no
// token-overlap ratio... equal, or after a fully deterministic rewrite") —
// rung 1 is safe for any question — so the fix is to keep rung 2
// UNREACHABLE for the scenarios that need voice: the settings PUT that binds
// `transcribe`/`speak` (Test 2 below) deliberately REPLACES the row with
// `models: { transcribe, speak }` and no `tutor`/`grader` key, which
// `AiDispatchService` reads as `role_unbound` for `grader` —
// `escalateToGrader` returns `null` unconditionally for that cause
// (`attempt-grading.service.ts`), so every attempt below is graded by rung 1
// alone. This also happens to demonstrate `voice.md` §1's independence claim
// from the OTHER direction than Test 1 does: Test 1 shows `systemReady:
// true` with `transcribe` unbound (voice absent, text fully ready); this
// binding shows the reverse — `transcribe`/`speak` bound with `systemReady:
// false` (voice fully usable, `AiNotReady` would render for anything
// `tutor`/`grader`-shaped, and nothing here ever calls that).
//
// -----------------------------------------------------------------------------
// THE RETENTION ASSERTION QUERIES THE DATABASE, NOT THE UI OR THE API
// -----------------------------------------------------------------------------
//
// `helpers/db.ts` opens a direct Postgres connection for exactly one
// question: does a `storage_objects` row exist for a user this spec recorded
// audio for? A response carrying no `audio` field is consistent with
// `voice.md` §4's claim, but it is equally consistent with the upload having
// been written to `storage_objects` and simply not linked back into what the
// client happens to read — only the table itself can rule that out. See that
// file's own header for the full argument, and this issue's own task text:
// "a future refactor that spools the upload to disk 'temporarily' would pass
// every unit test in the repo" — it would also pass every assertion in this
// file that stops at the API. Every OTHER assertion below (inputMode,
// transcript, asr_confidence, retryOfAttemptId, progress counts) reads
// through the API on purpose, matching this directory's own house
// convention (`practice-questions.ts`'s header, `mock-interview-text.spec.ts`'s
// "verify through the one API surface that serves them") — the database is
// reserved for the one claim no API response can make.
//
// -----------------------------------------------------------------------------
// TEST ORDER, AND WHY THIS FILE USES `mode: 'serial'`
// -----------------------------------------------------------------------------
//
// AI configuration is one row (`system_settings.key = 'ai'`), shared by
// every learner and every spec file in this suite — the identical "GLOBAL
// STATE" `ai-evaluation.spec.ts`'s own header discusses. Test 1 needs
// `transcribe` UNBOUND; every test after Test 2 needs it BOUND. Rather than
// one giant test with numbered phases (that file's own shape), this file
// keeps one `test()` per scenario — closer to `mock-interview-text.spec.ts`'s
// per-case structure, and it reports failures per scenario rather than
// aborting the whole file at the first one — and forces them to run in
// file order, in one worker, with `test.describe.configure({ mode:
// 'serial' })`. `playwright.config.ts`'s own `fullyParallel: true` would
// otherwise be free to interleave or reorder tests within this file across
// workers, which would race two tests that both mutate the one shared AI
// settings row. `workers: 1` in CI (that file's own note) makes this
// unnecessary there; `serial` mode is what makes it true everywhere else too,
// including a plain local `npx playwright test`.
//
// This spec does not restore AI to a disabled state when it finishes, for
// the identical reason `ai-evaluation.spec.ts` does not: nothing later in
// this file, and nothing in any spec that would run after it alphabetically,
// depends on AI being off again.
//
// -----------------------------------------------------------------------------
// DETERMINISM: NO WALL-CLOCK OR ORDERING DEPENDENCE
// -----------------------------------------------------------------------------
//
// The one place an instant matters is Test 5's readiness staleness check
// (`GET /api/readiness` recomputes when the latest snapshot is older than
// the learner's most recent `practice_attempts.answeredAt`) — and it needs
// no `X-Test-Clock` header, because it depends only on ORDER (the baseline
// snapshot is read before the spoken attempt is recorded, so its
// `computedAt` is necessarily earlier), never on a specific wall-clock value
// or a same-day/window comparison. Every other scenario is driven by
// `FakeAiProvider`'s marker convention and `answer-matching.ts`'s exact-only
// rung 1, both content-independent of which of the ~100 seeded questions a
// Quick 5 happens to draw.
// =============================================================================

test.use({ permissions: ['microphone'] });

// -----------------------------------------------------------------------------
// The fake microphone's "recording" — installed once per test, before any
// navigation. See the file header for the full argument.
// -----------------------------------------------------------------------------

function installFakeMediaRecorder(): void {
  class FakeMediaRecorder extends EventTarget {
    static isTypeSupported(): boolean {
      return true;
    }

    stream: MediaStream;
    state: 'inactive' | 'recording' = 'inactive';
    mimeType = 'audio/webm';
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: (() => void) | null = null;

    constructor(stream: MediaStream) {
      super();
      this.stream = stream;
    }

    start(): void {
      this.state = 'recording';
    }

    stop(): void {
      if (this.state === 'inactive') return;
      this.state = 'inactive';

      const win = window as unknown as { __oathpathVoiceMarker?: string };
      // A safe, confident, non-empty default so a test that forgets to set
      // the marker gets a real (if generic) transcript rather than a
      // zero-byte blob `useAudioCapture` would report as `device_in_use`.
      const marker = win.__oathpathVoiceMarker ?? 'TRANSCRIPT:the constitution';
      const blob = new Blob([marker], { type: 'audio/webm' });

      this.ondataavailable?.({ data: blob });
      this.onstop?.();
    }
  }

  (window as unknown as { MediaRecorder: unknown }).MediaRecorder = FakeMediaRecorder;
}

/** Set the marker the NEXT recording will produce. See the file header. */
async function setVoiceMarker(page: Page, marker: string): Promise<void> {
  await page.evaluate((m) => {
    (window as unknown as { __oathpathVoiceMarker: string }).__oathpathVoiceMarker = m;
  }, marker);
}

// -----------------------------------------------------------------------------
// Wire shapes — the exact fields the DTOs cited beside each declare.
// -----------------------------------------------------------------------------

interface TranscribeOk {
  status: 'ok';
  text: string;
  confidence: number | null;
}
interface TranscribeUnavailable {
  status: 'unavailable';
  cause: string;
  role: string;
}
type TranscribeResponse = { data: TranscribeOk | TranscribeUnavailable };

interface PracticeAttemptRow {
  id: string;
  questionId: string;
  outcome: string;
  inputMode: 'typed' | 'spoken';
  promptMode: 'read' | 'heard';
  failureCause: string | null;
  transcript: string | null;
  asrConfidence: number | null;
  retryOfAttemptId: string | null;
}

interface SessionDetailResponse {
  data: {
    session: { id: string; status: string };
    nextQuestion: { id: string } | null;
    progress: { answered: number; planned: number };
    attempts: PracticeAttemptRow[];
  };
}

interface MeResponse {
  data: { id: string };
}

interface ReadinessResponse {
  data: {
    score: number;
    capReason: 'typed_only' | null;
    components: { spoken: { value: number } };
    evidenceCounts: { spoken: { attempts: number } };
    topRecommendation: { componentKey: string | null; title: string; reason: string };
  };
}

interface AiStatusResponse {
  data: { systemReady: boolean; unboundRoles: string[] };
}

// -----------------------------------------------------------------------------
// A fresh, obviously-fake test email per scenario.
// -----------------------------------------------------------------------------

function testEmail(label: string): string {
  return `voice-${label}-${randomUUID()}@test.local`;
}

/** A key that is obviously fake and obviously not a real OpenAI secret. */
const FAKE_SERVER_KEY = 'sk-e2e-fake-server-key-not-real-voice';

/** `FAKE_MODEL_IDS` entries `model-classifier.ts` sorts into each family. */
const TUTOR_MODEL = 'gpt-5.4';
const GRADER_MODEL = 'gpt-5.4-mini';
const TRANSCRIBE_MODEL = 'gpt-4o-transcribe';
const SPEAK_MODEL = 'tts-1-hd';

/** Every user id this file creates, so the final retention check covers all of them. */
const createdUserIds: string[] = [];

// -----------------------------------------------------------------------------
// API helpers
// -----------------------------------------------------------------------------

/**
 * `PUT /api/ai-settings`, as the admin whose bearer token is passed. A
 * REPLACE, not a merge — see this file's header on why the exact `models`
 * map matters as much as which fields are present.
 */
async function putAiSettings(
  page: Page,
  accessToken: string,
  body: {
    provider: 'openai' | null;
    enabled: boolean;
    apiKey?: string;
    models?: Record<string, string>;
  },
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

async function fetchUserId(page: Page, headers: Record<string, string>): Promise<string> {
  const response = await page.request.get('/api/auth/me', { headers });
  expect(response.ok(), 'GET /api/auth/me').toBe(true);
  const body = (await response.json()) as MeResponse;
  return body.data.id;
}

async function fetchSessionDetail(
  page: Page,
  headers: Record<string, string>,
  sessionId: string,
): Promise<SessionDetailResponse['data']> {
  const response = await page.request.get(`/api/practice/sessions/${sessionId}`, { headers });
  expect(response.ok(), 'GET /api/practice/sessions/:id').toBe(true);
  const body = (await response.json()) as SessionDetailResponse;
  return body.data;
}

async function fetchReadiness(
  page: Page,
  headers: Record<string, string>,
): Promise<ReadinessResponse['data']> {
  const response = await page.request.get('/api/readiness', { headers });
  expect(response.ok(), 'GET /api/readiness').toBe(true);
  const body = (await response.json()) as ReadinessResponse;
  return body.data;
}

// -----------------------------------------------------------------------------
// UI helpers — `/practice` -> "Start a Quick 5" -> `/practice/sessions/:id`,
// the identical entry point `ai-evaluation.spec.ts` uses.
// -----------------------------------------------------------------------------

async function startQuickFive(page: Page): Promise<string> {
  await page.goto('/practice');
  await expect(page.getByRole('heading', { level: 1, name: 'Practice' })).toBeVisible();
  await page.getByRole('button', { name: 'Start a Quick 5' }).click();
  await expect(page).toHaveURL(/\/practice\/sessions\/[0-9a-f-]{36}$/);
  const sessionId = page.url().split('/').pop();
  if (!sessionId) {
    throw new Error('startQuickFive: could not read the session id off the URL');
  }
  return sessionId;
}

/** The current question's id and its first accepted answer — the PUBLIC way. */
async function currentQuestionAndAnswer(
  page: Page,
  headers: Record<string, string>,
  sessionId: string,
): Promise<{ questionId: string; acceptedAnswer: string }> {
  const questionId = await fetchNextQuestionId(page, headers, sessionId);
  const acceptedAnswer = await fetchAcceptedAnswer(page, headers, questionId);
  return { questionId, acceptedAnswer };
}

/**
 * Switch to the microphone, record one "answer" carrying `marker`, and wait
 * for the transcript to land — returning the raw
 * `POST /api/ai/speech/transcribe` response body so a caller can assert on
 * it directly (Tests 3 and 6 read `confidence`; Test 6 also reads the whole
 * body to prove no `audio` field is on it).
 *
 * Assumes the "Speak" toggle is already visible (i.e. `transcribe` is
 * bound) — a caller asserting the UNBOUND state never calls this.
 */
async function recordSpokenAnswer(
  page: Page,
  marker: string,
): Promise<TranscribeOk> {
  // Always clicked, never conditionally: MUI's exclusive `ToggleButtonGroup`
  // reports `next: null` (a no-op — see `PracticeSessionPage.tsx`'s own
  // comment) when the already-selected button is pressed again, so this is
  // safe whether this is the first switch to voice or a later question that
  // is already in voice mode. Waiting for it here (rather than a one-shot
  // `isVisible()` check) is what makes this safe to call the moment a
  // question first renders, before `AiStatusProvider`'s own fetch has
  // necessarily resolved.
  const speakToggle = page.getByRole('button', { name: 'Speak', exact: true });
  await expect(speakToggle).toBeVisible();
  await speakToggle.click();

  const idle = page.getByRole('button', { name: 'Hold to record' });
  await expect(idle).toBeVisible();

  await setVoiceMarker(page, marker);

  const responsePromise = page.waitForResponse(
    (res) => res.url().includes('/api/ai/speech/transcribe') && res.request().method() === 'POST',
  );

  // Space/Enter TOGGLES (`PushToTalkButton.tsx`'s own header) — press once to
  // start, once to stop. Two sequential `.press()` calls on a synchronous
  // fake recorder need no wait between them.
  await idle.press('Enter');
  const recording = page.getByRole('button', { name: 'Recording — press to stop' });
  await expect(recording).toBeVisible();
  await recording.press('Enter');

  const response = await responsePromise;
  const body = (await response.json()) as TranscribeResponse;
  if (body.data.status !== 'ok') {
    throw new Error(
      `recordSpokenAnswer: transcription was not "ok" — ${JSON.stringify(body.data)}`,
    );
  }
  return body.data;
}

/** Confirm the landed transcript (or a corrected version of it) and submit. */
async function confirmTranscript(page: Page, text: string): Promise<void> {
  const field = page.getByLabel('Your answer');
  await expect(field).toHaveValue(text);
  await page.getByRole('button', { name: 'Use this answer' }).click();
}

const VERDICT_REGION_TIMEOUT = 10_000;

// =============================================================================
// TEST 1 (scenario 4) — `transcribe` unbound: text mode, and #43 names the role
// =============================================================================

test.describe('Voice foundation (issue #114), epic #58 (E9)', () => {
  test.describe.configure({ mode: 'serial' });

  test('with `transcribe` unbound, a session runs entirely in text and the missing role is named to an admin', async ({
    page,
  }) => {
    // Admin, because `AiNotReady`'s admin-only naming line
    // ("As an administrator: no model is bound to transcribe.") is the
    // concrete, on-screen proof that the role is actually named — not merely
    // that the code follows the convention. Admin status does not change
    // anything about this learner's own journey/practice flow (`CLAUDE.md`'s
    // RBAC section; `civics-learn.spec.ts` logs an admin into `/` the
    // identical way).
    const email = testEmail('unbound');
    const { accessToken } = await seedOnboarding(page, {
      email,
      role: 'admin',
      onboarding: 'full',
    });
    const headers = { Authorization: `Bearer ${accessToken}` };
    await page.waitForURL('/', { timeout: 10000 });
    createdUserIds.push(await fetchUserId(page, headers));

    // `tutor`/`grader` bound (systemReady: true — AI, in general, is fully
    // configured) but `transcribe`/`speak` are not: this is the state the
    // issue's own hint describes, and it proves the mic's absence is because
    // of `transcribe` specifically, not because AI is off wholesale.
    await putAiSettings(page, accessToken, {
      provider: 'openai',
      enabled: true,
      apiKey: FAKE_SERVER_KEY,
      models: { tutor: TUTOR_MODEL, grader: GRADER_MODEL },
    });

    const statusResponse = await page.request.get('/api/ai/status', { headers });
    expect(statusResponse.ok(), 'GET /api/ai/status').toBe(true);
    const status = ((await statusResponse.json()) as AiStatusResponse).data;
    expect(status.systemReady, 'tutor+grader bound -> systemReady').toBe(true);
    expect(status.unboundRoles).toContain('transcribe');

    const sessionId = await startQuickFive(page);
    await expect(page.getByRole('heading', { level: 2 })).toBeVisible();

    // NO MICROPHONE, NO TOGGLE. `PracticeSessionPage.tsx`'s own comment:
    // "the toggle appears only where speaking is actually possible."
    await expect(page.getByRole('button', { name: 'Speak', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Hold to record' })).toHaveCount(0);

    // `VoiceUnavailableNotice` -> `AiNotReady role="transcribe"`.
    await expect(
      page.getByText('Answering out loud is not available yet', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(
        'Your administrator has not finished setting up the AI models. Nothing is wrong on your side.',
      ),
    ).toBeVisible();
    // THE ONE SENTENCE `AiNotReady` EXISTS FOR.
    await expect(page.getByText('This is not a problem with your key.')).toBeVisible();
    // THE ROLE, NAMED — not "some models", and only because this learner is
    // an admin.
    await expect(
      page.getByText('As an administrator: no model is bound to', { exact: false }),
    ).toBeVisible();
    // A MUI `Button` rendered `component={RouterLink}` is an `<a>` under the
    // hood, so its accessible role is `link` — the same pattern
    // `mock-interview-text.spec.ts`'s own "Start a mock interview" locator
    // relies on for the identical reason.
    await expect(page.getByRole('link', { name: 'Open AI settings' })).toHaveAttribute(
      'href',
      '/admin/settings/ai',
    );

    // The session is still a COMPLETE, working, text-mode session: type the
    // real accepted answer and get a real, correctly-graded attempt.
    const { questionId, acceptedAnswer } = await currentQuestionAndAnswer(
      page,
      headers,
      sessionId,
    );
    await page.getByLabel('Your answer').fill(acceptedAnswer);
    await page.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(page.getByText('Correct', { exact: true })).toBeVisible({
      timeout: VERDICT_REGION_TIMEOUT,
    });

    const detail = await fetchSessionDetail(page, headers, sessionId);
    const attempt = detail.attempts.find((a) => a.questionId === questionId);
    if (!attempt) throw new Error('the typed attempt was not recorded');
    expect(attempt.inputMode).toBe('typed');
    expect(attempt.transcript).toBeNull();
    expect(attempt.asrConfidence).toBeNull();
    expect(attempt.outcome).toBe('correct');
  });

  // ===========================================================================
  // TEST 2 — an administrator binds `transcribe` and `speak`
  // ===========================================================================
  //
  // Not one of the six numbered scenarios on its own, but a real assertion —
  // `GET /api/ai/status` actually reflects the write — and the pivot every
  // test after this one depends on. See the file header for why `grader` is
  // deliberately left OUT of this replace.

  test('an administrator binds `transcribe` and `speak` (setup for tests 3-6)', async ({
    page,
  }) => {
    const email = testEmail('config-admin');
    const { accessToken } = await seedOnboarding(page, {
      email,
      role: 'admin',
      onboarding: 'full',
    });
    await page.waitForURL('/', { timeout: 10000 });
    const headers = { Authorization: `Bearer ${accessToken}` };
    createdUserIds.push(await fetchUserId(page, headers));

    await putAiSettings(page, accessToken, {
      provider: 'openai',
      enabled: true,
      apiKey: FAKE_SERVER_KEY,
      models: { transcribe: TRANSCRIBE_MODEL, speak: SPEAK_MODEL },
    });

    const statusResponse = await page.request.get('/api/ai/status', { headers });
    expect(statusResponse.ok(), 'GET /api/ai/status').toBe(true);
    const status = ((await statusResponse.json()) as AiStatusResponse).data;
    expect(status.unboundRoles).not.toContain('transcribe');
    expect(status.unboundRoles).not.toContain('speak');
    // The other half of §1's independence claim, from the direction Test 1
    // did not show: voice fully bound, and `systemReady` UNAFFECTED by it —
    // `tutor`/`grader` are unbound again (this PUT replaced Test 1's row),
    // so `systemReady` reads false here precisely because it never consulted
    // `transcribe`/`speak` in the first place.
    expect(status.systemReady).toBe(false);
  });

  // ===========================================================================
  // TEST 3 (scenarios 1 and 6) — a spoken attempt end to end, and nothing is
  // stored anywhere
  // ===========================================================================

  test('a spoken attempt end to end: confirm, grade, and no audio is retained anywhere', async ({
    page,
  }) => {
    await page.addInitScript(installFakeMediaRecorder);

    const email = testEmail('spoken');
    const { accessToken } = await seedOnboarding(page, { email, onboarding: 'full' });
    await page.waitForURL('/', { timeout: 10000 });
    const headers = { Authorization: `Bearer ${accessToken}` };
    const userId = await fetchUserId(page, headers);
    createdUserIds.push(userId);

    const sessionId = await startQuickFive(page);
    const { questionId, acceptedAnswer } = await currentQuestionAndAnswer(
      page,
      headers,
      sessionId,
    );

    const transcription = await recordSpokenAnswer(page, `TRANSCRIPT:${acceptedAnswer}`);
    expect(transcription.text).toBe(acceptedAnswer);
    // Confident (`CONFIDENT_SCORE`, `fake-ai.provider.ts`) — a plain
    // `TRANSCRIPT:` marker with no `LOWCONF` never produces a low score.
    expect(transcription.confidence).toBeCloseTo(0.97, 5);

    // -------------------------------------------------------------------
    // SCENARIO 6, first half: the transcribe response carries no audio.
    // -------------------------------------------------------------------
    expect(transcription).not.toHaveProperty('audio');
    expect(JSON.stringify(transcription).length).toBeLessThan(500);

    // Confirmation copy for a CONFIDENT transcript — never the low-confidence
    // wording, and never the raw number.
    await expect(page.getByText('Is this what you said?', { exact: true })).toBeVisible();
    expect(await page.locator('body').innerHTML()).not.toContain('0.97');

    // Nothing graded until the learner presses the button.
    await confirmTranscript(page, acceptedAnswer);
    await expect(page.getByText('Correct', { exact: true })).toBeVisible({
      timeout: VERDICT_REGION_TIMEOUT,
    });

    // -------------------------------------------------------------------
    // SCENARIO 1: the stored attempt, read back through the API.
    // -------------------------------------------------------------------
    const detail = await fetchSessionDetail(page, headers, sessionId);
    const attempt = detail.attempts.find((a) => a.questionId === questionId);
    if (!attempt) throw new Error('the spoken attempt was not recorded');
    expect(attempt.inputMode).toBe('spoken');
    expect(attempt.transcript).toBe(acceptedAnswer);
    expect(attempt.asrConfidence).toBeCloseTo(0.97, 5);
    expect(attempt.outcome).toBe('correct');
    expect(attempt.failureCause).toBeNull();

    // -------------------------------------------------------------------
    // SCENARIO 6, second half: the database, not the API or the UI.
    // -------------------------------------------------------------------
    expect(
      await countStorageObjectsUploadedBy([userId]),
      'no storage_objects row for a learner who only ever spoke into practice',
    ).toBe(0);
  });

  // ===========================================================================
  // TEST 4 (scenario 2) — a low-confidence transcription is a retry, not a
  // bare incorrect
  // ===========================================================================

  test('a low-confidence transcription is offered a retry, and the correction supersedes it as one question', async ({
    page,
  }) => {
    await page.addInitScript(installFakeMediaRecorder);

    const email = testEmail('misheard');
    const { accessToken } = await seedOnboarding(page, { email, onboarding: 'full' });
    await page.waitForURL('/', { timeout: 10000 });
    const headers = { Authorization: `Bearer ${accessToken}` };
    const userId = await fetchUserId(page, headers);
    createdUserIds.push(userId);

    const sessionId = await startQuickFive(page);
    const { questionId, acceptedAnswer } = await currentQuestionAndAnswer(
      page,
      headers,
      sessionId,
    );

    // The `LOWCONF` marker, with no `TRANSCRIPT:` override, produces the
    // fixture's own near-miss text at 0.41 confidence — comfortably below
    // `ASR_CONFIDENCE_THRESHOLD` (0.6).
    const misheard = await recordSpokenAnswer(page, 'LOWCONF');
    expect(misheard.text).toBe('the head of the executive ranch');
    expect(misheard.confidence).toBeCloseTo(0.41, 5);

    // The INVITATION TO CORRECT, not a plain "is this right?" — and never the
    // raw number.
    await expect(page.getByText('That may not be what you said.', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Record again' })).toBeVisible();
    expect(await page.locator('body').innerHTML()).not.toContain('0.41');

    // The learner does not notice, and confirms it AS-IS — §3.1's second
    // branch, the one this scenario is built to exercise.
    await confirmTranscript(page, 'the head of the executive ranch');

    // NOT AN INCORRECT-AND-DONE VERDICT. `answer-matching.ts`'s exact-only
    // rung 1 (see the file header) means this garbled text cannot match ANY
    // accepted answer, for any question this Quick 5 happened to draw — so
    // the deterministic outcome is `incorrect`, plainly labelled...
    await expect(page.getByText('Not a match', { exact: true })).toBeVisible({
      timeout: VERDICT_REGION_TIMEOUT,
    });
    // ...but with RECOURSE, which is the concrete proof this is not a bare,
    // final "wrong": `canAnswerAgain` is the server's own verdict
    // (`failureCause: 'misheard'`), read back and rendered here.
    const answerAgain = page.getByRole('button', { name: 'Answer again' });
    await expect(answerAgain).toBeVisible();
    await expect(
      page.getByText(
        'We may have misheard you rather than you getting it wrong. Trying again replaces this attempt, and does not count as a second question.',
      ),
    ).toBeVisible();

    const midDetail = await fetchSessionDetail(page, headers, sessionId);
    const original = midDetail.attempts.find((a) => a.questionId === questionId);
    if (!original) throw new Error('the misheard attempt was not recorded');
    expect(original.failureCause).toBe('misheard');
    expect(original.retryOfAttemptId).toBeNull();
    // The SAME question is still on screen — the server never advanced past
    // a misheard attempt on its own.
    expect(midDetail.nextQuestion?.id).toBe(questionId);

    // The retry: this time a confident, correct transcript.
    await answerAgain.click();
    await expect(page.getByRole('heading', { level: 2 })).toBeVisible();

    const retry = await recordSpokenAnswer(page, `TRANSCRIPT:${acceptedAnswer}`);
    expect(retry.text).toBe(acceptedAnswer);
    await confirmTranscript(page, acceptedAnswer);
    await expect(page.getByText('Correct', { exact: true })).toBeVisible({
      timeout: VERDICT_REGION_TIMEOUT,
    });

    // -------------------------------------------------------------------
    // THE LINK, AND THE ONE-QUESTION COUNT — both read through the API.
    // -------------------------------------------------------------------
    const finalDetail = await fetchSessionDetail(page, headers, sessionId);
    const retryAttempt = finalDetail.attempts.find(
      (a) => a.questionId === questionId && a.id !== original.id,
    );
    if (!retryAttempt) throw new Error('the retry attempt was not recorded');
    expect(retryAttempt.retryOfAttemptId).toBe(original.id);
    expect(retryAttempt.outcome).toBe('correct');
    expect(retryAttempt.inputMode).toBe('spoken');

    // The original is STILL THERE — evidence is never deleted (§3.2) — and
    // the pair reads as ONE answered question, never two.
    const stillThere = finalDetail.attempts.find((a) => a.id === original.id);
    expect(stillThere).toBeDefined();
    expect(finalDetail.progress.answered).toBe(1);

    expect(
      await countStorageObjectsUploadedBy([userId]),
      'no storage_objects row for either the misheard recording or its retry',
    ).toBe(0);
  });

  // ===========================================================================
  // TEST 5 (scenario 3) — the `spoken` readiness component and the cap
  // message move once real evidence exists
  // ===========================================================================

  test('the `spoken` readiness component rises above zero and the cap message changes text', async ({
    page,
  }) => {
    await page.addInitScript(installFakeMediaRecorder);

    const email = testEmail('readiness');
    const { accessToken } = await seedOnboarding(page, { email, onboarding: 'full' });
    await page.waitForURL('/', { timeout: 10000 });
    const headers = { Authorization: `Bearer ${accessToken}` };
    const userId = await fetchUserId(page, headers);
    createdUserIds.push(userId);

    const CAP_TITLE = 'Limited interview practice';
    const CAP_REASON =
      'Your civics knowledge is strong, but you have limited interview practice. ' +
      'Completing two mock interviews is the best way to strengthen your readiness now.';

    // ---------------------------------------------------------------------
    // BASELINE — a fresh learner, zero spoken evidence, `typed_only`.
    // ---------------------------------------------------------------------
    const baseline = await fetchReadiness(page, headers);
    expect(baseline.capReason).toBe('typed_only');
    expect(baseline.evidenceCounts.spoken.attempts).toBe(0);
    expect(baseline.components.spoken.value).toBe(0);
    expect(baseline.topRecommendation).toEqual({
      componentKey: null,
      title: CAP_TITLE,
      reason: CAP_REASON,
    });

    await page.goto('/progress');
    await expect(page.getByText(CAP_TITLE, { exact: true })).toBeVisible();
    await expect(page.getByText(CAP_REASON, { exact: true })).toBeVisible();
    const readinessRegion = page.getByRole('region', { name: 'Readiness' });
    const spokenLabelBefore = readinessRegion.getByText('Spoken practice', { exact: true });
    await expect(spokenLabelBefore).toBeVisible();
    await expect(
      spokenLabelBefore.locator('xpath=following-sibling::*[1]'),
    ).toHaveText('No evidence yet');

    // ---------------------------------------------------------------------
    // ONE CORRECT SPOKEN ANSWER — the only thing `spoken`'s formula
    // (`min(distinctQuestionsCorrectSpoken / 20, 1)`) needs to move off zero.
    // ---------------------------------------------------------------------
    const sessionId = await startQuickFive(page);
    const { acceptedAnswer } = await currentQuestionAndAnswer(page, headers, sessionId);
    await recordSpokenAnswer(page, `TRANSCRIPT:${acceptedAnswer}`);
    await confirmTranscript(page, acceptedAnswer);
    await expect(page.getByText('Correct', { exact: true })).toBeVisible({
      timeout: VERDICT_REGION_TIMEOUT,
    });

    // ---------------------------------------------------------------------
    // AFTER — `GET /api/readiness` recomputes because this attempt's
    // `answeredAt` is necessarily later than the baseline snapshot's
    // `computedAt` (no clock header needed — see the file header).
    // ---------------------------------------------------------------------
    const after = await fetchReadiness(page, headers);
    expect(after.evidenceCounts.spoken.attempts).toBe(1);
    // `Math.round(min(1/20, 1) * 100)` = 5.
    expect(after.components.spoken.value).toBeCloseTo(0.05, 5);
    expect(after.capReason).toBeNull();
    expect(after.topRecommendation.componentKey).not.toBeNull();
    expect(after.topRecommendation.title).not.toBe(CAP_TITLE);

    await page.goto('/progress');
    await expect(page.getByText(CAP_TITLE, { exact: true })).toHaveCount(0);
    await expect(page.getByText(CAP_REASON, { exact: true })).toHaveCount(0);
    const readinessRegionAfter = page.getByRole('region', { name: 'Readiness' });
    await expect(
      readinessRegionAfter.getByText('Spoken practice', { exact: true }),
    ).toBeVisible();
    // A real percentage now, not "No evidence yet".
    const spokenLabel = readinessRegionAfter.getByText('Spoken practice', { exact: true });
    const spokenValue = spokenLabel.locator('xpath=following-sibling::*[1]');
    await expect(spokenValue).toHaveText('5%');

    expect(await countStorageObjectsUploadedBy([userId])).toBe(0);
  });

  // ===========================================================================
  // TEST 6 (scenario 5) — switching voice -> text mid-session preserves
  // progress
  // ===========================================================================

  test('switching from voice to text mid-session keeps the session, the progress counter, and every recorded attempt', async ({
    page,
  }) => {
    await page.addInitScript(installFakeMediaRecorder);

    const email = testEmail('switch');
    const { accessToken } = await seedOnboarding(page, { email, onboarding: 'full' });
    await page.waitForURL('/', { timeout: 10000 });
    const headers = { Authorization: `Bearer ${accessToken}` };
    const userId = await fetchUserId(page, headers);
    createdUserIds.push(userId);

    const sessionId = await startQuickFive(page);

    // Question 1, answered by TYPING — establishes a real, already-answered
    // question before the toggle is ever touched, matching
    // `PracticeSessionPage.voice.test.tsx`'s own "resumed with one question
    // already answered" setup.
    const q1 = await currentQuestionAndAnswer(page, headers, sessionId);
    await page.getByLabel('Your answer').fill(q1.acceptedAnswer);
    await page.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(page.getByText('Correct', { exact: true })).toBeVisible({
      timeout: VERDICT_REGION_TIMEOUT,
    });
    await page.getByRole('button', { name: 'Next question' }).click();

    // Question 2: toggle to Speak WITHOUT recording anything, then back to
    // Type. Nothing about the session should move.
    await expect(page.getByText('Question 2 of 5', { exact: true })).toBeVisible();
    const q2 = await currentQuestionAndAnswer(page, headers, sessionId);

    await page.getByRole('button', { name: 'Speak', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Hold to record' })).toBeVisible();
    await expect(page.getByText('Question 2 of 5', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Type', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Hold to record' })).toHaveCount(0);
    await expect(page.getByText('Question 2 of 5', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Your answer')).toBeEnabled();

    // And the session still records against the question it was on — typed,
    // never `spoken`, because nothing was ever recorded.
    await page.getByLabel('Your answer').fill(q2.acceptedAnswer);
    await page.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(page.getByText('Correct', { exact: true })).toBeVisible({
      timeout: VERDICT_REGION_TIMEOUT,
    });

    const detail = await fetchSessionDetail(page, headers, sessionId);
    expect(detail.progress.answered).toBe(2);
    const attempt1 = detail.attempts.find((a) => a.questionId === q1.questionId);
    const attempt2 = detail.attempts.find((a) => a.questionId === q2.questionId);
    if (!attempt1 || !attempt2) throw new Error('one of the two attempts was not recorded');
    expect(attempt1.inputMode).toBe('typed');
    expect(attempt2.inputMode).toBe('typed');
    expect(attempt1.outcome).toBe('correct');
    expect(attempt2.outcome).toBe('correct');

    expect(await countStorageObjectsUploadedBy([userId])).toBe(0);
  });

  test.afterAll(async () => {
    // A whole-file sweep across every learner this spec created, on top of
    // each test's own per-user check — cheap, and it catches a leak that
    // somehow only shows up in combination.
    expect(
      await countStorageObjectsUploadedBy(createdUserIds),
      'no storage_objects row for any learner this spec created',
    ).toBe(0);
    await closeDbPool();
  });
});

// =============================================================================
// UNTOUCHED FILES
// =============================================================================
//
// This change adds `voice.spec.ts` and `helpers/db.ts`, and edits
// `playwright.config.ts` (the two Chromium flags) and `tests/e2e/package.json`
// / `package-lock.json` (the `pg` dependency the database helper needs).
// Every other file under `tests/e2e/` is untouched, including the OAuth,
// mock-interview, memory, habit, civics-learn, journey-shell and
// practice-session specs — none of them is imported by, or shares any
// mutable state with, this file beyond the same `system_settings.key = 'ai'`
// row `ai-evaluation.spec.ts` already documents writing to.
// =============================================================================
