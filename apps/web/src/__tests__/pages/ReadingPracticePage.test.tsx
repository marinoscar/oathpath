/**
 * Reading practice (`/practice/reading`) — issue #144, epic #59 / E10.
 *
 * Every assertion here exists because of a specific way this screen could
 * quietly stop being fair or stop being usable:
 *
 *  1. **NOTHING IS SCORED BEFORE THE LEARNER CONFIRMS THE TRANSCRIPT, AND THE
 *     TRANSCRIPT IS EDITABLE.** The load-bearing one. Auto-submitting the
 *     recogniser's guess is the obvious one-less-click simplification, and it
 *     would turn every mishearing of an accent into a recorded reading failure
 *     in the table E6's `english` component reads as fact. The only way to test
 *     "nothing was scored" is to count the POSTs, so that is what these do.
 *  2. **The result is a WORD-LEVEL DIFF, not only a score.** A learner told
 *     "78%" has learned nothing actionable. The diff has to name the words.
 *  3. **THE DIFF IS NOT COLOUR-ONLY AND A SCREEN READER CAN READ IT.** An
 *     explicit acceptance criterion. Asserted by reading the accessible text —
 *     if the marks were carried only by `color`, `textDecoration` or an icon,
 *     `textContent` would say "the" where the finding is "the is missing", and
 *     these assertions would fail.
 *  4. **A low-confidence transcription is a RETRY, and records nothing.**
 *     `misheard` is the absence of a recorded failure, not an outcome
 *     (`docs/specs/english-test.md` §3). The screen must say so and must not
 *     render any of the failure copy.
 *  5. **With `transcribe` unbound the screen still works.** `AiNotReady` names
 *     the role, the microphone is not a dead button because there is no
 *     microphone offered at all, and the self-mark path records a real attempt.
 *  6. **Both themes at 360px**, because this is a phone screen.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { CssBaseline, ThemeProvider } from '@mui/material';

import { server } from '../mocks/server';
import { resetViewportWidth, setViewportWidth } from '../setup';
import { mockAdminUser, mockUser } from '../utils/test-utils';
import { AuthContext } from '../../contexts/AuthContext';
import { AiStatusProvider } from '../../contexts/AiStatusContext';
import { darkTheme, lightTheme } from '../../theme';
import ReadingPracticePage from '../../pages/ReadingPracticePage';
import type {
  AiStatus,
  EnglishAttemptResult,
  EnglishDiffOp,
  EnglishSentence,
  RecordEnglishAttemptInput,
} from '../../types';

// -----------------------------------------------------------------------------
// The microphone, under this test's control
// -----------------------------------------------------------------------------
//
// `useAudioCapture` is mocked rather than driven: jsdom has no `MediaRecorder`
// at all, so the real hook answers `unsupported` before any of the behaviour
// below could happen. Its own failure states are covered exhaustively by
// `hooks/useAudioCapture.test.ts`; what this file needs is a recording that
// arrives. Copied from `PracticeSessionPage.voice.test.tsx`, which needs the
// identical fake for the identical reason.

const captureControl = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const control = {
    listeners,
    state: { status: 'idle' } as {
      status: string;
      blob?: Blob;
      mimeType?: string;
      durationMs?: number;
    },
    releases: 0,
    set(next: typeof control.state) {
      control.state = next;
      listeners.forEach((listener) => listener());
    },
    reset() {
      control.state = { status: 'idle' };
      control.releases = 0;
    },
  };
  return control;
});

vi.mock('../../hooks/useAudioCapture', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { useCallback, useEffect, useState } = await import('react');

  return {
    ...actual,
    useAudioCapture: () => {
      const [, force] = useState(0);
      useEffect(() => {
        const listener = () => force((n) => n + 1);
        captureControl.listeners.add(listener);
        return () => {
          captureControl.listeners.delete(listener);
        };
      }, []);

      // STABLE IDENTITIES, exactly as the real hook's `useCallback`s give: the
      // page builds a reset callback out of `release`, and a fresh function per
      // render would make this fake behave in a way the real hook never does.
      const release = useCallback(() => {
        captureControl.releases += 1;
        captureControl.set({ status: 'idle' });
      }, []);
      const start = useCallback(() => {}, []);
      const stop = useCallback(() => {}, []);

      return {
        state: captureControl.state,
        isRecording: captureControl.state.status === 'recording',
        recording:
          captureControl.state.status === 'recorded'
            ? (captureControl.state.blob ?? null)
            : null,
        start,
        stop,
        release,
      };
    },
  };
});

/** One hold of the button, finished. */
function finishRecording() {
  act(() => {
    captureControl.set({
      status: 'recorded',
      blob: new Blob(['audio'], { type: 'audio/webm' }),
      mimeType: 'audio/webm',
      durationMs: 1500,
    });
  });
}

