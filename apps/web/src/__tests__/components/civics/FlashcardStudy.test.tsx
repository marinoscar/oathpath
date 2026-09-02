/**
 * Flashcard study mode (issue #121, epic #51).
 *
 * WHAT THESE TESTS ACTUALLY PROTECT:
 *
 *  1. **There is no scoring, and there must never be.** This is the one
 *     assertion in the suite written as a NEGATIVE, and it is written that way
 *     because the failure it guards against is an ADDITION, not a regression:
 *     the natural next commit on a flashcard screen is a "did you get it?"
 *     pair of buttons, and every positive test in this file would still pass
 *     with one on screen. `/learn` is `VISION.md`'s "See it → Understand it",
 *     deliberately before any recall; grading a learner's first encounter with
 *     material they have not studied turns reading into an unannounced test.
 *     Recall, grading and scheduling are E3–E5.
 *  2. **Prompt first, answer only on request.** A card that arrived revealed
 *     would never be a prompt, and neither would one that leaked the previous
 *     card's answer into the next.
 *  3. **The answer is ANNOUNCED.** The live region is asserted to exist BEFORE
 *     the reveal, because a region inserted at the same moment as its content
 *     is commonly missed entirely by assistive technology — the bug is in the
 *     mounting order, not in the markup, and only a before/after assertion sees
 *     it.
 *  4. **The reveal is a real `<button>`, after the prompt, at 360px.** This is
 *     the screen most likely to be used one-handed on a phone.
 *  5. **`state_required` is honoured here too**, not only on the detail view —
 *     a forked flashcard back is exactly where "just show the national answer"
 *     would creep in unreviewed.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router-dom';
import { CssBaseline, ThemeProvider, createTheme } from '@mui/material';

import { server } from '../../mocks/server';
import { setViewportWidth } from '../../setup';
import { FlashcardStudy } from '../../../components/civics/FlashcardStudy';
import {
  GOVERNOR_STATE_REQUIRED,
  ONE_BRANCH,
  RULE_OF_LAW,
  SUPREME_LAW,
  YOUR_GOVERNOR,
  civicsHandlers,
} from '../../utils/civics-fixtures';
import type { CivicsQuestionSummary } from '../../../types';

const API_BASE = '*/api';
const PHONE = 360;

/**
 * Every string that would betray a correctness judgement, checked against the
 * whole rendered screen.
 *
 * Deliberately broad, and the fixtures are deliberately written to contain none
 * of them, so a match means the PRODUCT introduced one rather than the content
 * happening to use the word.
 */
const JUDGEMENT = [
  /\bscore/i,
  /\bcorrect/i,
  /\bincorrect/i,
  /\bwrong\b/i,
  /\bgrade/i,
  /\bstreak\b/i,
  /\bhow did you do\b/i,
  /\bdid you get\b/i,
  /\bi knew (it|this)\b/i,
  /\brate this\b/i,
];

const DECK: CivicsQuestionSummary[] = [SUPREME_LAW, ONE_BRANCH, RULE_OF_LAW];

function renderStudy(
  deck: CivicsQuestionSummary[] = DECK,
  { mode = 'light' as 'light' | 'dark', stateName = 'California' } = {},
) {
  return render(
    <ThemeProvider theme={createTheme({ palette: { mode } })}>
      <CssBaseline />
      <MemoryRouter>
        <FlashcardStudy
          questions={deck}
          deckLabel="Principles of American Democracy"
          stateName={stateName}
        />
      </MemoryRouter>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  server.use(...civicsHandlers());
});

describe('the card itself', () => {
  it('shows the prompt first and no answer until the learner asks', async () => {
    renderStudy();

    expect(
      screen.getByRole('heading', { level: 3, name: SUPREME_LAW.prompt }),
    ).toBeInTheDocument();
    expect(screen.getByText(/card 1 of 3/i)).toBeInTheDocument();

    // The answer for this card is in the mocked API and is NOT on screen.
    expect(screen.queryByText('the Constitution')).not.toBeInTheDocument();
    expect(screen.queryByText(/current as of/i)).not.toBeInTheDocument();
  });

  it('reveals the answer into a live region that was already mounted', async () => {
    const user = userEvent.setup();
    renderStudy();

    // BEFORE the click: the region exists and is empty. This ordering is what
    // makes the announcement happen at all.
    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toBeEmptyDOMElement();

    const reveal = screen.getByRole('button', { name: /show answer/i });
    // A real <button>, not a click handler on a Paper.
    expect(reveal.tagName).toBe('BUTTON');

    await user.click(reveal);

    await waitFor(() =>
      expect(within(region).getByText('the Constitution')).toBeInTheDocument(),
    );
    expect(within(region).getByText(/current as of/i)).toBeInTheDocument();
  });

  it('moves to the next card and hides the answer again', async () => {
    const user = userEvent.setup();
    renderStudy();

    await user.click(screen.getByRole('button', { name: /show answer/i }));
    await screen.findByText('the Constitution');

    await user.click(screen.getByRole('button', { name: /next question/i }));

    expect(
      await screen.findByRole('heading', { level: 3, name: ONE_BRANCH.prompt }),
    ).toBeInTheDocument();
    expect(screen.getByText(/card 2 of 3/i)).toBeInTheDocument();
    // The previous card's answer is gone, and the new one is not pre-revealed.
    expect(screen.queryByText('the Constitution')).not.toBeInTheDocument();
    expect(screen.queryByText('Congress')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /show answer/i })).toBeInTheDocument();
  });

  it('goes back a card, and cannot go back from the first', async () => {
    const user = userEvent.setup();
    renderStudy();

    expect(screen.getByRole('button', { name: /previous card/i })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: /show answer/i }));
    await user.click(screen.getByRole('button', { name: /next question/i }));
    await screen.findByRole('heading', { level: 3, name: ONE_BRANCH.prompt });

    await user.click(screen.getByRole('button', { name: /previous card/i }));
    expect(
      await screen.findByRole('heading', { level: 3, name: SUPREME_LAW.prompt }),
    ).toBeInTheDocument();
  });

  it('shows every accepted answer, labelled as alternatives', async () => {
    const user = userEvent.setup();
    renderStudy([ONE_BRANCH]);

    await user.click(screen.getByRole('button', { name: /show answer/i }));

    expect(await screen.findByText('Congress')).toBeInTheDocument();
    expect(screen.getByText('the President')).toBeInTheDocument();
    expect(screen.getByText('the courts')).toBeInTheDocument();
    expect(screen.getByText(/any one of these is accepted/i)).toBeInTheDocument();
  });
});

