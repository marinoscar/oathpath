/**
 * Writing practice (`/practice/writing`) — issue #147, epic #59 / E10.
 *
 * Every assertion here is one of the issue's acceptance criteria, and each one
 * exists because of a specific way this screen could quietly stop testing what
 * it claims to test:
 *
 *  1. **THE SENTENCE IS NEVER IN THE DOM BEFORE SUBMISSION.** The load-bearing
 *     one, and the reason this file asserts against `document.body.innerHTML`
 *     rather than against `screen.queryByText`. `GET /english/next` returns the
 *     sentence for the writing segment too (browser dictation needs the string
 *     client-side), so the text IS in the component's memory the whole time —
 *     which means "it is not visible" is not the property under test. The
 *     property is that it is not in the document AT ALL: not off-screen, not
 *     `visibility: hidden`, not in a `title`, not in an `aria-label`, not in a
 *     `value`. A `queryByText` assertion would pass for every one of those.
 *     `docs/specs/english-test.md` §4: a visible sentence silently converts the
 *     exercise from "can this learner write English they hear" into "can this
 *     learner copy text", and a learner who scores well on the second has been
 *     told something false about their readiness.
 *  2. **Dictation works with NO `speak` binding.** The browser's own
 *     `speechSynthesis` is the default (§4, `voice.md` §2) — a fresh install
 *     with no model bound, no key and no admin action must still dictate. So
 *     the test runs with `speak` unbound and asserts both that the browser
 *     spoke and that the paid endpoint was never called.
 *  3. **Replays are permitted, counted, and free.** A real `replayCount` on the
 *     attempt (writing-only — a non-zero one on a reading attempt is a 400),
 *     the first play NOT counted as a replay, the count reset per sentence, and
 *     no counter shown back to the learner. §4 and `VISION.md` line 389:
 *     penalising replays punishes exactly the honest behaviour the product
 *     wants.
 *  4. **All four input assists are off, on the real element.** Asserted on the
 *     `<textarea>` itself, because the same names on MUI's wrapper would
 *     satisfy a careless test and be ignored by every browser.
 *  5. **The diff names the words, and not only in colour.** Asserted through
 *     accessible text — if the marks were carried by `color`, an icon or a
 *     `textDecoration` alone, `textContent` would not contain these strings.
 *  6. **With no dictation available the screen EXPLAINS and offers reading.**
 *     Never the sentence. §4 requires the failure to be visible rather than
 *     degrading into a different, easier exercise wearing the same name.
 *  7. **Both themes at 360px**, because this is a phone screen.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse, delay } from 'msw';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { CssBaseline, ThemeProvider } from '@mui/material';

import { server } from '../mocks/server';
import { resetViewportWidth, setViewportWidth } from '../setup';
import { mockUser } from '../utils/test-utils';
import { AuthContext } from '../../contexts/AuthContext';
import { AiStatusProvider } from '../../contexts/AiStatusContext';
import { darkTheme, lightTheme } from '../../theme';
import WritingPracticePage from '../../pages/WritingPracticePage';
import type {
  AiStatus,
  EnglishAttemptResult,
  EnglishDiffOp,
  EnglishSentence,
  RecordEnglishAttemptInput,
} from '../../types';

// -----------------------------------------------------------------------------
// The browser's own voice, under this test's control
// -----------------------------------------------------------------------------
//
// jsdom implements neither `speechSynthesis` nor `SpeechSynthesisUtterance`, so
// without this fake `browserSpeechAvailable()` is false and every test would be
// exercising the no-dictation branch. The fake is deliberately minimal — it
// records what was spoken and fires `onstart`/`onend` synchronously — because
// what these tests need from it is exactly two facts: THAT the sentence was
// spoken, and that `onPlayed` fired so a replay was counted.

class FakeUtterance {
  rate = 1;
  onstart: ((event: unknown) => void) | null = null;
  onend: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  constructor(public text: string) {}
}

/** Everything the browser voice has been asked to say, in order. */
const spoken: string[] = [];

