/**
 * The practice session screen's mounted-element hygiene (#358, epic #345).
 *
 * The other `PracticeSessionPage.*` suites assert what the screen SAYS. This
 * one asserts what it MOUNTS, because that is what #358 was actually about:
 * the page said a great deal, almost none of it was the coach, and the excess
 * was structural rather than a matter of wording.
 *
 * Four claims, and each is a rule that would otherwise decay silently — every
 * one of them stays true while a new component is added beside the old ones,
 * and every one of them is invisible in a screenshot.
 *
 *  1. **AT MOST ONE LIVE REGION IS MOUNTED PER SCREEN STATE.** Four could be
 *     at once: the hands-free loop's phase region, the voice region, the
 *     verdict's, and `QuestionAudio`'s own. Assistive technology had four
 *     things competing to announce, which is worse for a screen-reader user
 *     than one region that says the right thing.
 *  2. **AT MOST ONE `QuestionAudio` IS MOUNTED AT A TIME.** Three could be —
 *     the loop's, the question's and the answer's — each rendering a text
 *     button AND a status line, for what is at any moment one thing worth
 *     hearing.
 *  3. **THE VERDICT FITS A PHONE.** Chip, reaction, accepted answers and the
 *     next action, inside one 360x640 viewport plus at most one short scroll —
 *     MEASURED from the rendered DOM by the model below, never estimated.
 *  4. **ACCESSIBILITY DID NOT REGRESS WHILE THINGS WERE REMOVED.** One `h1`, a
 *     sensible heading order under it, a real `<label>` on every control, and
 *     the verdict still announced.
 *
 * These run on the browser's own voice with `speechSynthesis` installed. That
 * is not decoration: without it `QuestionAudio` renders NOTHING at all (see
 * `browserSpeechAvailable`), so a suite that omitted it would count players and
 * regions that were never in the tree and pass no matter what this page did.
 */

import { CssBaseline, ThemeProvider } from '@mui/material';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiStatusProvider } from '../../contexts/AiStatusContext';
import { AuthContext } from '../../contexts/AuthContext';
import PracticeSessionPage from '../../pages/PracticeSessionPage';
import { lightTheme } from '../../theme';
import type {
  AiStatus,
  PracticeAttempt,
  PracticeAttemptResult,
  PracticeQuestion,
  PracticeSession,
  PracticeSessionDetail,
} from '../../types';
import { server } from '../mocks/server';
import { setViewportWidth } from '../setup';
import { mockUser } from '../utils/test-utils';

// -----------------------------------------------------------------------------
// The browser's own voice, which jsdom does not have
// -----------------------------------------------------------------------------

interface FakeUtterance {
  text: string;
  rate: number;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
}

let spoken: FakeUtterance[] = [];