// -----------------------------------------------------------------------------
// Fixtures — shaped from `apps/api/src/english/dto/*.ts`, field for field
// -----------------------------------------------------------------------------

const API_BASE = '*/api';
const PHONE = 360;

const SENTENCE: EnglishSentence = {
  id: '11111111-1111-4111-8111-111111111111',
  kind: 'reading',
  version: '2008',
  ordinal: 1,
  text: 'George Washington was the first President.',
  vocabTags: ['PEOPLE', 'CIVICS'],
  wordCount: 6,
};

const SECOND_SENTENCE: EnglishSentence = {
  ...SENTENCE,
  id: '22222222-2222-4222-8222-222222222222',
  ordinal: 2,
  text: 'Who was the first President?',
  wordCount: 5,
};

/** The reference tokens, exactly as `normalizeAnswer` produces them (§2.1). */
const REFERENCE_TOKENS = [
  'george',
  'washington',
  'was',
  'the',
  '1',
  'president',
];

/** A clean 6-of-6 alignment. */
function perfectDiff(): EnglishDiffOp[] {
  return REFERENCE_TOKENS.map((token, index) => ({
    kind: 'match' as const,
    reference: token,
    hypothesis: token,
    referenceIndex: index,
  }));
}

/**
 * The spec's own row 4 + row 5, combined: `the` → `our` (a substitution),
 * `george` missing (a deletion), and one word the learner added. Three
 * different op kinds in one alignment, which is what makes the diff assertions
 * below meaningful.
 */
function mixedDiff(): EnglishDiffOp[] {
  return [
    { kind: 'delete', reference: 'george', hypothesis: null, referenceIndex: 0 },
    {
      kind: 'match',
      reference: 'washington',
      hypothesis: 'washington',
      referenceIndex: 1,
    },
    { kind: 'match', reference: 'was', hypothesis: 'was', referenceIndex: 2 },
    {
      kind: 'substitute',
      reference: 'the',
      hypothesis: 'our',
      referenceIndex: 3,
    },
    { kind: 'match', reference: '1', hypothesis: '1', referenceIndex: 4 },
    {
      kind: 'match',
      reference: 'president',
      hypothesis: 'president',
      referenceIndex: 5,
    },
    { kind: 'insert', reference: null, hypothesis: 'sir', referenceIndex: 6 },
  ];
}