const fakeSpeechSynthesis = {
  speak(utterance: FakeUtterance) {
    spoken.push(utterance.text);
    // `onstart` is what `QuestionAudio` turns into `onPlayed`, and `onPlayed`
    // is what this screen counts. Firing `onend` straight after returns the
    // button to its resting label, so a second press is a second play rather
    // than a stop.
    utterance.onstart?.(null);
    utterance.onend?.(null);
  },
  cancel() {},
};

function installBrowserSpeech() {
  spoken.length = 0;
  Object.defineProperty(window, 'speechSynthesis', {
    value: fakeSpeechSynthesis,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(window, 'SpeechSynthesisUtterance', {
    value: FakeUtterance,
    configurable: true,
    writable: true,
  });
}

/** A browser with no speech synthesis at all — see criterion 6. */
function removeBrowserSpeech() {
  Reflect.deleteProperty(window, 'speechSynthesis');
  Reflect.deleteProperty(window, 'SpeechSynthesisUtterance');
}

// -----------------------------------------------------------------------------
// Fixtures — shaped from `apps/api/src/english/dto/*.ts`, field for field
// -----------------------------------------------------------------------------

const API_BASE = '*/api';
const PHONE = 360;

const SENTENCE: EnglishSentence = {
  id: '33333333-3333-4333-8333-333333333333',
  kind: 'writing',
  version: '2008',
  ordinal: 1,
  text: 'Washington was the first President.',
  vocabTags: ['PEOPLE', 'CIVICS'],
  wordCount: 5,
};

const SECOND_SENTENCE: EnglishSentence = {
  ...SENTENCE,
  id: '44444444-4444-4444-8444-444444444444',
  ordinal: 2,
  text: 'Citizens can vote in November.',
  wordCount: 5,
};

/**
 * The words a leak would actually give away, per sentence.
 *
 * DECLARED RATHER THAN DERIVED, and the function words are deliberately not on
 * these lists. "the", "was", "in" and "can" all appear in the screen's own
 * English prose — its heading, its helper text, its instructions — so asserting
 * on them would fail on copy that leaks nothing, and the only way to make such
 * an assertion pass is to write the screen in a language it is not in. What a
 * cheating screen would have to put on the page is these words; a screen that
 * shows "the" and nothing else has told the learner nothing about the sentence.
 */
const DISTINCTIVE_WORDS: Record<string, string[]> = {
  [SENTENCE.id]: ['washington', 'first', 'president'],
  [SECOND_SENTENCE.id]: ['citizens', 'vote', 'november'],
};

/** The reference tokens, exactly as `normalizeAnswer` produces them (§2.1). */
const REFERENCE_TOKENS = ['washington', 'was', 'the', '1', 'president'];

function perfectDiff(): EnglishDiffOp[] {
  return REFERENCE_TOKENS.map((token, index) => ({
    kind: 'match' as const,
    reference: token,
    hypothesis: token,
    referenceIndex: index,
  }));
}

/** One deletion, one substitution and one insertion — three op kinds at once. */
function mixedDiff(): EnglishDiffOp[] {
  return [
    {
      kind: 'delete',
      reference: 'washington',
      hypothesis: null,
      referenceIndex: 0,
    },
    { kind: 'match', reference: 'was', hypothesis: 'was', referenceIndex: 1 },
    {
      kind: 'substitute',
      reference: 'the',
      hypothesis: 'our',
      referenceIndex: 2,
    },
    { kind: 'match', reference: '1', hypothesis: '1', referenceIndex: 3 },
    {
      kind: 'match',
      reference: 'president',
      hypothesis: 'president',
      referenceIndex: 4,
    },
    { kind: 'insert', reference: null, hypothesis: 'sir', referenceIndex: 5 },
  ];
}

function scoreFields(responseText: string, diff: EnglishDiffOp[]) {
  const substitutions = diff.filter((op) => op.kind === 'substitute').length;
  const deletions = diff.filter((op) => op.kind === 'delete').length;
  const insertions = diff.filter((op) => op.kind === 'insert').length;
  const errors = substitutions + deletions + insertions;

  return {
    sentenceId: SENTENCE.id,
    kind: 'writing' as const,
    // THE REVEAL. The screen renders this field, never the one it was handed by
    // `GET /english/next` — see the page's own header.
    text: SENTENCE.text,
    responseText,
    wer: errors / REFERENCE_TOKENS.length,
    errors,
    substitutions,
    deletions,
    insertions,
    referenceTokenCount: REFERENCE_TOKENS.length,
    diff,
    normalizedReference: REFERENCE_TOKENS.join(' '),
    normalizedHypothesis: responseText.toLowerCase(),
  };
}

interface Options {
  sentence?: EnglishSentence | null;
  /** Successive answers to `GET /english/next`, for the "next sentence" flow. */
  sentences?: (EnglishSentence | null)[];
  /** Every attempt body the page posted, in order. */
  onAttempt?: (input: RecordEnglishAttemptInput) => void;
  attemptResult?: (input: RecordEnglishAttemptInput) => EnglishAttemptResult;
  /** `speak` bound on this deployment? Defaults to NO — the fresh install. */
  speakBound?: boolean;
  /** Hold `GET /ai/status` open, to catch a premature "no dictation" screen. */
  delayAiStatus?: boolean;
  theme?: typeof lightTheme;
}

/** How many times each endpoint was hit, for the never-called assertions. */
const calls = { next: 0, synthesize: 0, attempts: 0 };

function renderWriting(options: Options = {}) {
  const status: AiStatus = {
    userKeyConfigured: true,
    systemReady: true,
    enabled: true,
    providerConfigured: true,
    // `transcribe` is unbound throughout: it belongs to the READING screen and
    // nothing on this one should depend on it either way.
    unboundRoles: options.speakBound ? ['transcribe'] : ['transcribe', 'speak'],
  };

  const queue = options.sentences ?? null;
  let nextCall = 0;

  server.use(
    http.get(`${API_BASE}/ai/status`, async () => {
      if (options.delayAiStatus) await delay(50);
      return HttpResponse.json({ data: status });
    }),
    http.get(`${API_BASE}/english/next`, () => {
      calls.next += 1;
      const sentence = queue
        ? (queue[Math.min(nextCall++, queue.length - 1)] ?? null)
        : options.sentence !== undefined
          ? options.sentence
          : SENTENCE;
      return HttpResponse.json({ data: { sentence } });
    }),
    http.post(`${API_BASE}/ai/speech/synthesize`, () => {
      calls.synthesize += 1;
      // Matches the real contract (issue #277): `speak` unbound is a 200
      // `application/json` `unavailable` envelope, never an error status —
      // `docs/specs/voice.md` §9. This suite mostly does not care whether the
      // call succeeds (dictation defaults to the browser's own voice), but
      // the one test that puts `speak` in play with no browser voice at all
      // needs it to actually answer audio.
      if (options.speakBound) {
        return HttpResponse.arrayBuffer(new ArrayBuffer(8), {
          headers: { 'Content-Type': 'audio/mpeg' },
        });
      }
      return HttpResponse.json({
        data: { status: 'unavailable', cause: 'role_unbound', role: 'speak' },
      });
    }),
    http.post(`${API_BASE}/english/attempts`, async ({ request }) => {
      calls.attempts += 1;
      const input = (await request.json()) as RecordEnglishAttemptInput;
      options.onAttempt?.(input);

      if (options.attemptResult) {
        return HttpResponse.json({ data: options.attemptResult(input) });
      }

      return HttpResponse.json({
        data: {
          status: 'scored',
          ...scoreFields(input.responseText, perfectDiff()),
          attemptId: 'attempt-1',
          outcome: 'correct',
          answeredAt: '2026-03-01T12:00:00.000Z',
          asrConfidence: null,
          replayCount: input.replayCount ?? 0,
        } satisfies EnglishAttemptResult,
      });
    }),
  );

  const auth = {
    user: mockUser,
    isLoading: false,
    isAuthenticated: true,
    providers: [],
    login: vi.fn(),
    logout: vi.fn(),
    refreshUser: vi.fn(),
  };

  return render(
    <ThemeProvider theme={options.theme ?? lightTheme}>
      <CssBaseline />
      <AuthContext.Provider value={auth as never}>
        <AiStatusProvider>
          <MemoryRouter initialEntries={['/practice/writing']}>
            <Routes>
              <Route path="/practice/writing" element={<WritingPracticePage />} />
              <Route path="/practice/reading" element={<h1>Reading practice</h1>} />
              <Route path="/practice" element={<h1>Practice</h1>} />
            </Routes>
          </MemoryRouter>
        </AiStatusProvider>
      </AuthContext.Provider>
    </ThemeProvider>,
  );
}

/**
 * THE INVARIANT, as an assertion.
 *
 * Against `innerHTML` rather than rendered text, so an attribute — `title`,
 * `aria-label`, `placeholder`, `value`, `alt`, a `data-*` — fails it too, and
 * so does a node hidden with CSS (`visibility: hidden`, `opacity: 0`, a
 * `visuallyHidden` span, an off-screen `position: absolute`). Every one of
 * those would pass a `queryByText` check, and every one of them is a learner
 * copying a sentence they were supposed to hear.
 *
 * TWO CHECKS, because either alone has a hole. The whole string catches the
 * obvious leak; the distinctive words catch a screen that rendered the sentence
 * one `<span>` per word, or hyphenated, or with the punctuation stripped —
 * which would sail past a whole-string `toContain` while showing every word of
 * it. See {@link DISTINCTIVE_WORDS} for why the function words are not checked.
 *
 * WHAT THE LEARNER TYPED IS CARVED OUT, and that is not a loophole. The
 * invariant is that THE APPLICATION never puts the sentence on the page; a
 * learner who heard it correctly and wrote it down has put those exact words
 * there themselves, and they are the answer, not a leak. Without this carve-out
 * the only way to pass would be for the test to have the learner answer wrongly
 * every time — which would leave the reveal-after-a-correct-answer path
 * untested. So the fields a person types into are emptied in a CLONE, and every
 * other node in the document is checked as it stands.
 */
function expectSentenceHidden(sentence: EnglishSentence = SENTENCE) {
  const clone = document.body.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('textarea, input').forEach((field) => {
    field.textContent = '';
    field.removeAttribute('value');
  });
  const html = clone.innerHTML.toLowerCase();

  expect(html).not.toContain(sentence.text.toLowerCase());

  for (const word of DISTINCTIVE_WORDS[sentence.id]) {
    expect(html).not.toContain(word);
  }
}

/** Wait for the dictation control, which is the screen being ready. */
function findPlayButton() {
  return screen.findByRole('button', { name: /play the sentence/i });
}

beforeEach(() => {
  installBrowserSpeech();
  calls.next = 0;
  calls.synthesize = 0;
  calls.attempts = 0;
});

afterEach(() => {
  removeBrowserSpeech();
  resetViewportWidth();
});

// -----------------------------------------------------------------------------
// 1. THE SENTENCE IS NEVER RENDERED BEFORE SUBMISSION. The load-bearing one.
// -----------------------------------------------------------------------------

describe('the sentence', () => {
  it('is nowhere in the DOM before submission — not visible, not hidden, not in an attribute', async () => {
    const user = userEvent.setup();
    renderWriting();

    await findPlayButton();

    // On arrival: the screen is loaded, the sentence has been fetched and is in
    // the component's memory, and none of it is in the document.
    expectSentenceHidden();

    // After hearing it…
    await user.click(await findPlayButton());
    expect(spoken).toEqual([SENTENCE.text]);
    expectSentenceHidden();

    // …and after typing an answer. Still nothing to copy from.
    const field = screen.getByRole('textbox', { name: /what you heard/i });
    // EMPTY TO START WITH. `expectSentenceHidden` empties the fields a person
    // types into before it looks (they own what they typed), so this is the one
    // leak that carve-out could hide: a screen that pre-filled the answer box
    // with the sentence.
    expect(field).toHaveValue('');

    await user.type(field, 'Washington was the first President');
    expectSentenceHidden();
  });

  it('reveals it for the first time only after the attempt is scored', async () => {
    const user = userEvent.setup();
    renderWriting();

    await user.click(await findPlayButton());
    await user.type(
      screen.getByRole('textbox', { name: /what you heard/i }),
      'Washington was the first President',
    );
    expectSentenceHidden();

    await user.click(screen.getByRole('button', { name: /check my writing/i }));

    const verdict = await screen.findByRole('status', { name: 'Your result' });
    await waitFor(() => expect(verdict).toHaveTextContent(SENTENCE.text));
    expect(verdict).toHaveTextContent(/the sentence was/i);
  });

  it('does not show a word count or the vocabulary tags before the reveal', async () => {
    const user = userEvent.setup();
    renderWriting();

    await findPlayButton();
    // Both are scaffolding the real interview does not provide, and a tag like
    // PEOPLE narrows a sentence the learner is meant to catch by ear.
    expect(screen.queryByText('PEOPLE')).not.toBeInTheDocument();
    expect(screen.queryByText(/5 words/i)).not.toBeInTheDocument();

    await user.type(
      screen.getByRole('textbox', { name: /what you heard/i }),
      'Washington was the first President',
    );
    await user.click(screen.getByRole('button', { name: /check my writing/i }));

    expect(await screen.findByText('PEOPLE')).toBeInTheDocument();
  });

  it('renders an honest absence, not an error, when the bank is empty', async () => {
    renderWriting({ sentence: null });

    expect(
      await screen.findByText(/no writing sentences loaded yet/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

// -----------------------------------------------------------------------------
// 2. Dictation with NO `speak` binding — the fresh install
// -----------------------------------------------------------------------------

describe('dictation', () => {
  it("speaks with the browser's own voice when `speak` is unbound, and never calls the paid route", async () => {
    const user = userEvent.setup();
    // `speakBound` defaults to false: no model bound, no key, no admin action.
    renderWriting();

    await user.click(await findPlayButton());

    expect(spoken).toEqual([SENTENCE.text]);
    // The premium upgrade is not attempted, so no learner's key is spent on
    // something their browser did for nothing.
    expect(calls.synthesize).toBe(0);
  });

  it('does not blame the deployment for anything — an unbound `speak` is not a degraded state', async () => {
    renderWriting();

    await findPlayButton();
    // `voice.md` §2: nothing may explain an unbound `speak`, because nothing is
    // missing. An `AiNotReady` here would tell a learner the product is broken
    // while it reads the sentence to them.
    expect(screen.queryByText(/not available yet/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/administrator/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/\bspeak\b/i)).not.toBeInTheDocument();
  });
});

// -----------------------------------------------------------------------------
// 3. Replays: permitted, counted, free
// -----------------------------------------------------------------------------

describe('replays', () => {
  it('counts them, and does not count the first play as one', async () => {
    const posted: RecordEnglishAttemptInput[] = [];
    const user = userEvent.setup();
    renderWriting({ onAttempt: (input) => posted.push(input) });

    // Heard once, written down: zero replays, truthfully.
    await user.click(await findPlayButton());
    await user.type(
      screen.getByRole('textbox', { name: /what you heard/i }),
      'Washington was the first President',
    );
    await user.click(screen.getByRole('button', { name: /check my writing/i }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].replayCount).toBe(0);
  });

  it('sends the real count after three plays, and never sends asrConfidence', async () => {
    const posted: RecordEnglishAttemptInput[] = [];
    const user = userEvent.setup();
    renderWriting({ onAttempt: (input) => posted.push(input) });

    await user.click(await findPlayButton());
    // The label becomes an affordance for hearing it again — never a counter.
    const again = await screen.findByRole('button', { name: /play it again/i });
    await user.click(again);
    await user.click(screen.getByRole('button', { name: /play it again/i }));

    expect(spoken).toHaveLength(3);

    await user.type(
      screen.getByRole('textbox', { name: /what you heard/i }),
      'Washington was the first President',
    );
    await user.click(screen.getByRole('button', { name: /check my writing/i }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].replayCount).toBe(2);
    // Nothing was transcribed, so there is no recogniser confidence to claim —
    // and one on a writing attempt is a 400.
    expect(posted[0]).not.toHaveProperty('asrConfidence');
  });

  it('never shows the count back to the learner, and says replays are free', async () => {
    const user = userEvent.setup();
    renderWriting();

    await user.click(await findPlayButton());
    await user.click(await screen.findByRole('button', { name: /play it again/i }));

    // No counter, no "2 of 3 replays", no diminishing affordance: §4 gates
    // nothing on the count and VISION.md forbids the pressure that showing it
    // would create.
    expect(screen.queryByText(/replays? used/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/\b2 replays\b/i)).not.toBeInTheDocument();
    expect(screen.getByText(/replays cost you nothing/i)).toBeInTheDocument();
    // And the button is still there to press again.
    expect(
      screen.getByRole('button', { name: /play it again/i }),
    ).toBeEnabled();
  });

  it('starts the count again at the next sentence', async () => {
    const posted: RecordEnglishAttemptInput[] = [];
    const user = userEvent.setup();
    renderWriting({
      sentences: [SENTENCE, SECOND_SENTENCE],
      onAttempt: (input) => posted.push(input),
    });

    await user.click(await findPlayButton());
    await user.click(await screen.findByRole('button', { name: /play it again/i }));
    await user.type(
      screen.getByRole('textbox', { name: /what you heard/i }),
      'Washington was the first President',
    );
    await user.click(screen.getByRole('button', { name: /check my writing/i }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].replayCount).toBe(1);

    await user.click(await screen.findByRole('button', { name: /next sentence/i }));

    // A fresh sentence: the previous sentence's replays are not its own, and
    // the typed answer is gone with them.
    const nextPlay = await findPlayButton();
    expect(screen.getByRole('textbox', { name: /what you heard/i })).toHaveValue('');
    expectSentenceHidden(SECOND_SENTENCE);

    await user.click(nextPlay);
    await user.type(
      screen.getByRole('textbox', { name: /what you heard/i }),
      'Citizens can vote in November',
    );
    await user.click(screen.getByRole('button', { name: /check my writing/i }));

    await waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1].replayCount).toBe(0);
    expect(posted[1].sentenceId).toBe(SECOND_SENTENCE.id);
  });
});

// -----------------------------------------------------------------------------
// 4. The input does not let the platform write the answer
// -----------------------------------------------------------------------------

describe('the input', () => {
  it('has spellcheck, autocorrect, autocapitalize and autocomplete all off', async () => {
    renderWriting();
    await findPlayButton();

    // ON THE REAL ELEMENT. `getByRole('textbox')` returns the `<textarea>`
    // itself, not MUI's wrapper — which is the whole point: the same four names
    // on the wrapper would be ignored by every browser.
    const field = screen.getByRole('textbox', { name: /what you heard/i });
    expect(field.tagName).toBe('TEXTAREA');
    expect(field).toHaveAttribute('spellcheck', 'false');
    expect(field).toHaveAttribute('autocorrect', 'off');
    expect(field).toHaveAttribute('autocapitalize', 'off');
    expect(field).toHaveAttribute('autocomplete', 'off');
  });

  it('scores exactly what was typed', async () => {
    const posted: RecordEnglishAttemptInput[] = [];
    const user = userEvent.setup();
    renderWriting({ onAttempt: (input) => posted.push(input) });

    await findPlayButton();
    await user.type(
      screen.getByRole('textbox', { name: /what you heard/i }),
      '  washington was the frist president  ',
    );
    await user.click(screen.getByRole('button', { name: /check my writing/i }));

    await waitFor(() => expect(posted).toHaveLength(1));
    // Trimmed at the edges and otherwise untouched: no capitalisation fix, no
    // spelling fix. The client that "helped" would be grading its own
    // correction.
    expect(posted[0].responseText).toBe('washington was the frist president');
    expect(posted[0].sentenceId).toBe(SENTENCE.id);
  });
});

// -----------------------------------------------------------------------------
// 5. The result names which words differed, and not only in colour
// -----------------------------------------------------------------------------

describe('the result', () => {
  it('marks per-word differences in text, not colour alone', async () => {
    const user = userEvent.setup();
    renderWriting({
      attemptResult: (input) => ({
        status: 'scored',
        ...scoreFields(input.responseText, mixedDiff()),
        attemptId: 'attempt-2',
        outcome: 'partial',
        answeredAt: '2026-03-01T12:00:00.000Z',
        asrConfidence: null,
        replayCount: input.replayCount ?? 0,
      }),
    });

    await findPlayButton();
    await user.type(
      screen.getByRole('textbox', { name: /what you heard/i }),
      'was our first president sir',
    );
    await user.click(screen.getByRole('button', { name: /check my writing/i }));

    const verdict = await screen.findByRole('status', { name: 'Your result' });

    // THE ACCESSIBLE TEXT. If these marks were carried only by colour, an icon
    // or a text-decoration, none of these strings would be in `textContent`.
    expect(verdict).toHaveTextContent(/missing word:\s*washington/i);
    expect(verdict).toHaveTextContent(/you said our instead of the/i);
    expect(verdict).toHaveTextContent(/extra word:\s*sir/i);
    // And the whole finding in one sentence, for anyone who never reaches the
    // marked-up sentence at all.
    expect(verdict).toHaveTextContent(
      /One word missing, one word changed and one extra word\./i,
    );
  });

  it('reads a near-miss inside tolerance as a pass, with the diff shown', async () => {
    const user = userEvent.setup();
    renderWriting({
      attemptResult: (input) => ({
        status: 'scored',
        ...scoreFields(input.responseText, [
          {
            kind: 'delete',
            reference: 'washington',
            hypothesis: null,
            referenceIndex: 0,
          },
          ...perfectDiff().slice(1),
        ]),
        attemptId: 'attempt-3',
        outcome: 'correct',
        answeredAt: '2026-03-01T12:00:00.000Z',
        asrConfidence: null,
        replayCount: 0,
      }),
    });

    await findPlayButton();
    await user.type(
      screen.getByRole('textbox', { name: /what you heard/i }),
      'was the first president',
    );
    await user.click(screen.getByRole('button', { name: /check my writing/i }));

    // A PASS with no "but" in it — §2.3's rule is compound and the server has
    // already applied it.
    expect(
      await screen.findByRole('heading', { name: /you wrote that sentence/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('status', { name: 'Your result' }),
    ).toHaveTextContent(/missing word:\s*washington/i);
  });

  it('offers only a new sentence, never another go at the revealed one', async () => {
    const user = userEvent.setup();
    renderWriting({ sentences: [SENTENCE, SECOND_SENTENCE] });

    await findPlayButton();
    await user.type(
      screen.getByRole('textbox', { name: /what you heard/i }),
      'Washington was the first President',
    );
    await user.click(screen.getByRole('button', { name: /check my writing/i }));

    expect(
      await screen.findByRole('button', { name: /next sentence/i }),
    ).toBeInTheDocument();
    // A second attempt at a sentence now on screen would be copying practice —
    // the exact substitution this screen exists to prevent.
    expect(
      screen.queryByRole('button', { name: /again|retry|try this one/i }),
    ).not.toBeInTheDocument();
  });
});

// -----------------------------------------------------------------------------
// 6. No dictation available at all
// -----------------------------------------------------------------------------

describe('with no way to dictate the sentence', () => {
  it('explains itself, offers reading practice, and never shows the sentence', async () => {
    removeBrowserSpeech();
    renderWriting();

    expect(
      await screen.findByText(/this browser cannot read the sentence out loud/i),
    ).toBeInTheDocument();
    // The rule, said to the learner in their own terms.
    expect(
      screen.getByText(/copying a sentence you can see is a different, easier task/i),
    ).toBeInTheDocument();

    // Reading practice, as a real link — the other half of the same test, and
    // one that needs no audio at all.
    const link = screen.getByRole('link', { name: /practise reading instead/i });
    expect(link).toHaveAttribute('href', '/practice/reading');

    // THE SENTENCE IS NOT THERE, and it was never even asked for: a sentence
    // this screen can neither speak nor display is one it has no business
    // holding.
    expectSentenceHidden();
    expect(calls.next).toBe(0);

    // Not an AiNotReady, and no blame: the cause is the browser, and the
    // deployment may be configured perfectly.
    expect(screen.queryByText(/administrator/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/your key/i)).not.toBeInTheDocument();
  });

  it('falls back to the premium voice when the browser has none but `speak` is bound', async () => {
    removeBrowserSpeech();
    renderWriting({ speakBound: true });

    // The exercise runs: with `speak` bound there IS a way to hear it, so the
    // unavailable screen would be false.
    await findPlayButton();
    expect(
      screen.queryByText(/this browser cannot read the sentence out loud/i),
    ).not.toBeInTheDocument();
    expectSentenceHidden();
  });

  it('waits for the AI status before saying dictation is unavailable', async () => {
    removeBrowserSpeech();
    renderWriting({ speakBound: true, delayAiStatus: true });

    // `speakBound` is false while the status request is in flight. Rendering
    // the unavailable screen then would flash a message that is not merely
    // noisy but FALSE on this deployment.
    expect(
      await screen.findByRole('status', { name: /getting ready/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/this browser cannot read the sentence out loud/i),
    ).not.toBeInTheDocument();

    await findPlayButton();
  });
});

// -----------------------------------------------------------------------------
// 7. Both themes, at 360px
// -----------------------------------------------------------------------------

describe('presentation', () => {
  it.each([
    ['light', lightTheme],
    ['dark', darkTheme],
  ])('dictates and reveals in the %s theme at 360px', async (_name, theme) => {
    setViewportWidth(PHONE);
    const user = userEvent.setup();
    renderWriting({
      theme,
      attemptResult: (input) => ({
        status: 'scored',
        ...scoreFields(input.responseText, mixedDiff()),
        attemptId: 'attempt-theme',
        outcome: 'partial',
        answeredAt: '2026-03-01T12:00:00.000Z',
        asrConfidence: null,
        replayCount: 0,
      }),
    });

    await user.click(await findPlayButton());
    expectSentenceHidden();

    await user.type(
      screen.getByRole('textbox', { name: /what you heard/i }),
      'was our first president sir',
    );
    await user.click(screen.getByRole('button', { name: /check my writing/i }));

    const verdict = await screen.findByRole('status', { name: 'Your result' });
    expect(verdict).toHaveTextContent(SENTENCE.text);
    expect(verdict).toHaveTextContent(/missing word:\s*washington/i);
  });
});