// -----------------------------------------------------------------------------
// The hard boundary
// -----------------------------------------------------------------------------

describe('recognition only — no scoring of any kind', () => {
  it('offers no correctness control before or after the reveal', async () => {
    const user = userEvent.setup();
    const { container } = renderStudy();

    const assertNoJudgement = (stage: string) => {
      const text = container.textContent ?? '';
      for (const pattern of JUDGEMENT) {
        expect(text, `${stage}: the screen says ${pattern}`).not.toMatch(pattern);
      }

      // Controls, not only copy: a rating widget can be entirely iconographic.
      for (const control of [
        ...screen.queryAllByRole('button'),
        ...screen.queryAllByRole('checkbox'),
        ...screen.queryAllByRole('radio'),
        ...screen.queryAllByRole('slider'),
      ]) {
        const name = control.getAttribute('aria-label') ?? control.textContent ?? '';
        for (const pattern of JUDGEMENT) {
          expect(name, `${stage}: a control named "${name}"`).not.toMatch(pattern);
        }
      }
    };

    assertNoJudgement('before the reveal');

    await user.click(screen.getByRole('button', { name: /show answer/i }));
    await screen.findByText('the Constitution');

    assertNoJudgement('after the reveal');
  });

  it('has exactly two controls on the card: back one, and forward one', async () => {
    // A count, so a third button appearing is a failure rather than something
    // the positive assertions above quietly tolerate.
    renderStudy();

    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toHaveAttribute('aria-label', 'Previous card');
    expect(buttons[1]).toHaveTextContent(/show answer/i);
  });

  it('says plainly that nothing is being measured', async () => {
    renderStudy();

    expect(
      screen.getByText(/nothing here is marked or counted against you/i),
    ).toBeInTheDocument();
  });
});

// -----------------------------------------------------------------------------
// The unresolved-state case, on the back of a card
// -----------------------------------------------------------------------------

describe('a state-scope card with no state set', () => {
  it("shows the honest message and no answer, exactly as the detail view does", async () => {
    server.use(
      http.get(`${API_BASE}/civics/questions/:id`, () =>
        HttpResponse.json({ data: GOVERNOR_STATE_REQUIRED }),
      ),
    );

    const user = userEvent.setup();
    renderStudy([YOUR_GOVERNOR], { stateName: null as unknown as string });

    await user.click(screen.getByRole('button', { name: /show answer/i }));

    expect(
      await screen.findByText(/set your state to see this answer/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /set your state/i }),
    ).toHaveAttribute('href', '/settings/journey');

    // The fixture carries an answer the card must refuse to show.
    expect(screen.queryByText('Jane Q. Doe')).not.toBeInTheDocument();
    expect(screen.queryByText(/current as of/i)).not.toBeInTheDocument();
  });
});

// -----------------------------------------------------------------------------
// Phone and theme
// -----------------------------------------------------------------------------

describe('at 360px and in both themes', () => {
  it('keeps the reveal control present, and after the prompt, at 360px', async () => {
    setViewportWidth(PHONE);
    const user = userEvent.setup();
    const { container } = renderStudy();

    const prompt = screen.getByRole('heading', {
      level: 3,
      name: SUPREME_LAW.prompt,
    });
    const reveal = screen.getByRole('button', { name: /show answer/i });

    // DOM order is the reading order and, on a phone, the visual order too:
    // the control the learner reaches for is BELOW the card, in the thumb zone,
    // never above it.
    expect(
      prompt.compareDocumentPosition(reveal) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    await user.click(reveal);
    expect(await screen.findByText('the Constitution')).toBeInTheDocument();
    expect(container.textContent).toContain('Card 1 of 3');
  });

  it('works the same in the dark theme', async () => {
    const user = userEvent.setup();
    renderStudy(DECK, { mode: 'dark' });

    await user.click(screen.getByRole('button', { name: /show answer/i }));
    expect(await screen.findByText('the Constitution')).toBeInTheDocument();
  });
});

describe('an empty deck', () => {
  it('says so rather than rendering a card with nothing on it', () => {
    renderStudy([]);

    expect(
      screen.getByText(/no questions to study in this part of the test yet/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /show answer/i }),
    ).not.toBeInTheDocument();
  });
});
