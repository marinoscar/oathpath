import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { seedOnboarding } from '../helpers/auth.helper';
import { fetchAcceptedAnswer, fetchNextQuestionId } from '../helpers/practice-questions';
import { closeDbPool, countEnglishAttemptsByUser } from '../helpers/db';
import { installFakeMediaRecorder, setVoiceMarker } from '../helpers/fake-media-recorder';

// =============================================================================
// english.spec.ts — issue #149, epic #59 / E10 "Reading and writing tests"
// =============================================================================
//
// `docs/specs/english-test.md` is the design this spec is checked against —
// §2 (WER scoring: the compound `errors`-then-`wer` outcome rule), §3 (the
// accent rule: confirm-before-grade, and `misheard` as the absence of a
// recorded row rather than a `failureCause` on one that exists), §4 (writing
// is dictated, never shown, before submission), §6 (the `english` readiness
// component and why it never lifts the `typed_only` structural cap). The
// seven scenarios below map onto the issue's own numbering:
//
//   1. Reading: nothing is scored before confirm, and the EDITED text is
//      what gets scored, never the recogniser's raw guess          -> §3
//   2. The per-word diff: a near miss inside tolerance is a pass, and the
//      correction is a real, in-order text node — never colour-only -> §2, §9
//   3. Low confidence -> `misheard`, and NO `english_attempts` row at all,
//      proven against the database, not the API                     -> §3
//   4. Writing: the sentence is never in the DOM before submission,
//      and is revealed only after                                   -> §4
//   5. No `speak` binding: dictation still works, on the browser's own
//      voice, and `POST /api/ai/speech/synthesize` is never called   -> §4, voice.md §2
//   6. Replays are counted accurately, and never gate the outcome    -> §4
//   7. The `english` readiness component rises above zero, and does NOT
//      lift the `typed_only` structural cap                         -> §6, §6.3
//
// -----------------------------------------------------------------------------
// EXECUTION
// -----------------------------------------------------------------------------
//
// Every selector, route, copy string and DTO field below was read directly
// out of the shipped source cited beside it — `apps/web/src/pages/
// ReadingPracticePage.tsx`, `WritingPracticePage.tsx`, `apps/web/src/
// components/english/SentenceDiff.tsx`, `apps/web/src/components/voice/
// QuestionAudio.tsx`, `apps/api/src/english/english.controller.ts` and its
// DTOs, `apps/api/src/english/english.service.ts` (`isMisheardReading`),
// `apps/api/src/readiness/readiness-engine.ts` (`computeEnglish`), and
// `apps/api/src/readiness/readiness.service.ts` (the staleness rule) — never
// invented or guessed. `npx tsc --noEmit -p tests/e2e/tsconfig.json` passes
// clean (see the report handed back with this file). This sandbox has no
// daemon for `playwright.config.ts`'s own `webServer` (`docker compose`) and
// no reachable API at `http://localhost:3535`, so the suite itself was **not
// executed** — the same limitation `voice.spec.ts`'s own header states for
// the identical reason, and `ROADMAP.md` footnotes for every epic.
//
// -----------------------------------------------------------------------------
// NO API KEY, NO REAL MICROPHONE, NO REAL VOICE — HOW, AND WHAT THAT COSTS
// -----------------------------------------------------------------------------
//
// `AI_PROVIDER_FAKE=true` (non-production only) substitutes `FakeAiProvider`
// for `OpenAiProvider` at the DI layer, exactly as `voice.spec.ts`'s own
// header documents — an ENVIRONMENT requirement this file cannot set for
// itself. The microphone is `voice.spec.ts`'s own stub, extracted verbatim
// into `../helpers/fake-media-recorder.ts` for this file to import rather
// than reimplement (that file's own header explains why it is a new shared
// module rather than an import from `voice.spec.ts` directly — spec files do
// not import each other in this suite).
//
// `window.speechSynthesis` is a THIRD stub this file adds, `installFake
// SpeechSynthesis` below, and it is worth being precise about what it does
// and does not prove. Chromium (even headless, even with this suite's own
// `--autoplay-policy=no-user-gesture-required` flag already in
// `playwright.config.ts` for exactly this API) exposes real
// `speechSynthesis`/`SpeechSynthesisUtterance` objects, but a sandboxed,
// headless container commonly has NO REGISTERED TTS VOICE for them to speak
// with — `speechSynthesis.speak()` on such a setup can simply never fire
// `onstart`/`onend` at all, which would hang every assertion in this file
// that waits on those events rather than fail one cleanly. So this file
// replaces both objects outright with a synchronous fake that fires
// `onstart` then `onend` on a couple of macrotask ticks, deterministically,
// on every `.speak()` call.
//
// What this DOES prove: `QuestionAudio`'s own client-side logic — `onPlayed`
// firing only when audio actually starts (never on a bare click), the
// play-count arithmetic `replayCount = plays - 1`, the button's label
// changing from "Play the sentence" to "Play it again", and — the one this
// epic's scenario 5 turns on — that `usePremium` is false and the premium
// `POST /api/ai/speech/synthesize` path is never reached when `speak` is
// unbound, so the ONLY speech path exercised is the browser one under test.
//
// What this does NOT prove: that a real device with a real voice actually
// produces audible sound, or that a real `speechSynthesis` implementation
// fires its events in the same order/timing on every platform. Those are
// real-browser, real-hardware facts no headless CI run — stubbed or not —
// can settle, and this file does not claim to settle them.
//
// -----------------------------------------------------------------------------
// THE MARKER CONVENTION FOR READING — REUSED FROM `voice.spec.ts` VERBATIM
// -----------------------------------------------------------------------------
//
// `fake-ai.provider.ts`'s own header: the "recording" is read as latin1 and
// searched for `TRANSCRIPT:<text>` and `LOWCONF`. `TRANSCRIPT:<text>` yields
// `<text>` at confidence 0.97 (`CONFIDENT_SCORE`); a bare `LOWCONF` yields the
// fixed decoy `"the head of the executive ranch"` at confidence 0.41
// (`LOW_CONFIDENCE_SCORE`) — both content-independent of which reading
// sentence this suite's deterministic, unseen-first selector happens to draw.
//
// -----------------------------------------------------------------------------
// WHY THE NEAR-MISS SUBSTITUTES A WORD RATHER THAN DROPPING ONE
// -----------------------------------------------------------------------------
//
// `english-sentences.json`'s sentences run 3-8 tokens after normalisation
// (§2.3), so a single word-for-word SUBSTITUTION anywhere but the sentence's
// own first word is guaranteed `errors === 1` and `wer <= 1/3 = 0.333 <=
// WER_CORRECT_MAX (0.34)` — a `correct` outcome regardless of exactly which
// sentence the selector draws, with no need to know its text in advance or
// to special-case its length. `pickSubstitutionWord` below additionally
// avoids the sentence's leading word (§2.1's article-drop is leading-only,
// so touching it cannot desynchronise reference/hypothesis) and avoids short
// or abbreviation-prone words (`president`, `united`, `states`, `usa`, `u`,
// `s`, `d`, `c`, `potus` — §1.2's own worked caution about the abbreviation
// table's multi-word collapses), so the one substitution this file makes is
// never the one word `normalizeAnswer`'s abbreviation table could silently
// expand into more than one reference token.
//
// -----------------------------------------------------------------------------
// THE `misheard`-WRITES-NOTHING CLAIM IS PROVEN AGAINST THE DATABASE
// -----------------------------------------------------------------------------
//
// Identical reasoning to `voice.spec.ts`'s own "THE RETENTION ASSERTION
// QUERIES THE DATABASE, NOT THE UI OR THE API" section: a `misheard` response
// carrying no `attemptId` is consistent with §3's claim that nothing was
// written, but it is EQUALLY consistent with a row having been written
// anyway and simply not linked back into the response. Only
// `countEnglishAttemptsByUser` (`../helpers/db.ts`, added by this issue for
// the identical structural reason `countStorageObjectsUploadedBy` already
// exists) settles it. Every other assertion in this file reads through the
// API or the DOM, matching this directory's own house convention.
//
// -----------------------------------------------------------------------------
// WHY THE READINESS TEST FORCES A TYPED CIVICS ATTEMPT
// -----------------------------------------------------------------------------
//
// `readiness.service.ts`'s `getLatestOrRecompute`, read directly: an existing
// snapshot is recomputed lazily on `GET /api/readiness` ONLY when the
// caller's most recent `practice_attempts.answeredAt` is newer than the
// snapshot's own `computedAt` — that staleness check reads `practice_attempts`
// alone, never `english_attempts` (`english-test.md` §6.5: "no new recompute
// trigger... the next nightly pass or the next stale-on-read check picks it
// up"). A learner with English evidence but zero civics practice would
// therefore never see a second, on-demand recompute pick it up in this test's
// own lifetime — there being no nightly cron in this sandbox — so Test 7
// answers exactly one civics question after recording its English attempts,
// purely to produce a newer `practice_attempts` row and trigger the existing
// stale-on-read path. `computeAndPersistSnapshot` itself reassembles ALL
// evidence fresh, English included, regardless of which trigger fired it.
//
// -----------------------------------------------------------------------------
// TEST ORDER, AND WHY THIS FILE USES `mode: 'serial'`
// -----------------------------------------------------------------------------
//
// AI configuration is one row (`system_settings.key = 'ai'`), shared by every
// learner and every spec file in this suite — the identical "GLOBAL STATE"
// `ai-evaluation.spec.ts` and `voice.spec.ts` both already document. Test 0
// below binds `transcribe` and deliberately leaves `speak` UNBOUND — the
// exact state scenario 5 needs — and every reading test after it depends on
// `transcribe` staying bound. `test.describe.configure({ mode: 'serial' })`
// keeps this file's own tests from being reordered or interleaved by
// `playwright.config.ts`'s `fullyParallel: true`. It cannot, and does not
// try to, prevent a DIFFERENT spec file running in a different worker from
// mutating the same row concurrently — `voice.spec.ts`'s own header accepts
// the identical cross-file risk, and `workers: 1` in CI (that file's own
// note) is what actually forecloses it there.
//
// This spec does not restore AI to a disabled state when it finishes, for
// the identical reason `voice.spec.ts` does not: nothing later in this file,
// and nothing in any spec that would run after it alphabetically, depends on
// AI being off again.
// =============================================================================

