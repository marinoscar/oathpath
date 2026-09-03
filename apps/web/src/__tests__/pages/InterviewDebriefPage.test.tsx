/**
 * The mock interview debrief (`/practice/interviews/:id/debrief`), issue #145,
 * epic #57 / E8.
 *
 * WHAT THESE TESTS PROTECT, in order of how quietly each would break:
 *
 *  1. **THE PASS MARK COMES FROM THE RESPONSE, NEVER FROM THE BUNDLE.**
 *     `docs/specs/mock-interview.md` §11: a client that hardcoded `6` would be
 *     exactly the "a threshold in code is a threshold that will one day
 *     disagree with the seeded data" failure the engine reads
 *     `civics_test_versions` to avoid, reintroduced one layer up. It is checked
 *     by rendering a debrief whose threshold is NOT either seeded default and
 *     requiring that number on screen — a page with a literal in it renders a
 *     perfectly plausible screen and fails only here.
 *  2. **The web computes no score and no pass rule.** Checked by rendering a
 *     debrief whose numbers are internally arbitrary — a `passed: true` whose
 *     own counts do not support it, a `delta` that is not the difference
 *     between its own two scores — and requiring the page to show exactly what
 *     it was given. That assertion only passes for a page that derives nothing.
 *  3. **The copy rules (§11.1), as acceptance criteria.** Honest about a failed
 *     section without being punitive: name the questions, not the person. The
 *     forbidden vocabulary is derived explicitly below, with `VISION.md` cited.
 *  4. **The three stop reasons read differently**, and the one a learner is
 *     most likely to misread as a bug — `threshold_unreachable` — says why the
 *     section ended.
 *  5. **The skipped phases are named**, so nobody believes they rehearsed the
 *     reading and writing tests (§2.4).
 *  6. **A `debrief` of null is not an error**: an unfinished interview sends
 *     the learner back into it.
 *  7. **Accessibility and width**: one `h1`, a sensible heading order under it,
 *     and legible at 360px.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { CssBaseline, ThemeProvider, createTheme } from '@mui/material';

import { server } from '../mocks/server';
import { setViewportWidth } from '../setup';
import { mockUser } from '../utils/test-utils';
import { AuthContext } from '../../contexts/AuthContext';
import InterviewDebriefPage from '../../pages/InterviewDebriefPage';
import type {
  Interview,
  InterviewCivicsResult,
  InterviewDebrief,
  InterviewDebriefQuestion,
  InterviewDetail,
  InterviewReadinessSummary,
} from '../../types';

const API_BASE = '*/api';
const INTERVIEW_ID = 'interview-1';
const PHONE = 360;

const INTERVIEW: Interview = {
  id: INTERVIEW_ID,
  mode: 'text',
  status: 'completed',
  testVersionCode: 'v2008',
  seniorExemption: false,
  transcriptRetained: false,
  startedAt: '2026-03-01T12:00:00.000Z',
  completedAt: '2026-03-01T12:20:00.000Z',
  civicsAsked: 8,
  civicsCorrect: 4,
  passedCivics: false,
};

/**
 * A deliberately NON-DEFAULT pass rule.
 *
 * Neither seeded version uses these numbers — `v2008` is 6 of 10 and `v2025` is
 * 12 of 20 — so a page carrying a literal for either cannot render this
 * fixture's sentence. That is the whole point of choosing them.
 */
const ODD_THRESHOLD = 7;
const ODD_PLANNED = 11;

const FAILED_CIVICS: InterviewCivicsResult = {
  planned: ODD_PLANNED,
  asked: 8,
  correct: 4,
  threshold: ODD_THRESHOLD,
  passed: false,
  stoppedEarly: true,
  stopReason: 'threshold_unreachable',
};

const QUESTIONS: InterviewDebriefQuestion[] = [
  {
    questionId: 'question-1',
    number: 1,
    prompt: 'What is the supreme law of the land?',
    categoryName: 'American Government',
    outcome: 'correct',
    acceptedAnswers: ['the Constitution'],
  },
  {
    questionId: 'question-2',
    number: 12,
    prompt: 'Who is the Speaker of the House of Representatives now?',
    categoryName: 'American Government',
    outcome: 'incorrect',
    // More than one accepted answer, so the "any one of these" label has to
    // appear — several civics questions genuinely have several.
    acceptedAnswers: ['Mike Johnson', 'Johnson'],
  },
  {
    questionId: 'question-3',
    number: 58,
    prompt: 'What is one reason colonists came to America?',
    categoryName: 'American History',
    outcome: 'skipped',
    acceptedAnswers: ['freedom', 'political liberty', 'religious freedom'],
  },
];