function scoreFields(responseText: string, diff: EnglishDiffOp[]) {
  const substitutions = diff.filter((op) => op.kind === 'substitute').length;
  const deletions = diff.filter((op) => op.kind === 'delete').length;
  const insertions = diff.filter((op) => op.kind === 'insert').length;
  const errors = substitutions + deletions + insertions;

  return {
    sentenceId: SENTENCE.id,
    kind: 'reading' as const,
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
  /** `GET /english/next` answers with this. `null` is the empty bank. */
  sentence?: EnglishSentence | null;
  /** Successive answers to `GET /english/next`, for the "next sentence" flow. */
  sentences?: (EnglishSentence | null)[];
  /** Every attempt body the page posted, in order. */
  onAttempt?: (input: RecordEnglishAttemptInput) => void;
  /** `POST /english/attempts` answers with this. */
  attemptResult?: (input: RecordEnglishAttemptInput) => EnglishAttemptResult;
  /** `POST /api/ai/speech/transcribe` answers with this. */
  transcription?: { text: string; confidence: number | null };
  /** `transcribe` bound on this deployment? Defaults to yes. */
  transcribeBound?: boolean;
  /** Signed in as an admin, who is the only one shown the role's name. */
  admin?: boolean;
  theme?: typeof lightTheme;
}

function renderReading(options: Options = {}) {
  const status: AiStatus = {
    userKeyConfigured: true,
    systemReady: true,
    enabled: true,
    providerConfigured: true,
    unboundRoles: options.transcribeBound === false ? ['transcribe'] : [],
  };

  const queue = options.sentences ?? null;
  let nextCall = 0;

  server.use(
    http.get(`${API_BASE}/ai/status`, () => HttpResponse.json({ data: status })),
    http.get(`${API_BASE}/english/next`, () => {
      const sentence = queue
        ? (queue[Math.min(nextCall++, queue.length - 1)] ?? null)
        : (options.sentence !== undefined ? options.sentence : SENTENCE);
      return HttpResponse.json({ data: { sentence } });
    }),
    http.post(`${API_BASE}/ai/speech/transcribe`, () =>
      HttpResponse.json({
        data:
          options.transcription ?? {
            text: 'George Washington was the first President',
            confidence: 0.94,
          },
      }),
    ),
    http.post(`${API_BASE}/english/attempts`, async ({ request }) => {
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
          asrConfidence: input.asrConfidence ?? null,
          replayCount: 0,
        } satisfies EnglishAttemptResult,
      });
    }),
  );

  const auth = {
    user: options.admin ? mockAdminUser : mockUser,
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
          <MemoryRouter initialEntries={['/practice/reading']}>
            <Routes>
              <Route path="/practice/reading" element={<ReadingPracticePage />} />
              <Route path="/practice" element={<h1>Practice</h1>} />
            </Routes>
          </MemoryRouter>
        </AiStatusProvider>
      </AuthContext.Provider>
    </ThemeProvider>,
  );
}

/** Wait for the sentence, hold the button, and let the transcript land. */
async function readAloud() {
  expect(
    await screen.findByRole('heading', { name: SENTENCE.text }),
  ).toBeInTheDocument();
  // The button has to be present before the recording arrives — otherwise the
  // test is asserting against a page that never offered the microphone.
  expect(
    await screen.findByRole('button', { name: /hold to read aloud/i }),
  ).toBeInTheDocument();
  finishRecording();
  return screen.findByRole('textbox', { name: /what you read/i });
}

beforeEach(() => {
  captureControl.reset();
});

afterEach(() => {
  resetViewportWidth();
});

// -----------------------------------------------------------------------------
// 1. The sentence is SHOWN — reading is a test of reading it
// -----------------------------------------------------------------------------