test.use({ permissions: ['microphone'] });

// -----------------------------------------------------------------------------
// The fake `window.speechSynthesis` — see the file header for what this does
// and does not prove.
// -----------------------------------------------------------------------------

function installFakeSpeechSynthesis(): void {
  class FakeUtterance extends EventTarget {
    text: string;
    rate = 1;
    onstart: (() => void) | null = null;
    onend: (() => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;

    constructor(text: string) {
      super();
      this.text = text;
    }
  }

  const fakeSynthesis = {
    speak(utterance: FakeUtterance): void {
      // Two ticks, not zero: `onPlayed` fires from `onstart`, and giving the
      // "speaking" live region a real (if brief) window to render is what
      // lets this file assert on it the same way a real utterance would let
      // a human see it, rather than the state flashing across in one tick a
      // test could not observe even with auto-retrying `expect`.
      setTimeout(() => {
        utterance.onstart?.();
        setTimeout(() => utterance.onend?.(), 20);
      }, 0);
    },
    cancel(): void {
      // No pending utterance ever needs cancelling here: every `.speak()`
      // above resolves to `onend` in 20ms, well inside any wait this file
      // does between plays.
    },
  };

  (window as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance =
    FakeUtterance;
  (window as unknown as { speechSynthesis: unknown }).speechSynthesis = fakeSynthesis;
}

// -----------------------------------------------------------------------------
// Wire shapes — the exact fields the DTOs cited in the file header declare.
// -----------------------------------------------------------------------------

interface EnglishSentenceWire {
  id: string;
  kind: 'reading' | 'writing';
  version: string;
  ordinal: number;
  text: string;
  vocabTags: string[];
  wordCount: number;
}

interface EnglishNextResponseWire {
  data: { sentence: EnglishSentenceWire | null };
}

interface EnglishScoreFieldsWire {
  sentenceId: string;
  kind: 'reading' | 'writing';
  text: string;
  responseText: string;
  wer: number;
  errors: number;
  substitutions: number;
  deletions: number;
  insertions: number;
  referenceTokenCount: number;
}

interface EnglishAttemptScoredWire extends EnglishScoreFieldsWire {
  status: 'scored';
  attemptId: string;
  outcome: 'correct' | 'partial' | 'incorrect';
  asrConfidence: number | null;
  replayCount: number;
}

interface EnglishAttemptMisheardWire extends EnglishScoreFieldsWire {
  status: 'misheard';
  asrConfidence: number;
  confidenceThreshold: number;
}

type EnglishAttemptResultWire = EnglishAttemptScoredWire | EnglishAttemptMisheardWire;

type EnglishAttemptResponseWire = { data: EnglishAttemptResultWire };

interface MeResponse {
  data: { id: string };
}

interface AiStatusResponse {
  data: { systemReady: boolean; unboundRoles: string[] };
}

interface ReadinessResponse {
  data: {
    capReason: 'typed_only' | null;
    components: { english: { value: number } };
    evidenceCounts: {
      english: { readingSentences: number; writingSentences: number };
    };
  };
}

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

function testEmail(label: string): string {
  return `english-${label}-${randomUUID()}@test.local`;
}

/** A key that is obviously fake and obviously not a real OpenAI secret. */
const FAKE_SERVER_KEY = 'sk-e2e-fake-server-key-not-real-english';

/** `FAKE_MODEL_IDS` entry `model-classifier.ts` sorts into the transcribe family. */
const TRANSCRIBE_MODEL = 'gpt-4o-transcribe';

/** Every user id this file creates, so `afterAll`'s sweep covers all of them. */
const createdUserIds: string[] = [];

const VERDICT_REGION_TIMEOUT = 10_000;

// -----------------------------------------------------------------------------
// API helpers
// -----------------------------------------------------------------------------

/** `PUT /api/ai-settings`, as the admin whose bearer token is passed. A REPLACE. */
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

/**
 * The next sentence for a segment, the PUBLIC way — the identical API call
 * `ReadingPracticePage`/`WritingPracticePage` themselves make on mount.
 * Selection is deterministic and unseen-first (`english.controller.ts`'s own
 * Swagger description), so calling this ahead of navigating to the page and
 * then letting the page call it again is safe: with no attempt recorded yet,
 * both calls resolve to the same sentence.
 */
async function fetchEnglishSentence(
  page: Page,
  headers: Record<string, string>,
  kind: 'reading' | 'writing',
): Promise<EnglishSentenceWire> {
  const response = await page.request.get(`/api/english/next?kind=${kind}`, { headers });
  expect(response.ok(), `GET /api/english/next?kind=${kind}`).toBe(true);
  const body = (await response.json()) as EnglishNextResponseWire;
  if (!body.data.sentence) {
    throw new Error(
      `fetchEnglishSentence: no ${kind} sentence is loaded — the bank is empty in this environment.`,
    );
  }
  return body.data.sentence;
}

/** `POST /api/english/attempts`, the PUBLIC way, for the readiness test's setup. */
async function postEnglishAttempt(
  page: Page,
  headers: Record<string, string>,
  body: { sentenceId: string; responseText: string; asrConfidence?: number; replayCount?: number },
): Promise<EnglishAttemptResultWire> {
  const response = await page.request.post('/api/english/attempts', {
    headers,
    data: body,
    failOnStatusCode: false,
  });
  expect(
    response.ok(),
    `POST /api/english/attempts — ${JSON.stringify(body)} — ${await response.text().catch(() => '')}`,
  ).toBe(true);
  const parsed = (await response.json()) as EnglishAttemptResponseWire;
  return parsed.data;
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
// Reading-page UI helpers
// -----------------------------------------------------------------------------

/**
 * Record one "reading" via the fake microphone, wait for the transcript to
 * land, and return the raw `POST /api/ai/speech/transcribe` response body —
 * exactly `voice.spec.ts`'s own `recordSpokenAnswer`, adapted to
 * `ReadingPracticePage`'s own idle-button label ("Hold to read aloud" rather
 * than practice's "Hold to record" — there is no Speak/Type toggle on this
 * page at all, because the voice path IS the page whenever `transcribe` is
 * bound).
 */
async function recordReadingViaVoice(
  page: Page,
  marker: string,
): Promise<{ text: string; confidence: number | null }> {
  const idle = page.getByRole('button', { name: 'Hold to read aloud' });
  await expect(idle).toBeVisible();

  await setVoiceMarker(page, marker);

  const responsePromise = page.waitForResponse(
    (res) => res.url().includes('/api/ai/speech/transcribe') && res.request().method() === 'POST',
  );

  // Space/Enter TOGGLES (`PushToTalkButton.tsx`) — press once to start, once
  // to stop, matching `voice.spec.ts`'s own two sequential `.press()` calls.
  await idle.press('Enter');
  const recording = page.getByRole('button', { name: 'Recording — press to stop' });
  await expect(recording).toBeVisible();
  await recording.press('Enter');

  const response = await responsePromise;
  const body = (await response.json()) as {
    data: { status: 'ok'; text: string; confidence: number | null } | { status: string };
  };
  if (body.data.status !== 'ok') {
    throw new Error(`recordReadingViaVoice: transcription was not "ok" — ${JSON.stringify(body.data)}`);
  }
  return body.data as { status: 'ok'; text: string; confidence: number | null };
}

/**
 * Which word of a fetched sentence to replace with a nonsense token to
 * produce a clean, one-substitution near miss. See the file header
 * ("WHY THE NEAR-MISS SUBSTITUTES A WORD RATHER THAN DROPPING ONE") for the
 * full reasoning; this is that reasoning as code.
 */
const ABBREVIATION_PRONE_WORDS = new Set([
  'president',
  'united',
  'states',
  'usa',
  'u',
  's',
  'd',
  'c',
  'potus',
]);

function buildNearMissTranscript(sentenceText: string): string {
  const words = sentenceText.trim().split(/\s+/);
  if (words.length < 2) {
    throw new Error(
      `buildNearMissTranscript: sentence "${sentenceText}" is too short to substitute a non-leading word.`,
    );
  }

  // Scan from the end, skipping the leading (index 0) word entirely — §2.1's
  // article-drop only ever touches a leading word, so leaving it untouched
  // keeps reference and hypothesis in lock-step everywhere but the one
  // substituted position.
  let targetIndex = -1;
  for (let i = words.length - 1; i >= 1; i -= 1) {
    const bare = words[i].replace(/[.,!?;:]+$/, '');
    const isSafe =
      /^[A-Za-z']+$/.test(bare) &&
      bare.length >= 4 &&
      !ABBREVIATION_PRONE_WORDS.has(bare.toLowerCase());
    if (isSafe) {
      targetIndex = i;
      break;
    }
  }
  // Fall back to the last word outright — still never the leading one —
  // rather than fail a test over a sentence this suite has not seen.
  if (targetIndex === -1) targetIndex = words.length - 1;

  const replaced = [...words];
  replaced[targetIndex] = 'wobblefish';
  return replaced.join(' ');
}

// =============================================================================
// TEST 0 — an administrator binds `transcribe` and deliberately leaves
// `speak` unbound (setup for every test below; also IS scenario 5's own
// precondition, not merely plumbing for it)
// =============================================================================

test.describe('Reading and writing tests (issue #149), epic #59 (E10)', () => {
  test.describe.configure({ mode: 'serial' });

  test('an administrator binds `transcribe`, and `speak` stays unbound', async ({ page }) => {
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
      models: { transcribe: TRANSCRIBE_MODEL },
    });

    const statusResponse = await page.request.get('/api/ai/status', { headers });
    expect(statusResponse.ok(), 'GET /api/ai/status').toBe(true);
    const status = ((await statusResponse.json()) as AiStatusResponse).data;
    expect(status.unboundRoles).not.toContain('transcribe');
    // THE PRECONDITION SCENARIO 5 NEEDS, asserted here rather than assumed:
    // `speak` genuinely has no model bound for the rest of this file.
    expect(status.unboundRoles).toContain('speak');
  });

  // ===========================================================================
  // TEST 1 (scenario 1) — nothing is scored before confirm, and the EDITED
  // text is what gets scored
  // ===========================================================================

  test('reading: the transcript is editable, and the edited text — not the recognisers guess — is what gets scored', async ({
    page,
  }) => {
    await page.addInitScript(installFakeMediaRecorder);

    const email = testEmail('confirm-edit');
    const { accessToken } = await seedOnboarding(page, { email, onboarding: 'full' });
    await page.waitForURL('/', { timeout: 10000 });
    const headers = { Authorization: `Bearer ${accessToken}` };
    const userId = await fetchUserId(page, headers);
    createdUserIds.push(userId);

    const sentence = await fetchEnglishSentence(page, headers, 'reading');

    await page.goto('/practice/reading');
    await expect(page.getByRole('heading', { level: 2 })).toHaveText(sentence.text);

    // The recogniser hears something WRONG — deliberately not the sentence at
    // all, so a test that forgot to edit the field would fail loudly on a
    // wrong outcome rather than pass by accident.
    const WRONG_TRANSCRIPT = 'purple bicycles race quietly';
    const transcription = await recordReadingViaVoice(page, `TRANSCRIPT:${WRONG_TRANSCRIPT}`);
    expect(transcription.text).toBe(WRONG_TRANSCRIPT);

    // NOTHING IS SCORED YET. The field holds the recogniser's raw guess,
    // editable, and confirmation copy is showing rather than a verdict.
    const field = page.getByLabel('What you read');
    await expect(field).toHaveValue(WRONG_TRANSCRIPT);
    await expect(page.getByText('Is this what you read?', { exact: true })).toBeVisible();
    await expect(page.getByText('Correct', { exact: false })).toHaveCount(0);

    // THE LEARNER EDITS IT to the sentence they actually read.
    await field.fill(sentence.text);
    await expect(field).toHaveValue(sentence.text);

    const attemptPromise = page.waitForResponse(
      (res) => res.url().includes('/api/english/attempts') && res.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Check my reading' }).click();
    const attemptResponse = await attemptPromise;
    const attemptBody = (await attemptResponse.json()) as EnglishAttemptResponseWire;

    // THE PROOF: the row was scored against the EDIT, not the recogniser's
    // raw output.
    expect(attemptBody.data.status).toBe('scored');
    const scored = attemptBody.data as EnglishAttemptScoredWire;
    expect(scored.responseText).toBe(sentence.text);
    expect(scored.responseText).not.toBe(WRONG_TRANSCRIPT);
    expect(scored.outcome).toBe('correct');

    await expect(page.getByText('You read that sentence.', { exact: true })).toBeVisible({
      timeout: VERDICT_REGION_TIMEOUT,
    });

    // AND THE SAME PROOF AGAIN, FROM THE TABLE THE PAGE NEVER TOUCHES.
    expect(await countEnglishAttemptsByUser([userId])).toBe(1);
  });

  // ===========================================================================
  // TEST 2 (scenario 2) — a near miss inside tolerance is a pass, and the
  // diff names WHICH word as a real text node, never colour alone
  // ===========================================================================

  test('reading: a near miss is a pass, and the correction is a real, in-order text node — not colour-only', async ({
    page,
  }) => {
    await page.addInitScript(installFakeMediaRecorder);

    const email = testEmail('near-miss');
    const { accessToken } = await seedOnboarding(page, { email, onboarding: 'full' });
    await page.waitForURL('/', { timeout: 10000 });
    const headers = { Authorization: `Bearer ${accessToken}` };
    const userId = await fetchUserId(page, headers);
    createdUserIds.push(userId);

    const sentence = await fetchEnglishSentence(page, headers, 'reading');
    const nearMiss = buildNearMissTranscript(sentence.text);
    expect(nearMiss).toContain('wobblefish');

    await page.goto('/practice/reading');
    await expect(page.getByRole('heading', { level: 2 })).toHaveText(sentence.text);

    const transcription = await recordReadingViaVoice(page, `TRANSCRIPT:${nearMiss}`);
    expect(transcription.text).toBe(nearMiss);

    const attemptPromise = page.waitForResponse(
      (res) => res.url().includes('/api/english/attempts') && res.request().method() === 'POST',
    );
    // Confirmed AS-IS — the near miss is what is submitted, deliberately.
    await page.getByRole('button', { name: 'Check my reading' }).click();
    const attemptResponse = await attemptPromise;
    const attemptBody = ((await attemptResponse.json()) as EnglishAttemptResponseWire).data;

    expect(attemptBody.status).toBe('scored');
    const scored = attemptBody as EnglishAttemptScoredWire;
    // EXACTLY ONE SUBSTITUTION — the property `buildNearMissTranscript`
    // exists to guarantee regardless of which sentence was drawn.
    expect(scored.errors).toBe(1);
    expect(scored.substitutions).toBe(1);
    expect(scored.deletions).toBe(0);
    expect(scored.insertions).toBe(0);
    // THE COMPOUND RULE (§2.3): one word wrong on a 3-8 token sentence is
    // never a failure. This is the pass the whole scenario turns on.
    expect(scored.outcome).toBe('correct');

    // THE HEADLINE HAS NO "BUT" IN IT.
    await expect(page.getByText('You read that sentence.', { exact: true })).toBeVisible({
      timeout: VERDICT_REGION_TIMEOUT,
    });

    // -------------------------------------------------------------------
    // THE DIFF, ASSERTED AS TEXT — never as a colour, a `title`, or an
    // `aria-label` on a non-interactive element. `SentenceDiff.tsx`'s own
    // header: every correction is a real `visuallyHidden` TEXT NODE in
    // reading order, which is what makes it show up in a container's own
    // `textContent` at all — a `title` attribute or an `aria-label` would
    // not.
    // -------------------------------------------------------------------
    const resultRegion = page.getByRole('status', { name: 'Your result' });
    const resultText = (await resultRegion.textContent()) ?? '';

    // Channel 2 — the plain-English summary (`summarise(1, 0, 0)`).
    expect(resultText).toContain('One word changed.');
    // Channel 1 — the substitution named in words: "you said X instead of Y."
    expect(resultText).toMatch(/you said wobblefish instead of \S+\./);
  });

  // ===========================================================================
  // TEST 3 (scenario 3) — low confidence -> `misheard`, and NO row at all
  // ===========================================================================

  test('reading: low confidence is `misheard`, and no `english_attempts` row is written at all', async ({
    page,
  }) => {
    await page.addInitScript(installFakeMediaRecorder);

    const email = testEmail('misheard');
    const { accessToken } = await seedOnboarding(page, { email, onboarding: 'full' });
    await page.waitForURL('/', { timeout: 10000 });
    const headers = { Authorization: `Bearer ${accessToken}` };
    const userId = await fetchUserId(page, headers);
    createdUserIds.push(userId);

    const sentence = await fetchEnglishSentence(page, headers, 'reading');
    await page.goto('/practice/reading');
    await expect(page.getByRole('heading', { level: 2 })).toHaveText(sentence.text);

    // The `LOWCONF` marker, with no `TRANSCRIPT:` override — the fixture's
    // own decoy text at 0.41 confidence, comfortably below
    // `ASR_CONFIDENCE_THRESHOLD` (0.6), and unrelated to any real sentence's
    // content so its scored outcome (were it scored) could never be `correct`.
    const misheard = await recordReadingViaVoice(page, 'LOWCONF');
    expect(misheard.text).toBe('the head of the executive ranch');
    expect(misheard.confidence).toBeCloseTo(0.41, 5);

    await expect(page.getByText('That may not be what you read.', { exact: true })).toBeVisible();

    const attemptPromise = page.waitForResponse(
      (res) => res.url().includes('/api/english/attempts') && res.request().method() === 'POST',
    );
    // The learner does not notice, and confirms it AS-IS.
    await page.getByRole('button', { name: 'Check my reading' }).click();
    const attemptResponse = await attemptPromise;

    // BOTH ARMS ARE HTTP 200 (`english-test.md` §3: "a mishearing is not a
    // client error").
    expect(attemptResponse.status()).toBe(200);
    const attemptBody = ((await attemptResponse.json()) as EnglishAttemptResponseWire).data;
    expect(attemptBody.status).toBe('misheard');
    const misheardBody = attemptBody as EnglishAttemptMisheardWire;
    expect(misheardBody.asrConfidence).toBeCloseTo(0.41, 5);
    expect(misheardBody.confidenceThreshold).toBe(0.6);
    // NO `attemptId` ON THE WIRE — there is no row to name.
    expect(attemptBody).not.toHaveProperty('attemptId');

    await expect(
      page.getByText('We are not sure we heard that correctly.', { exact: true }),
    ).toBeVisible({ timeout: VERDICT_REGION_TIMEOUT });
    await expect(page.getByText('nothing has been recorded', { exact: false })).toBeVisible();
    // NEVER RENDERED AS A FAILURE HEADLINE.
    await expect(page.getByText('That one did not come through.', { exact: true })).toHaveCount(0);

    // -------------------------------------------------------------------
    // THE ONE CLAIM NO API RESPONSE CAN PROVE: the database, directly.
    // A response carrying no `attemptId` is consistent with §3's claim that
    // nothing was written, but it is EQUALLY consistent with a row having
    // been written anyway and never linked back into what the client reads.
    // Only the table itself settles it.
    // -------------------------------------------------------------------
    expect(
      await countEnglishAttemptsByUser([userId]),
      'no english_attempts row for a reading attempt the server judged misheard',
    ).toBe(0);
  });

  // ===========================================================================
  // TEST 4 (scenario 4) — writing: the sentence is NEVER in the DOM before
  // submission, and is revealed only after. The load-bearing invariant.
  // ===========================================================================

  test('writing: the sentence never reaches the DOM before submission, and is revealed only after', async ({
    page,
  }) => {
    await page.addInitScript(installFakeSpeechSynthesis);

    const email = testEmail('never-shown');
    const { accessToken } = await seedOnboarding(page, { email, onboarding: 'full' });
    await page.waitForURL('/', { timeout: 10000 });
    const headers = { Authorization: `Bearer ${accessToken}` };
    createdUserIds.push(await fetchUserId(page, headers));

    // Known independently of the page, via the identical public read the
    // page itself performs — never scraped off a rendering the invariant
    // forbids in the first place.
    const sentence = await fetchEnglishSentence(page, headers, 'writing');

    await page.goto('/practice/writing');
    await expect(page.getByRole('heading', { level: 1, name: 'Writing practice' })).toBeVisible();
    // Wait for the SENTENCE ITSELF to have loaded — `sentence.text` is in
    // this component's memory from this moment on (the file header's own
    // "THE SENTENCE IS DICTATED AND NEVER SHOWN" section) — so the check
    // right after this is not vacuously true over a still-loading screen.
    await expect(page.getByRole('button', { name: 'Play the sentence' })).toBeVisible();

    // ---------------------------------------------------------------------
    // BEFORE ANYTHING: not in the DOM at all. `.innerHTML()` — the browser
    // equivalent of the unit test's own `document.body.innerHTML` check the
    // task names — catches an attribute, a hidden node, or a code comment
    // just as readily as visible text; a `getByText` locator would not.
    // ---------------------------------------------------------------------
    let bodyHtml = await page.locator('body').innerHTML();
    expect(bodyHtml).not.toContain(sentence.text);

    // ---------------------------------------------------------------------
    // STILL NOT SHOWN AFTER PLAYING IT. Hearing the dictation must not leak
    // the text onto the page either.
    // ---------------------------------------------------------------------
    await page.getByRole('button', { name: 'Play the sentence' }).click();
    await expect(page.getByText('Reading the sentence aloud.', { exact: true })).toBeVisible();
    await expect(page.getByText('Reading the sentence aloud.', { exact: true })).toHaveCount(0);

    bodyHtml = await page.locator('body').innerHTML();
    expect(bodyHtml).not.toContain(sentence.text);

    // A wrong answer, deliberately — the reveal must happen regardless of
    // outcome, and an obviously-wrong answer keeps this test from
    // accidentally depending on having guessed the dictated sentence right.
    await page.getByLabel('What you heard').fill('an entirely different sentence');

    const attemptPromise = page.waitForResponse(
      (res) => res.url().includes('/api/english/attempts') && res.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Check my writing' }).click();
    await attemptPromise;

    // ---------------------------------------------------------------------
    // AFTER SUBMISSION: revealed, verbatim, as `result.text`.
    // ---------------------------------------------------------------------
    await expect(page.getByText('The sentence was', { exact: true })).toBeVisible({
      timeout: VERDICT_REGION_TIMEOUT,
    });
    await expect(page.getByText(sentence.text, { exact: true })).toBeVisible();
    bodyHtml = await page.locator('body').innerHTML();
    expect(bodyHtml).toContain(sentence.text);
  });

  // ===========================================================================
  // TESTS 5 & 6 (scenarios 5 and 6) — dictation on the browser's own voice
  // with `speak` unbound, `POST /api/ai/speech/synthesize` never called, and
  // replays counted accurately
  // ===========================================================================

  test('writing: dictation works on the browser voice with `speak` unbound, synth is never called, and replays are counted', async ({
    page,
  }) => {
    await page.addInitScript(installFakeSpeechSynthesis);

    // THE NETWORK-LEVEL PROOF for scenario 5: every request this page makes,
    // watched from before navigation, so a call made on the very first
    // render is caught too.
    const synthesizeRequests: string[] = [];
    page.on('request', (req) => {
      if (req.url().includes('/api/ai/speech/synthesize')) synthesizeRequests.push(req.url());
    });

    const email = testEmail('replay-count');
    const { accessToken } = await seedOnboarding(page, { email, onboarding: 'full' });
    await page.waitForURL('/', { timeout: 10000 });
    const headers = { Authorization: `Bearer ${accessToken}` };
    createdUserIds.push(await fetchUserId(page, headers));

    const sentence = await fetchEnglishSentence(page, headers, 'writing');

    await page.goto('/practice/writing');
    await expect(page.getByRole('heading', { level: 1, name: 'Writing practice' })).toBeVisible();

    // THE ONLY SPEECH PATH AVAILABLE: the browser's own voice, with no
    // binding, no key, no admin action (`speak` was left unbound by Test 0).
    const playButton = () =>
      page.getByRole('button', { name: /^(Play the sentence|Play it again)$/ });

    // Play three times: the first is the dictation itself, the other two are
    // replays — `replayCount = plays - 1 = 2`. Each cycle waits for the
    // "speaking" live region to appear (`onPlayed` fired, proving THIS click
    // actually produced a play) and then clear (the utterance ended) before
    // the next click, so three clicks cannot race into fewer than three
    // counted plays.
    for (let i = 0; i < 3; i += 1) {
      await playButton().click();
      await expect(page.getByText('Reading the sentence aloud.', { exact: true })).toBeVisible();
      await expect(page.getByText('Reading the sentence aloud.', { exact: true })).toHaveCount(0);
    }

    await page.getByLabel('What you heard').fill(sentence.text);

    const attemptPromise = page.waitForResponse(
      (res) => res.url().includes('/api/english/attempts') && res.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Check my writing' }).click();
    const attemptResponse = await attemptPromise;
    const attemptBody = ((await attemptResponse.json()) as EnglishAttemptResponseWire).data;

    expect(attemptBody.status).toBe('scored');
    const scored = attemptBody as EnglishAttemptScoredWire;
    // THE RECORDED COUNT MATCHES THE ACTUAL NUMBER OF REPLAYS — the first
    // play was the dictation, not a replay.
    expect(scored.replayCount).toBe(2);
    // A perfect, verbatim answer — never gated by how many times it was
    // replayed (§4: "nothing is gated on the count").
    expect(scored.outcome).toBe('correct');

    await expect(page.getByText('You wrote that sentence.', { exact: true })).toBeVisible({
      timeout: VERDICT_REGION_TIMEOUT,
    });

    // SCENARIO 5's OWN PROOF: the premium synthesis endpoint was never hit,
    // on a page that spoke the sentence four times over (one dictation, two
    // replays played here, and the very first render — none of it premium).
    expect(
      synthesizeRequests,
      'POST /api/ai/speech/synthesize must never be called when `speak` is unbound',
    ).toHaveLength(0);
  });

  // ===========================================================================
  // TEST 7 (scenario 7) — the `english` readiness component rises above
  // zero, and does NOT lift the `typed_only` structural cap
  // ===========================================================================

  test('readiness: `english` rises above zero from real reading and writing evidence, and never lifts the `typed_only` cap', async ({
    page,
  }) => {
    const email = testEmail('readiness');
    const { accessToken } = await seedOnboarding(page, { email, onboarding: 'full' });
    await page.waitForURL('/', { timeout: 10000 });
    const headers = { Authorization: `Bearer ${accessToken}` };
    const userId = await fetchUserId(page, headers);
    createdUserIds.push(userId);

    // ---------------------------------------------------------------------
    // BASELINE — a fresh learner: `typed_only`, and `english` genuinely 0,
    // not merely unmeasured (`english-test.md` §6.2's own "0 has never had a
    // different meaning to guard against").
    // ---------------------------------------------------------------------
    const baseline = await fetchReadiness(page, headers);
    expect(baseline.capReason).toBe('typed_only');
    expect(baseline.components.english.value).toBe(0);
    expect(baseline.evidenceCounts.english.readingSentences).toBe(0);
    expect(baseline.evidenceCounts.english.writingSentences).toBe(0);

    // ---------------------------------------------------------------------
    // ONE CORRECT READING ATTEMPT AND ONE CORRECT WRITING ATTEMPT — plain,
    // typed submissions through the PUBLIC API (no voice needed: a reading
    // attempt is scored on whatever `responseText` it is given, whether that
    // text arrived by transcription or, as here, was already known). No AI
    // binding is needed for either — English scoring is deterministic
    // (`normalizeAnswer` + word alignment), never a grading-ladder call.
    // ---------------------------------------------------------------------
    const readingSentence = await fetchEnglishSentence(page, headers, 'reading');
    const readingAttempt = await postEnglishAttempt(page, headers, {
      sentenceId: readingSentence.id,
      responseText: readingSentence.text,
    });
    expect(readingAttempt.status).toBe('scored');
    expect((readingAttempt as EnglishAttemptScoredWire).outcome).toBe('correct');

    const writingSentence = await fetchEnglishSentence(page, headers, 'writing');
    const writingAttempt = await postEnglishAttempt(page, headers, {
      sentenceId: writingSentence.id,
      responseText: writingSentence.text,
      replayCount: 0,
    });
    expect(writingAttempt.status).toBe('scored');
    expect((writingAttempt as EnglishAttemptScoredWire).outcome).toBe('correct');

    expect(await countEnglishAttemptsByUser([userId])).toBe(2);

    // ---------------------------------------------------------------------
    // FORCE A RECOMPUTE — see the file header ("WHY THE READINESS TEST
    // FORCES A TYPED CIVICS ATTEMPT"): the stale-on-read check only reacts
    // to `practice_attempts`, never `english_attempts`, so one ordinary
    // typed civics answer is what actually makes the NEXT `GET /readiness`
    // recompute.
    // ---------------------------------------------------------------------
    await page.goto('/practice');
    await expect(page.getByRole('heading', { level: 1, name: 'Practice' })).toBeVisible();
    await page.getByRole('button', { name: 'Start a Quick 5' }).click();
    await expect(page).toHaveURL(/\/practice\/sessions\/[0-9a-f-]{36}$/);
    const sessionId = page.url().split('/').pop();
    if (!sessionId) throw new Error('could not read the Quick 5 session id off the URL');

    const questionId = await fetchNextQuestionId(page, headers, sessionId);
    const acceptedAnswer = await fetchAcceptedAnswer(page, headers, questionId);
    await page.getByLabel('Your answer').fill(acceptedAnswer);
    await page.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(page.getByText('Correct', { exact: true })).toBeVisible({
      timeout: VERDICT_REGION_TIMEOUT,
    });

    // ---------------------------------------------------------------------
    // AFTER — recomputed, with real English evidence now folded in.
    // ---------------------------------------------------------------------
    const after = await fetchReadiness(page, headers);
    expect(after.evidenceCounts.english.readingSentences).toBe(1);
    expect(after.evidenceCounts.english.writingSentences).toBe(1);
    // `english-test.md` §6.2`: 1 correct reading of target 6, 1 correct
    // writing of target 4 -> 0.5*(1/6) + 0.5*(1/4) = 0.0833... + 0.125.
    expect(after.components.english.value).toBeCloseTo(0.5 * (1 / 6) + 0.5 * (1 / 4), 5);
    expect(after.components.english.value).toBeGreaterThan(0);

    // -------------------------------------------------------------------
    // THE INVARIANT THIS TEST EXISTS TO PROVE (§6.3): full English credit,
    // and STILL `typed_only` — because this learner has never spoken a
    // civics answer or sat a mock interview, and English evidence is not
    // evidence of either.
    // -------------------------------------------------------------------
    expect(after.capReason).toBe('typed_only');
  });

  test.afterAll(async () => {
    await closeDbPool();
  });
});

// =============================================================================
// UNTOUCHED FILES
// =============================================================================
//
// This change adds `english.spec.ts`, `helpers/fake-media-recorder.ts`
// (the `MediaRecorder` stub extracted, verbatim, out of `voice.spec.ts` — see
// that new file's own header for why it is a new module rather than an
// import from a sibling spec), and one new function on `helpers/db.ts`
// (`countEnglishAttemptsByUser`, alongside the pre-existing
// `countStorageObjectsUploadedBy` it is modelled on). `voice.spec.ts` and
// every other existing spec file are untouched. `playwright.config.ts` is
// untouched too: the two `getUserMedia` fake-device flags and the
// `--autoplay-policy=no-user-gesture-required` flag `voice.spec.ts` already
// added are exactly what this file also needs, and are already in place.
// =============================================================================