const READINESS: InterviewReadinessSummary = {
  score: 61,
  previousScore: 54,
  delta: 7,
  capReason: 'typed_only',
  capMessage:
    'Your score is limited until you practise out loud and complete mock interviews.',
  interviewComponent: { value: 0.5, evidenceCount: 1 },
};

function debrief(overrides: Partial<InterviewDebrief> = {}): InterviewDebrief {
  return {
    civics: FAILED_CIVICS,
    questions: QUESTIONS,
    phases: [
      { kind: 'smalltalk', status: 'completed' },
      { kind: 'n400', status: 'completed' },
      { kind: 'civics', status: 'completed' },
      { kind: 'reading', status: 'skipped' },
      { kind: 'writing', status: 'skipped' },
      { kind: 'closing', status: 'completed' },
    ],
    focusAreas: ['American Government', 'American History'],
    readiness: READINESS,
    ...overrides,
  };
}

function detail(overrides: Partial<InterviewDetail> = {}): InterviewDetail {
  return {
    interview: INTERVIEW,
    turns: [],
    progress: { civicsAsked: 8, civicsPlanned: ODD_PLANNED },
    awaitingCompletion: false,
    debrief: debrief(),
    ...overrides,
  };
}

interface RenderOptions {
  detail?: InterviewDetail;
  status?: number;
}

