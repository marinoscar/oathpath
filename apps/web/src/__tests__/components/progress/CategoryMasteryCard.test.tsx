/**
 * `CategoryMasteryCard` — one category's coverage and mastery, with its
 * "needs review" retry.
 *
 * Issue #94, epic #54 / E5 "Memory".
 *
 * NOTE ON SCOPE: this card does not itself call `createPracticeSession` or
 * navigate — it renders `category.byState.lapsed`-driven content and forwards
 * a click to the `onRetry` prop `ProgressPage.tsx` supplies. `onRetry` is
 * where the real `createPracticeSession({ kind: 'category', … })` call and the
 * post-success navigation live (see `ProgressPage.test.tsx`'s "starting a
 * retry from a category" describe block for that request-shape and navigation
 * coverage). What belongs here, and what is tested here, is the card's own
 * contract: exactly when the button appears, and that clicking it calls
 * `onRetry` with the category object the retry needs to identify — nothing
 * more, nothing less.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CategoryMasteryCard } from '../../../components/progress/CategoryMasteryCard';
import type { ProgressMasteryCategory } from '../../../types';

function makeCategory(
  overrides: Partial<ProgressMasteryCategory> = {},
): ProgressMasteryCategory {
  return {
    categoryId: 'category-democracy',
    categoryName: 'Principles of American Democracy',
    totalQuestions: 10,
    byState: { new: 4, learning: 2, review: 2, lapsed: 0, mastered: 2 },
    masteredCount: 2,
    ...overrides,
  };
}

function renderCard(
  props: Partial<Parameters<typeof CategoryMasteryCard>[0]> = {},
) {
  const onRetry = vi.fn();
  const category = props.category ?? makeCategory();
  render(
    <CategoryMasteryCard
      category={category}
      isStarting={false}
      disabled={false}
      onRetry={onRetry}
      headingId="progress-category-test-heading"
      {...props}
    />,
  );
  return { onRetry, category };
}

describe('CategoryMasteryCard — coverage and mastery from fixture data', () => {
  it("renders the category's name, mastered/total count and heading id", () => {
    renderCard({
      category: makeCategory({
        categoryName: 'System of Government',
        totalQuestions: 12,
        masteredCount: 5,
      }),
    });

    const heading = screen.getByRole('heading', {
      level: 3,
      name: 'System of Government',
    });
    expect(heading).toHaveAttribute('id', 'progress-category-test-heading');
    expect(screen.getByText('5 of 12 mastered')).toBeInTheDocument();
  });

  it("passes the category's own breakdown and total into the shared bar", () => {
    const byState = { new: 1, learning: 1, review: 1, lapsed: 1, mastered: 6 };
    renderCard({ category: makeCategory({ byState, totalQuestions: 10 }) });

    // `MasteryBreakdownBar` renders `role="img"` with an aria-label this card
    // builds from the same numbers shown in the "mastered of total" line —
    // one number, not two disagreeing ones.
    expect(
      screen.getByRole('img', {
        name: /2 of 10 mastered/,
      }),
    ).toBeInTheDocument();
  });
});

describe('CategoryMasteryCard — the retry button appears only when lapsed > 0', () => {
  it('shows no retry button and no "needs review" copy when nothing is lapsed', () => {
    renderCard({ category: makeCategory({ byState: { new: 5, learning: 3, review: 2, lapsed: 0, mastered: 0 } }) });

    expect(
      screen.queryByRole('button', { name: /practice this section/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/needs? review/i)).not.toBeInTheDocument();
  });

  it('shows the retry button and a singular count for exactly one lapsed question', () => {
    renderCard({
      category: makeCategory({
        byState: { new: 5, learning: 2, review: 1, lapsed: 1, mastered: 1 },
      }),
    });

    expect(screen.getByText('1 question needs review')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /practice this section/i }),
    ).toBeInTheDocument();
  });

  it('shows a plural count for more than one lapsed question', () => {
    renderCard({
      category: makeCategory({
        byState: { new: 3, learning: 2, review: 1, lapsed: 3, mastered: 1 },
      }),
    });

    expect(screen.getByText('3 questions need review')).toBeInTheDocument();
  });
});

describe('CategoryMasteryCard — clicking retry', () => {
  it('calls onRetry with the exact category object clicked, not a re-derived id', async () => {
    const user = userEvent.setup();
    const category = makeCategory({
      categoryId: 'category-1800s',
      categoryName: 'Recent American History',
      byState: { new: 2, learning: 1, review: 1, lapsed: 2, mastered: 0 },
    });
    const { onRetry } = renderCard({ category });

    await user.click(screen.getByRole('button', { name: /practice this section/i }));

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(category);
  });

  it('shows a starting label and does not fire a second call while its own retry is in flight', async () => {
    const user = userEvent.setup();
    renderCard({
      category: makeCategory({ byState: { new: 2, learning: 1, review: 1, lapsed: 1, mastered: 0 } }),
      isStarting: true,
      disabled: true,
    });

    const button = screen.getByRole('button', { name: /starting…/i });
    expect(button).toBeDisabled();

    // A click on a genuinely disabled MUI button is refused by the DOM's own
    // `pointer-events: none`, not merely ignored by the handler — the same
    // real mechanism `PracticePage.test.tsx` asserts for its own disabled
    // starters.
    await expect(user.click(button)).rejects.toThrow(/pointer-events/i);
  });

  it('disables its own button while a DIFFERENT category is retrying', () => {
    renderCard({
      category: makeCategory({ byState: { new: 2, learning: 1, review: 1, lapsed: 1, mastered: 0 } }),
      isStarting: false,
      disabled: true,
    });

    const button = screen.getByRole('button', { name: /practice this section/i });
    expect(button).toBeDisabled();
  });
});