describe('the sentence', () => {
  it('is shown, because reading it is the test', async () => {
    renderReading();

    expect(
      await screen.findByRole('heading', { name: SENTENCE.text }),
    ).toBeInTheDocument();
  });

  it('renders an honest absence, not an error, when the bank is empty', async () => {
    renderReading({ sentence: null });

    expect(
      await screen.findByText(/no reading sentences loaded yet/i),
    ).toBeInTheDocument();
    // Not an alert, not a failure — nothing has gone wrong on the learner's
    // side, so nothing should interrupt a screen reader as though it had.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

// -----------------------------------------------------------------------------
// 2. NOTHING IS SCORED BEFORE THE LEARNER CONFIRMS. The load-bearing one.
// -----------------------------------------------------------------------------

describe('confirm before scoring', () => {
  it('posts NOTHING when a transcript arrives — the learner has to confirm it', async () => {
    const posted: RecordEnglishAttemptInput[] = [];
    renderReading({ onAttempt: (input) => posted.push(input) });

    const field = await readAloud();

    // The transcript is on screen, in an editable field with a real label…
    await waitFor(() =>
      expect(field).toHaveValue('George Washington was the first President'),
    );
    expect(field).toBeEnabled();
    // …and the confirmation step says so in as many words.
    expect(await screen.findByText(/nothing is scored until you/i)).toBeInTheDocument();

    // …and NOT ONE REQUEST has been made. This is the assertion the whole
    // screen exists to keep true.
    expect(posted).toHaveLength(0);
  });

  it('scores the EDITED transcript, not the recogniser guess', async () => {
    const posted: RecordEnglishAttemptInput[] = [];
    const user = userEvent.setup();
    renderReading({
      onAttempt: (input) => posted.push(input),
      transcription: { text: 'George Washington was the worst President', confidence: 0.91 },
    });

    const field = await readAloud();
    await waitFor(() =>
      expect(field).toHaveValue('George Washington was the worst President'),
    );

    await user.clear(field);
    await user.type(field, 'George Washington was the first President');
    await user.click(screen.getByRole('button', { name: /check my reading/i }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].responseText).toBe('George Washington was the first President');
    // And the sentence id it was scored against — the client never sends the
    // sentence TEXT, so it cannot score itself against something else.
    expect(posted[0].sentenceId).toBe(SENTENCE.id);
  });

  it('sends asrConfidence when the recogniser reported one, and omits it when it did not', async () => {
    const withScore: RecordEnglishAttemptInput[] = [];
    const user = userEvent.setup();
    const { unmount } = renderReading({
      onAttempt: (input) => withScore.push(input),
      transcription: { text: 'George Washington was the first President', confidence: 0.88 },
    });

    await readAloud();
    await user.click(await screen.findByRole('button', { name: /check my reading/i }));
    await waitFor(() => expect(withScore).toHaveLength(1));
    expect(withScore[0].asrConfidence).toBe(0.88);

    unmount();
    captureControl.reset();

    // ABSENT IS UNKNOWN. A `0` here is a confident claim that the recogniser
    // was certain it heard nothing, which the server reads as a mishearing and
    // stamps on a perfectly good reading.
    const withoutScore: RecordEnglishAttemptInput[] = [];
    renderReading({
      onAttempt: (input) => withoutScore.push(input),
      transcription: { text: 'George Washington was the first President', confidence: null },
    });

    await readAloud();
    await user.click(await screen.findByRole('button', { name: /check my reading/i }));
    await waitFor(() => expect(withoutScore).toHaveLength(1));
    expect(withoutScore[0]).not.toHaveProperty('asrConfidence');
  });

  it('never sends replayCount — that belongs to the dictated writing segment', async () => {
    const posted: RecordEnglishAttemptInput[] = [];
    const user = userEvent.setup();
    renderReading({ onAttempt: (input) => posted.push(input) });

    await readAloud();
    await user.click(await screen.findByRole('button', { name: /check my reading/i }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).not.toHaveProperty('replayCount');
  });
});

// -----------------------------------------------------------------------------
// 3. The result is a WORD-LEVEL DIFF, and it is legible without colour
// -----------------------------------------------------------------------------

describe('the result', () => {
  it('names which words differed — not only a score', async () => {
    const user = userEvent.setup();
    renderReading({
      attemptResult: (input) => ({
        status: 'scored',
        ...scoreFields(input.responseText, mixedDiff()),
        attemptId: 'attempt-2',
        outcome: 'partial',
        answeredAt: '2026-03-01T12:00:00.000Z',
        asrConfidence: 0.9,
        replayCount: 0,
      }),
    });

    await readAloud();
    await user.click(await screen.findByRole('button', { name: /check my reading/i }));

    const verdict = await screen.findByRole('status', { name: 'Your result' });

    // THE ACCESSIBLE TEXT, not a class name and not a style. If these marks
    // were carried only by colour, an icon or a text-decoration, none of these
    // strings would be in `textContent` and this assertion would fail — which
    // is exactly what makes it the non-colour-only test rather than a
    // rendering smoke test.
    expect(verdict).toHaveTextContent(/missing word:\s*george/i);
    expect(verdict).toHaveTextContent(/you said our instead of the/i);
    expect(verdict).toHaveTextContent(/extra word:\s*sir/i);

    // And the prose summary, which is the whole finding for anyone who never
    // reaches the marked-up sentence at all.
    expect(verdict).toHaveTextContent(
      /One word missing, one word changed and one extra word\./i,
    );

    // The words that DID match are still there, so the diff reads as the
    // sentence rather than as a list of errors.
    expect(verdict).toHaveTextContent(/washington/i);
    expect(verdict).toHaveTextContent(/president/i);
  });

  it('reads a near-miss inside tolerance as a pass, with the diff shown', async () => {
    const user = userEvent.setup();
    renderReading({
      attemptResult: (input) => ({
        status: 'scored',
        // One deletion on a six-token sentence: `errors === 1`,
        // `wer = 0.167 <= 0.34` — `correct` under §2.3's compound rule.
        ...scoreFields(input.responseText, [
          {
            kind: 'delete',
            reference: 'george',
            hypothesis: null,
            referenceIndex: 0,
          },
          ...perfectDiff().slice(1),
        ]),
        attemptId: 'attempt-3',
        outcome: 'correct',
        answeredAt: '2026-03-01T12:00:00.000Z',
        asrConfidence: 0.95,
        replayCount: 0,
      }),
    });

    await readAloud();
    await user.click(await screen.findByRole('button', { name: /check my reading/i }));

    // A PASS, with no "but" in it — the near miss is not dressed up as a
    // partial failure.
    expect(
      await screen.findByRole('heading', { name: /you read that sentence/i }),
    ).toBeInTheDocument();
    // …and the slip is still named, because that is what the learner acts on.
    expect(screen.getByRole('status', { name: 'Your result' })).toHaveTextContent(/missing word:\s*george/i);
  });

  it('says every word matched when nothing differed', async () => {
    const user = userEvent.setup();
    renderReading();

    await readAloud();
    await user.click(await screen.findByRole('button', { name: /check my reading/i }));

    expect(await screen.findByText(/every word matched/i)).toBeInTheDocument();
  });

  it('moves on to the next sentence', async () => {
    const user = userEvent.setup();
    renderReading({ sentences: [SENTENCE, SECOND_SENTENCE] });

    await readAloud();
    await user.click(await screen.findByRole('button', { name: /check my reading/i }));
    await user.click(await screen.findByRole('button', { name: /next sentence/i }));

    expect(
      await screen.findByRole('heading', { name: SECOND_SENTENCE.text }),
    ).toBeInTheDocument();
  });
});

// -----------------------------------------------------------------------------
// 4. `misheard` — a retry, and NO recorded failure
// -----------------------------------------------------------------------------

describe('a transcription we do not believe', () => {
  it('offers a retry, records nothing, and is never rendered as a failure', async () => {
    const user = userEvent.setup();
    renderReading({
      transcription: { text: 'George washing tin was the fist president', confidence: 0.31 },
      attemptResult: (input) => ({
        status: 'misheard',
        ...scoreFields(input.responseText, mixedDiff()),
        asrConfidence: 0.31,
        confidenceThreshold: 0.6,
      }),
    });

    const field = await readAloud();
    await waitFor(() =>
      expect(field).toHaveValue('George washing tin was the fist president'),
    );

    // The low-confidence CONFIRMATION copy, before anything is sent. The raw
    // number is never rendered — "31% confident" is a diagnostic detail a
    // learner cannot act on.
    expect(screen.getByText(/that may not be what you read/i)).toBeInTheDocument();
    expect(screen.queryByText(/31/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /check my reading/i }));

    const verdict = await screen.findByRole('status', { name: 'Your result' });

    // NOTHING WAS RECORDED, said in as many words.
    expect(verdict).toHaveTextContent(/nothing has been recorded/i);
    // …and none of the three outcome headlines is on screen. `misheard` is not
    // an outcome, and folding it into the failure branch is the one mistake
    // this whole arm exists to prevent.
    expect(
      screen.queryByRole('heading', { name: /did not come through/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: /most of that sentence/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: /you read that sentence/i }),
    ).not.toBeInTheDocument();

    // The retry is offered, and taking it clears the words that came with the
    // recording being replaced.
    await user.click(
      await screen.findByRole('button', { name: /^read it again$/i }),
    );
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: /what you read/i })).toHaveValue(''),
    );
    // Same sentence — a retry is another go at THIS one, not a different one.
    expect(screen.getByRole('heading', { name: SENTENCE.text })).toBeInTheDocument();
  });
});