function renderDebrief({ detail: body, status }: RenderOptions = {}) {
  server.use(
    http.get(`${API_BASE}/interviews/${INTERVIEW_ID}`, () => {
      if (status && status >= 400) {
        return HttpResponse.json(
          { message: 'That interview could not be loaded.' },
          { status },
        );
      }
      return HttpResponse.json({ data: body ?? detail() });
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
    <ThemeProvider theme={createTheme()}>
      <CssBaseline />
      <AuthContext.Provider value={auth as never}>
        <MemoryRouter
          initialEntries={[`/practice/interviews/${INTERVIEW_ID}/debrief`]}
        >
          <Routes>
            <Route
              path="/practice/interviews/:id/debrief"
              element={<InterviewDebriefPage />}
            />
            <Route
              path="/practice/interviews/:id"
              element={<div>the interview screen</div>}
            />
            <Route
              path="/practice/interviews"
              element={<div>the start screen</div>}
            />
            <Route path="/practice" element={<div>Practice destination</div>} />
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>
    </ThemeProvider>,
  );
}

/** Mount, and wait for the read to settle so nothing asserts against a spinner. */
async function mounted(options?: RenderOptions) {
  const rendered = renderDebrief(options);
  await waitFor(() =>
    expect(screen.queryByRole('status', { name: /loading/i })).not.toBeInTheDocument(),
  );
  return rendered;
}

// -----------------------------------------------------------------------------
// 1. THE LOAD-BEARING ONE: the threshold comes from the response
// -----------------------------------------------------------------------------

describe('InterviewDebriefPage — the pass mark is the server’s', () => {
  it('names the threshold and the plan from the response, not from a constant', async () => {
    const { container } = await mounted();

    // The counts sentence carries both numbers, and both are the fixture's —
    // neither is a seeded default, so a literal in the bundle cannot produce
    // this string.
    expect(
      screen.getByText(
        new RegExp(`${ODD_THRESHOLD} of ${ODD_PLANNED} is the pass mark`, 'i'),
      ),
    ).toBeInTheDocument();

    // And the two numbers a page might plausibly have hardcoded are nowhere on
    // screen as a pass mark. `6 of 10` and `12 of 20` are the two seeded pass
    // rules; either appearing here means something re-typed one.
    expect(container.textContent).not.toContain('6 of 10 is the pass mark');
    expect(container.textContent).not.toContain('12 of 20 is the pass mark');
  });

  it('names the threshold again in the early-stop explanation', async () => {
    // The stop sentence is the second place the number appears, and the place
    // it would be easiest to hardcode — it reads as prose rather than as data.
    await mounted();

    expect(
      screen.getByText(
        new RegExp(`${ODD_THRESHOLD} correct answers are needed to pass`, 'i'),
      ),
    ).toBeInTheDocument();
  });

  it('reports how many were asked, not how many were planned', async () => {
    // The whole product feature of the early stop: `asked` and `planned` are
    // different numbers, and reporting the plan as the ask would tell a learner
    // they left questions unanswered that were never put to them.
    await mounted();

    expect(
      screen.getByText(/4 of 8 answered correctly/i),
    ).toBeInTheDocument();
  });
});

// -----------------------------------------------------------------------------
// 2. The web computes nothing
// -----------------------------------------------------------------------------

describe('InterviewDebriefPage — it renders what it was given', () => {
  it('shows a debrief whose numbers are internally arbitrary, exactly as sent', async () => {
    // NOTHING HERE IS SELF-CONSISTENT, deliberately: `passed` is true against
    // counts that would not pass its own threshold, and `delta` is not the
    // difference between its own two scores. A page that derived either would
    // disagree with at least one of these assertions; a page that renders the
    // response cannot.
    await mounted({
      detail: detail({
        debrief: debrief({
          civics: {
            planned: 9,
            asked: 9,
            correct: 1,
            threshold: 8,
            passed: true,
            stoppedEarly: false,
            stopReason: 'all_asked',
          },
          readiness: {
            score: 40,
            previousScore: 90,
            delta: 7,
            capReason: null,
            capMessage: null,
            interviewComponent: { value: 1, evidenceCount: 3 },
          },
        }),
      }),
    });

    // The server said passed. The page says passed.
    expect(screen.getByText('Civics section passed')).toBeInTheDocument();
    expect(screen.getByText(/1 of 9 answered correctly/i)).toBeInTheDocument();
    expect(screen.getByText(/8 of 9 is the pass mark/i)).toBeInTheDocument();

    // The server said 40, and up 7 from 90. Neither follows from the other, and
    // both are on screen.
    expect(screen.getByText('40')).toBeInTheDocument();
    expect(screen.getByText('Up 7 from 90.')).toBeInTheDocument();
    // Never the difference a browser would have computed.
    expect(screen.queryByText(/50/)).toBeNull();
  });

  it('says nothing about a change when there is no previous score', async () => {
    // A first snapshot: "+0" or "no change" would claim a measurement nobody
    // made.
    const { container } = await mounted({
      detail: detail({
        debrief: debrief({
          readiness: { ...READINESS, previousScore: null, delta: null },
        }),
      }),
    });

    expect(container.textContent).not.toMatch(/from \d+/);
    expect(container.textContent).not.toMatch(/unchanged/i);
  });

  it('renders the cap message verbatim, and only when the server caps', async () => {
    await mounted();
    expect(screen.getByText(READINESS.capMessage as string)).toBeInTheDocument();

    // And not at all when the cap has lifted — which is exactly what passing a
    // mock interview does (§13).
    const lifted = await mounted({
      detail: detail({
        debrief: debrief({
          readiness: { ...READINESS, capReason: null, capMessage: null },
        }),
      }),
    });
    expect(
      within(lifted.container).queryByText(READINESS.capMessage as string),
    ).toBeNull();
  });

  it('shows the interview component on its own scale, not rescaled', async () => {
    await mounted();

    expect(screen.getByText('Mock interviews passed: 1')).toBeInTheDocument();
    // `0.5 of 1`, never `50%`: a percentage would be this page rescaling a
    // measurement it did not take.
    expect(screen.getByText('Interview component: 0.5 of 1')).toBeInTheDocument();
  });
});

// -----------------------------------------------------------------------------
// 3. The copy rules — §11.1 as acceptance criteria
// -----------------------------------------------------------------------------

/**
 * The vocabulary a debrief must never use about a learner.
 *
 * Derived here explicitly, rather than by importing something, because the
 * point is to state the rule in the test that enforces it.
 *
 * `VISION.md`, Product Principle 9 — "Respect the User: Never patronize,
 * shame, or underestimate the learner" — and its companion rule that this
 * product "should never create pressure, shame, fear, or unhealthy compulsion".
 * `docs/specs/mock-interview.md` §11.1 applies both to this exact screen: the
 * debrief "never characterizes the learner ('you struggled with government
 * questions') in place of characterizing the evidence ('these four questions
 * were missed')".
 *
 * Three families, and each is a real temptation on a failure screen:
 *
 *   * **Judgment** — characterising the person instead of the evidence.
 *   * **Faux-cheerful minimising** — softening a real result into vagueness,
 *     which §11.1 rules out in the same breath as sharpening it into judgment.
 *   * **Unearned instruction** — telling a learner what they "should have"
 *     done, which is the shape patronising advice takes.
 */
const FORBIDDEN_JUDGMENT_VOCABULARY: string[] = [
  // Judgment about the person.
  'struggled',
  'struggling',
  'you failed',
  'you were wrong',
  'poor',
  'poorly',
  'weak',
  'weakness',
  'careless',
  'disappointing',
  'unfortunately',
  // Faux-cheerful minimising.
  "don't worry",
  'no big deal',
  'nearly there',
  'so close',
  'good try',
  'keep your chin up',
  // Unearned instruction.
  'you should have',
  'you need to',
  'you must',
];

describe('InterviewDebriefPage — the copy rules (§11.1)', () => {
  it('names the questions, never the person, on a failed section', async () => {
    const { container } = await mounted();

    // The verdict is stated plainly. Nothing is softened away.
    expect(screen.getByText('Civics section not passed')).toBeInTheDocument();
    // And the sentence that introduces the list points at the QUESTIONS.
    expect(
      screen.getByText(/the questions that were missed are below/i),
    ).toBeInTheDocument();

    const text = (container.textContent ?? '').toLowerCase();
    for (const word of FORBIDDEN_JUDGMENT_VOCABULARY) {
      expect(text, `the debrief uses the judgment word "${word}"`).not.toContain(
        word.toLowerCase(),
      );
    }
  });

  it('uses no exclamation mark anywhere on a failure', async () => {
    // §11.1 and `VISION.md`: a failed rehearsal is real information, and
    // punctuating it with cheer is the manufactured tone this product forbids.
    const { container } = await mounted();
    expect(container.textContent).not.toContain('!');
  });

  it('states the focus areas as evidence, not as a verdict about the learner', async () => {
    await mounted();

    // The server's own deterministic aggregation, introduced by a sentence
    // about the answers rather than about the person.
    expect(
      screen.getByText(/at least one answer was missed in each of these sections/i),
    ).toBeInTheDocument();
    const focus = within(
      screen.getByRole('region', { name: /where to focus/i }),
    );
    expect(focus.getByText('American Government')).toBeInTheDocument();
    expect(focus.getByText('American History')).toBeInTheDocument();
  });

  it('adds no congratulatory sentence when the section was passed', async () => {
    const { container } = await mounted({
      detail: detail({
        debrief: debrief({
          civics: { ...FAILED_CIVICS, passed: true, correct: 7 },
          focusAreas: [],
        }),
      }),
    });

    expect(screen.getByText('Civics section passed')).toBeInTheDocument();
    // The verdict already said it. A second sentence celebrating it is the
    // manufactured cheer `VISION.md` rules out.
    expect(container.textContent).not.toContain('!');
    expect(
      screen.queryByText(/the questions that were missed/i),
    ).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// 4. The three stop reasons read differently
// -----------------------------------------------------------------------------

describe('InterviewDebriefPage — why the section ended', () => {
  it('explains a section that ended because passing was no longer possible', async () => {
    // THE ONE A LEARNER IS MOST LIKELY TO MISREAD AS A BUG: a short, failed
    // section with no explanation is indistinguishable from the interview
    // breaking.
    await mounted();

    expect(
      screen.getByText(/enough had been missed by that point/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/the real interview stops there too/i)).toBeInTheDocument();
  });

  it('explains a section that ended because the pass mark was reached', async () => {
    await mounted({
      detail: detail({
        debrief: debrief({
          civics: {
            ...FAILED_CIVICS,
            asked: 7,
            correct: 7,
            passed: true,
            stopReason: 'threshold_reached',
          },
          focusAreas: [],
        }),
      }),
    });

    expect(
      screen.getByText(/the officer stopped after 7 of 11 questions/i),
    ).toBeInTheDocument();
    // Different wording from the unreachable case — not one sentence with a
    // swapped adjective.
    expect(screen.queryByText(/no longer possible/i)).toBeNull();
  });

  it('says plainly when every planned question was asked', async () => {
    await mounted({
      detail: detail({
        debrief: debrief({
          civics: {
            ...FAILED_CIVICS,
            asked: ODD_PLANNED,
            stoppedEarly: false,
            stopReason: 'all_asked',
          },
        }),
      }),
    });

    expect(
      screen.getByText(`All ${ODD_PLANNED} planned questions were asked.`),
    ).toBeInTheDocument();
  });
});

// -----------------------------------------------------------------------------
// 5. Questions, and the phases that did not run
// -----------------------------------------------------------------------------

describe('InterviewDebriefPage — what was asked and what was covered', () => {
  it('lists every question with its outcome and accepted answers', async () => {
    await mounted();

    expect(
      screen.getByText('What is the supreme law of the land?'),
    ).toBeInTheDocument();
    expect(screen.getByText('the Constitution')).toBeInTheDocument();
    expect(screen.getByText('Question 12')).toBeInTheDocument();
    // A skip is shown as a skip, never omitted or left blank — it is real
    // evidence of what "I have no idea" looked like.
    expect(screen.getByText('Skipped')).toBeInTheDocument();
    // The label that stops a learner concluding they had to produce all three.
    expect(screen.getAllByText(/any one of these is accepted/i).length).toBeGreaterThan(0);
  });

  it('names the reading and writing tests as not part of this rehearsal', async () => {
    // §2.4: a learner who is never told those segments exist could walk into
    // the real interview believing they rehearsed something they never saw.
    await mounted();

    const covered = within(
      screen.getByRole('region', { name: /what this rehearsal covered/i }),
    );
    expect(covered.getByText('Reading test')).toBeInTheDocument();
    expect(covered.getByText('Writing test')).toBeInTheDocument();
    expect(
      covered.getAllByText('Not part of this rehearsal yet'),
    ).toHaveLength(2);
  });
});

// -----------------------------------------------------------------------------
// 6. A null debrief is not an error
// -----------------------------------------------------------------------------

describe('InterviewDebriefPage — no debrief yet', () => {
  it('sends the learner back into an interview that is still running', async () => {
    renderDebrief({
      detail: detail({
        interview: { ...INTERVIEW, status: 'in_progress', completedAt: null },
        debrief: null,
      }),
    });

    expect(await screen.findByText('the interview screen')).toBeInTheDocument();
  });

  it('says what happened to an interview that was never finished', async () => {
    await mounted({
      detail: detail({
        interview: { ...INTERVIEW, status: 'abandoned', completedAt: null },
        debrief: null,
      }),
    });

    expect(
      screen.getByText(/never finished, so there is no debrief for it/i),
    ).toBeInTheDocument();
    // Nothing is invented in place of the result it never had.
    expect(screen.queryByText(/pass mark/i)).toBeNull();
  });

  it('renders a failed read as prose with a retry, never a blank page', async () => {
    await mounted({ status: 500 });

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /could not be loaded/i,
    );
    expect(screen.getByRole('button', { name: /try again/i })).toBeEnabled();
  });
});

// -----------------------------------------------------------------------------
// 7. Accessibility and width
// -----------------------------------------------------------------------------

describe('InterviewDebriefPage — accessibility and width', () => {
  it('has one h1 and a sensible heading order under it', async () => {
    await mounted();

    const h1s = screen.getAllByRole('heading', { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent('Interview debrief');

    // Every band is an `h2`; each question is an `h3` and its answer label an
    // `h4`, so moving by heading walks result → questions → this question →
    // its accepted answer.
    const h2s = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(h2s).toContain('How the civics section went');
    expect(h2s).toContain('Question by question');
    expect(h2s).toContain('What this rehearsal covered');
    expect(h2s).toContain('Readiness');
    expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(QUESTIONS.length);
    expect(screen.getAllByRole('heading', { level: 4 })).toHaveLength(QUESTIONS.length);
  });

  it('renders at 360px', async () => {
    setViewportWidth(PHONE);
    await mounted();

    expect(screen.getByRole('heading', { level: 1 })).toBeVisible();
    expect(screen.getByText('Civics section not passed')).toBeVisible();
    expect(
      screen.getByRole('link', { name: /try another interview/i }),
    ).toBeVisible();

    setViewportWidth(1440);
  });
});