function installSpeechSynthesis() {
  Object.defineProperty(window, 'speechSynthesis', {
    value: {
      cancel: vi.fn(),
      speak: vi.fn((utterance: FakeUtterance) => {
        spoken.push(utterance);
        utterance.onstart?.();
      }),
    },
    configurable: true,
  });
  (window as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance =
    class {
      text: string;
      rate = 1;
      onstart: (() => void) | null = null;
      onend: (() => void) | null = null;
      onerror: ((event: { error: string }) => void) | null = null;
      constructor(text: string) {
        this.text = text;
      }
    };
}

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const API_BASE = '*/api';
const SESSION_ID = 'session-1';
const ACCEPTED = 'the Constitution';
const REACTION = 'Not quite — the phrase they want is the one about the law.';

const QUESTION_1: PracticeQuestion = {
  id: 'question-1',
  number: 1,
  prompt: 'What is the supreme law of the land?',
  categoryId: 'category-1',
  dynamicScope: 'none',
};

const QUESTION_2: PracticeQuestion = {
  id: 'question-2',
  number: 2,
  prompt: 'What does the Constitution do?',
  categoryId: 'category-1',
  dynamicScope: 'none',
};

const SESSION_BASE: PracticeSession = {
  id: SESSION_ID,
  kind: 'quick',
  status: 'in_progress',
  testVersionCode: 'v2008',
  categoryId: null,
  plannedCount: 5,
  startedAt: '2026-03-01T12:00:00.000Z',
  completedAt: null,
  summary: null,
};

function makeAttempt(overrides: Partial<PracticeAttempt> = {}): PracticeAttempt {
  return {
    id: 'attempt-1',
    sessionId: SESSION_ID,
    questionId: QUESTION_1.id,
    question: QUESTION_1,
    source: 'practice',
    inputMode: 'typed',
    promptMode: 'read',
    responseText: 'the big rules',
    outcome: 'incorrect',
    gradingMethod: 'exact',
    revealed: false,
    hintUsed: false,
    durationMs: 4200,
    failureCause: null,
    aiFeedback: null,
    aiUsageEventId: null,
    transcript: null,
    asrConfidence: null,
    retryOfAttemptId: null,
    coachReaction: { text: REACTION, persona: 'supportive' },
    answeredAt: '2026-03-01T12:01:00.000Z',
    answerSnapshot: {
      resolvedAt: '2026-03-01T12:01:00.000Z',
      answerResolution: 'resolved',
      resolvedForStateCode: null,
      answers: [
        {
          id: 'answer-1',
          text: ACCEPTED,
          sort: 0,
          stateCode: null,
          verifiedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    },
    ...overrides,
  };
}

interface Options {
  /** Nothing left to ask — the "finished" screen state. */
  finished?: boolean;
  /** The attempt POST fails, which is the action-error screen state. */
  failAttempt?: boolean;
  /** Roles with no model bound. `transcribe` unbound is the degraded state. */
  unboundRoles?: string[];
}

function renderSession(options: Options = {}) {
  const detail: PracticeSessionDetail = {
    session: SESSION_BASE,
    nextQuestion: options.finished ? null : QUESTION_1,
    progress: { answered: options.finished ? 5 : 0, planned: 5 },
    attempts: [],
  };

  const status: AiStatus = {
    userKeyConfigured: true,
    systemReady: true,
    enabled: true,
    providerConfigured: true,
    // `speak` unbound, so everything below runs on the browser's own voice —
    // the ordinary state of a fresh install.
    unboundRoles: options.unboundRoles ?? ['speak'],
  };

  server.use(
    http.get(`${API_BASE}/ai/status`, () => HttpResponse.json({ data: status })),
    http.get(`${API_BASE}/user-settings`, () =>
      HttpResponse.json({
        data: {
          theme: 'system',
          profile: { displayName: null, useProviderImage: true, customImageUrl: null },
          voice: {},
          updatedAt: '2026-03-01T12:00:00.000Z',
          version: 1,
        },
      }),
    ),
    http.get(`${API_BASE}/practice/sessions/${SESSION_ID}`, () =>
      HttpResponse.json({ data: detail }),
    ),
    http.post(`${API_BASE}/practice/sessions/${SESSION_ID}/attempts`, () => {
      if (options.failAttempt) {
        return HttpResponse.json(
          { error: { code: 'server_error', message: 'That answer could not be recorded.' } },
          { status: 500 },
        );
      }
      const attempt = makeAttempt();
      return HttpResponse.json({
        data: {
          attempt,
          acceptedAnswers: attempt.answerSnapshot.answers,
          nextQuestion: QUESTION_2,
          progress: { answered: 1, planned: 5 },
        } satisfies PracticeAttemptResult,
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
    <ThemeProvider theme={lightTheme}>
      <CssBaseline />
      <AuthContext.Provider value={auth as never}>
        <AiStatusProvider>
          <MemoryRouter initialEntries={[`/practice/sessions/${SESSION_ID}`]}>
            <Routes>
              <Route path="/practice/sessions/:id" element={<PracticeSessionPage />} />
              <Route path="/practice" element={<h1>Practice</h1>} />
            </Routes>
          </MemoryRouter>
        </AiStatusProvider>
      </AuthContext.Provider>
    </ThemeProvider>,
  );
}

async function answerQuestion(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole('heading', { level: 2, name: QUESTION_1.prompt });
  await user.type(screen.getByLabelText(/your answer/i), 'the big rules');
  await user.click(screen.getByRole('button', { name: /^submit$/i }));
}

// -----------------------------------------------------------------------------
// The two counters
// -----------------------------------------------------------------------------

/**
 * Every live region in the document.
 *
 * ALL THREE SPELLINGS, because they are all live regions to a screen reader
 * and a page that swapped one for another would otherwise "fix" this test
 * without fixing anything: `role="status"` (polite), `role="alert"`
 * (assertive — MUI's `<Alert>` default, which is why so much of this page
 * passes `role="presentation"` instead), and an explicit `aria-live`.
 */
function liveRegions(): Element[] {
  return Array.from(
    document.querySelectorAll('[role="status"], [role="alert"], [aria-live]'),
  );
}

/**
 * Every mounted `QuestionAudio`, counted by the one element each always
 * renders: its button.
 *
 * The four names are that component's complete button vocabulary — the default
 * copy, `AttemptFeedback`'s override, and the two transient states.
 */
function audioPlayers(): HTMLElement[] {
  return screen.queryAllByRole('button', {
    name: /^(read the question aloud|read the answer aloud|stop reading|preparing the voice…)$/i,
  });
}

// -----------------------------------------------------------------------------
// The height model
// -----------------------------------------------------------------------------

/**
 * A DETERMINISTIC HEIGHT MODEL FOR A 360x640 PHONE, APPLIED TO THE REAL DOM.
 *
 * jsdom performs no layout: every `getBoundingClientRect()` is zeroes, so a
 * test cannot ask the browser how tall this screen is. The alternative #358
 * forbids is estimating — "roughly 1,500px" is how the page got to 1,500px in
 * the first place, since nothing failed when it grew.
 *
 * So the height is COMPUTED from what is actually rendered. Every block the
 * page mounts contributes its own wrapped line count at a 328px content column
 * (360px viewport, less the 16px padding a `Paper` has at `xs` on each side),
 * using per-variant metrics for a 16px system font. The constants are
 * approximations of a real browser; the INPUTS are not — they are the actual
 * elements, in document order, with the actual text the page put in them.
 *
 * What that buys is the property the acceptance criterion asks for: adding a
 * paragraph, a control or a heading to this screen moves the number, and the
 * number has a budget. It is a regression fence, not a rendering claim.
 */
const VIEWPORT = { width: 360, height: 640 };
/** A `Paper` at `xs` on this page: `p: 2` — 16px each side of a 360px screen. */
const CONTENT_COLUMN_PX = VIEWPORT.width - 16 * 2;
/** Average advance and line box per Typography variant, at 16px root. */
const TYPOGRAPHY: Record<string, { charPx: number; linePx: number }> = {
  h4: { charPx: 15.5, linePx: 42 },
  h5: { charPx: 12.0, linePx: 33 },
  h6: { charPx: 9.6, linePx: 28 },
  subtitle1: { charPx: 7.8, linePx: 26 },
  subtitle2: { charPx: 6.9, linePx: 23 },
  body1: { charPx: 7.8, linePx: 24 },
  body2: { charPx: 6.9, linePx: 21 },
  caption: { charPx: 6.0, linePx: 19 },
  overline: { charPx: 6.4, linePx: 20 },
};
const DEFAULT_METRICS = TYPOGRAPHY.body1;
/** A MUI button's own box, including the margin it sits in. */
const CONTROL_PX = 44;
/** A `size="small"` chip. */
const CHIP_PX = 32;
/** A `<hr>` and the rule around it. */
const DIVIDER_PX = 26;
/** The gap between two stacked blocks. */
const BLOCK_GAP_PX = 8;
/** A text field: its input box, its label and its helper text. */
const TEXT_FIELD_PX = 78;

/** The blocks the model knows how to measure, in document order. */
const MEASURABLE =
  'h1,h2,h3,h4,h5,h6,p,li,button,hr,.MuiChip-label,.MuiInputBase-root,.MuiFormHelperText-root';

function heightOf(el: Element): number {
  if (el.tagName === 'HR') return DIVIDER_PX;
  if (el.tagName === 'BUTTON') return CONTROL_PX;
  if (el.classList.contains('MuiChip-label')) return CHIP_PX;
  if (el.classList.contains('MuiInputBase-root')) return TEXT_FIELD_PX;

  const variant = Array.from(el.classList)
    .map((name) => /^MuiTypography-(\w+)$/.exec(name)?.[1])
    .find((name) => name && name in TYPOGRAPHY);
  const metrics = variant ? TYPOGRAPHY[variant] : DEFAULT_METRICS;
  const perLine = Math.max(1, Math.floor(CONTENT_COLUMN_PX / metrics.charPx));
  const text = (el.textContent ?? '').trim();
  return Math.max(1, Math.ceil(text.length / perLine)) * metrics.linePx;
}

/**
 * How tall `root` renders, down to and including `stopAfter`.
 *
 * Document order, one contribution per block, and nothing nested inside a
 * block already counted (a `<span>` inside a button, a `<p>` inside an alert).
 */
function measure(root: HTMLElement, stopAfter?: Element): number {
  let total = 0;
  const counted: Element[] = [];

  for (const el of Array.from(root.querySelectorAll(MEASURABLE))) {
    if (counted.some((seen) => seen.contains(el))) continue;
    counted.push(el);
    total += heightOf(el) + BLOCK_GAP_PX;
    if (stopAfter && (el === stopAfter || el.contains(stopAfter))) break;
  }

  return total;
}

// -----------------------------------------------------------------------------

beforeEach(() => {
  spoken = [];
  installSpeechSynthesis();
  setViewportWidth(VIEWPORT.width);
});

afterEach(() => {
  Reflect.deleteProperty(window, 'speechSynthesis');
  Reflect.deleteProperty(window, 'SpeechSynthesisUtterance');
  vi.restoreAllMocks();
});

// -----------------------------------------------------------------------------
// 1. One live region per screen state
// -----------------------------------------------------------------------------

describe('one live region per screen state', () => {
  it('mounts exactly one while a question is open, and the page owns it', async () => {
    renderSession();
    await screen.findByRole('heading', { level: 2, name: QUESTION_1.prompt });

    // The question's player renders its status line without claiming a region
    // of its own, so the only region on screen is the page's — mounted from
    // the first render and empty until there is something to say, which is the
    // justification for the one always-mounted empty element here.
    expect(liveRegions()).toHaveLength(1);
    expect(liveRegions()[0]).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    expect(
      screen.getByRole('button', { name: /read the question aloud/i }),
    ).toBeInTheDocument();
  });

  it('still mounts exactly one when the verdict lands, and the verdict is in it', async () => {
    const user = userEvent.setup();
    renderSession();
    await answerQuestion(user);

    const region = await screen.findByRole('status');
    await waitFor(() => expect(region).toHaveTextContent('Not a match'));

    // ONE region, with everything that must be announced inside it: the
    // verdict, the coach's line, the accepted answer. The reaction's own
    // `role="status"` and the answer player's were both removed rather than
    // left nested — a live region inside a live region is read twice.
    expect(liveRegions()).toHaveLength(1);
    expect(region).toHaveTextContent(REACTION);
    expect(region).toHaveTextContent(ACCEPTED);
  });

  it('still mounts exactly one when the action fails, and the failure is in it', async () => {
    const user = userEvent.setup();
    renderSession({ failAttempt: true });
    await answerQuestion(user);

    const region = await screen.findByRole('status');
    // The message is whatever the API client made of the 500; what this test
    // is about is WHERE it lands, so it asserts the error alert is inside the
    // one region rather than pinning a sentence the client owns.
    await waitFor(() =>
      expect(region.querySelector('.MuiAlert-root')).not.toBeNull(),
    );
    expect(region.textContent?.trim()).not.toBe('');

    // The error used to be its own `role="alert"` above the progress bar — a
    // second live region, competing to announce, two screens from the button
    // that produced it. A verdict and a failure are the same event from the
    // learner's side, so they share the region.
    expect(liveRegions()).toHaveLength(1);
  });

  it('mounts exactly one while loading, and one when the session runs out', async () => {
    const { unmount } = renderSession({ finished: true });
    // Loading: the spinner's own labelled region, and nothing else.
    expect(liveRegions()).toHaveLength(1);

    await screen.findByText(/that’s everything in this session/i);
    expect(liveRegions()).toHaveLength(1);
    unmount();
  });

  it('adds the one documented exception when `transcribe` is unbound', async () => {
    // `VoiceUnavailableNotice` mounts at page level, outside the region above,
    // and announces itself on purpose — `AiNotReady`'s `alertRole` prop says
    // in as many words that this call site must not pass `presentation`,
    // because a control vanishing with no explanation is the failure it
    // exists to prevent. It is a ONE-SHOT arrival that never changes again,
    // so it never competes with the page's region for a second announcement.
    //
    // Asserted rather than ignored, so that if a THIRD region ever appears in
    // this state somebody has to come here and justify it.
    renderSession({ unboundRoles: ['speak', 'transcribe'] });
    await screen.findByRole('heading', { level: 2, name: QUESTION_1.prompt });

    await waitFor(() => expect(liveRegions()).toHaveLength(2));
    expect(screen.getByRole('alert')).toHaveTextContent(/not available yet/i);
  });
});

// -----------------------------------------------------------------------------
// 2. One QuestionAudio at a time
// -----------------------------------------------------------------------------

describe('one question player at a time', () => {
  it('never mounts a second player through a whole question', async () => {
    const user = userEvent.setup();
    renderSession();

    await screen.findByRole('heading', { level: 2, name: QUESTION_1.prompt });
    expect(audioPlayers()).toHaveLength(1);

    await answerQuestion(user);
    await screen.findByRole('heading', { level: 3, name: /accepted answer/i });

    // The verdict is up: the question's player is gone and the answer's is
    // the one that is left. Both at once is two buttons and two status lines
    // for one sentence anybody would play.
    expect(audioPlayers()).toHaveLength(1);
    expect(
      screen.getByRole('button', { name: /read the answer aloud/i }),
    ).toBeInTheDocument();

    // And it comes back, pointed at the next question.
    await user.click(screen.getByRole('button', { name: /next question/i }));
    await screen.findByRole('heading', { level: 2, name: QUESTION_2.prompt });
    expect(audioPlayers()).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: /read the question aloud/i }));
    expect(spoken[spoken.length - 1].text).toBe(QUESTION_2.prompt);
  });
});

// -----------------------------------------------------------------------------
// 3. The verdict fits a phone
// -----------------------------------------------------------------------------

describe('a full verdict on a 360x640 phone', () => {
  it('fits one viewport, chip to next action', async () => {
    const user = userEvent.setup();
    const { container } = renderSession();
    await answerQuestion(user);

    const region = await screen.findByRole('status');
    await waitFor(() => expect(region).toHaveTextContent('Not a match'));

    // Everything the criterion names is present before it is measured — a
    // budget met by dropping the accepted answer would be no achievement.
    expect(within(region).getByText('Not a match')).toBeInTheDocument();
    expect(within(region).getByText(REACTION)).toBeInTheDocument();
    expect(within(region).getByText(ACCEPTED)).toBeInTheDocument();
    const next = within(region).getByRole('button', { name: /next question/i });

    // MEASURED, AND THE NUMBERS ARE THE POINT: at the time of writing this
    // block measures 354px of a 640px screen, and 844px from the top of the
    // page down to the next action. The budgets below leave headroom on
    // purpose — this is a fence against the page growing back, not a claim
    // that 354 is the right number — and both are stated in the failure
    // message so a regression reports what it cost rather than only that it
    // happened.
    const verdictPx = measure(region);
    expect(verdictPx, `verdict block measured ${verdictPx}px`).toBeLessThanOrEqual(
      VIEWPORT.height,
    );

    // AND FROM THE TOP OF THE PAGE: what a learner actually scrolls through to
    // reach the next action is everything above the verdict too — the title,
    // the progress line, the question, the field that still holds their
    // answer. One viewport plus one SHORT scroll, where "short" is half a
    // screen and not a second full one.
    const toNextActionPx = measure(container.firstElementChild as HTMLElement, next);
    expect(
      toNextActionPx,
      `top of page to the next action measured ${toNextActionPx}px`,
    ).toBeLessThanOrEqual(VIEWPORT.height + VIEWPORT.height / 2);
  });

  it('mounts no dead control between the answer and the verdict', async () => {
    // Submit, Show me the answer and Skip are all `disabled` once a result is
    // in — three dead controls, three tab stops and three rows of height
    // between the learner's answer and the verdict about it. They are removed
    // rather than disabled.
    const user = userEvent.setup();
    renderSession();
    await answerQuestion(user);
    await screen.findByRole('heading', { level: 3, name: /accepted answer/i });

    for (const name of [/^submit$/i, /show me the answer/i, /^skip$/i]) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
    for (const button of screen.getAllByRole('button')) {
      expect(button).toBeEnabled();
    }
  });
});

// -----------------------------------------------------------------------------
// 4. Accessibility did not regress while things were removed
// -----------------------------------------------------------------------------

describe('accessibility under the verdict', () => {
  it('keeps one h1, the heading order under it, and a label on every control', async () => {
    const user = userEvent.setup();
    renderSession();
    await answerQuestion(user);
    await screen.findByRole('heading', { level: 3, name: /accepted answer/i });

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Practice');
    expect(
      screen.getByRole('heading', { level: 2, name: QUESTION_1.prompt }),
    ).toBeInTheDocument();
    // The coach's line is `h6`-SIZED and is not a heading: the size is design,
    // the level is semantics, and a coach's aside must not insert itself into
    // the outline a screen-reader user navigates by.
    expect(screen.getByText(REACTION).tagName).toBe('P');

    // NO SKIPPED LEVELS. The screen carries an `h1` (the destination), an `h2`
    // (the question) and `h3`s under it — the accepted-answer label and the
    // explain panel's — and nothing deeper.
    const levels = new Set(
      screen
        .getAllByRole('heading')
        .map((heading) => Number(heading.tagName.slice(1))),
    );
    expect([...levels].sort()).toEqual([1, 2, 3]);

    // A real `<label>`, still, on the field that holds the graded answer.
    expect(screen.getByLabelText(/your answer/i)).toBeInTheDocument();
    // And every button carries its own name — no icon-only control appeared
    // while prose was being removed.
    for (const button of screen.getAllByRole('button')) {
      expect(button).toHaveAccessibleName();
    }
  });

  it('keeps the folded prose reachable, and says so with `aria-expanded`', async () => {
    const user = userEvent.setup();
    renderSession();
    await answerQuestion(user);
    await screen.findByRole('heading', { level: 3, name: /accepted answer/i });

    const toggle = screen.getByRole('button', { name: /how this was graded/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(/we can only count your own call/i)).toBeNull();

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(
      screen.getByText(/we can only count your own call/i),
    ).toBeInTheDocument();
    // Revealed INSIDE the one live region, so it is announced as that region's
    // change rather than by a region of its own.
    expect(liveRegions()).toHaveLength(1);
  });
});