// -----------------------------------------------------------------------------
// 5. `transcribe` unbound — the screen still works
// -----------------------------------------------------------------------------

describe('with the transcribe role unbound', () => {
  it('renders AiNotReady naming the role, and offers no dead microphone', async () => {
    // The role's NAME is admin-facing copy — `AiNotReady` shows it only to a
    // caller holding `system_settings:read`, which is the whole point of that
    // component's split. So this half of the criterion is asserted as an admin.
    renderReading({ transcribeBound: false, admin: true });

    expect(
      await screen.findByText(/checking your reading out loud is not available yet/i),
    ).toBeInTheDocument();
    expect(await screen.findByText(/transcribe/i)).toBeInTheDocument();

    // NOT A DEAD BUTTON — there is no microphone offered at all, rather than
    // one that does nothing when pressed.
    expect(
      screen.queryByRole('button', { name: /hold to read aloud/i }),
    ).not.toBeInTheDocument();
  });

  it('tells an ordinary learner it is not their key, and still shows the sentence', async () => {
    renderReading({ transcribeBound: false });

    expect(
      await screen.findByText(/checking your reading out loud is not available yet/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/not a problem with your key/i)).toBeInTheDocument();
    expect(
      await screen.findByRole('heading', { name: SENTENCE.text }),
    ).toBeInTheDocument();
  });

  it('records a self-marked reading, and says it is weaker evidence', async () => {
    const posted: RecordEnglishAttemptInput[] = [];
    const user = userEvent.setup();
    renderReading({ transcribeBound: false, onAttempt: (input) => posted.push(input) });

    expect(
      await screen.findByText(/nobody but you is checking this one/i),
    ).toBeInTheDocument();

    await user.click(
      await screen.findByRole('button', { name: /i read it word for word/i }),
    );

    await waitFor(() => expect(posted).toHaveLength(1));
    // The learner's own confirmation that the words they produced were the
    // sentence's. No confidence — no recogniser ran, so any value would be a
    // claim about a step that never happened.
    expect(posted[0].responseText).toBe(SENTENCE.text);
    expect(posted[0]).not.toHaveProperty('asrConfidence');

    expect(
      await screen.findByRole('heading', { name: /you read that sentence/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/recorded as your own word, not as a checked recording/i),
    ).toBeInTheDocument();
  });

  it('records NOTHING when the learner says they missed a word, and says so', async () => {
    const posted: RecordEnglishAttemptInput[] = [];
    const user = userEvent.setup();
    renderReading({ transcribeBound: false, onAttempt: (input) => posted.push(input) });

    await user.click(
      await screen.findByRole('button', { name: /i missed or changed a word/i }),
    );

    expect(
      await screen.findByRole('heading', { name: /nothing recorded/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/not on your history as a failure/i),
    ).toBeInTheDocument();
    // The whole point: no row, and therefore no request that could write one.
    expect(posted).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------------
// 6. Both themes, at 360px
// -----------------------------------------------------------------------------

describe('presentation', () => {
  it.each([
    ['light', lightTheme],
    ['dark', darkTheme],
  ])('renders the sentence and the diff in the %s theme at 360px', async (_name, theme) => {
    setViewportWidth(PHONE);
    const user = userEvent.setup();
    renderReading({
      theme,
      attemptResult: (input) => ({
        status: 'scored',
        ...scoreFields(input.responseText, mixedDiff()),
        attemptId: 'attempt-theme',
        outcome: 'partial',
        answeredAt: '2026-03-01T12:00:00.000Z',
        asrConfidence: 0.9,
        replayCount: 0,
      }),
    });

    expect(
      await screen.findByRole('heading', { name: SENTENCE.text }),
    ).toBeInTheDocument();

    await readAloud();
    await user.click(await screen.findByRole('button', { name: /check my reading/i }));

    const verdict = await screen.findByRole('status', { name: 'Your result' });
    expect(verdict).toHaveTextContent(/missing word:\s*george/i);
    expect(verdict).toHaveTextContent(/you said our instead of the/i);
  });
});
