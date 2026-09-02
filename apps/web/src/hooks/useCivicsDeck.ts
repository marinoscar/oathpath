/**
 * The whole deck flashcard mode studies — every question in the chosen part of
 * the test, not one page of them.
 *
 * Issue #121, epic #51.
 *
 * =============================================================================
 * WHY THIS IS NOT JUST `useCivicsQuestions` WITH A BIG `pageSize`
 * =============================================================================
 *
 * The API caps `pageSize` at 100, and the 2025 bank has 128 questions. A study
 * session built on one maximal page would therefore study 100 of 128 and say
 * nothing about the other 28 — a silent truncation of the very content the
 * learner is trying to cover, invisible on screen and indistinguishable from a
 * deck that really is 100 long.
 *
 * So this hook follows `totalPages` and concatenates. For the largest case that
 * is two requests, made once when the learner opens study mode; the alternative
 * — a "load more" control inside a flashcard deck — would be a paging concept
 * in the one place the learner is meant to stop thinking about the interface.
 *
 * The page walk is bounded (`MAX_PAGES`) so a server that reported a nonsense
 * `totalPages` cannot turn one screen into an unbounded request loop.
 */

import { useCallback, useEffect, useState } from 'react';

import { getCivicsQuestions } from '../services/api';
import type { CivicsQuestionSummary } from '../types';
import { useIsMounted } from './useIsMounted';

/** The API's own maximum, so the walk is as short as the server allows. */
const PAGE_SIZE = 100;

/** 1 000 questions is already four times the largest version. A guard, not a limit. */
const MAX_PAGES = 10;

interface UseCivicsDeckReturn {
  deck: CivicsQuestionSummary[];
  isLoading: boolean;
  error: string | null;
}

export function useCivicsDeck(
  categoryId: string | undefined,
  enabled: boolean,
): UseCivicsDeckReturn {
  const [deck, setDeck] = useState<CivicsQuestionSummary[]>([]);
  const [isLoading, setIsLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const load = useCallback(async () => {
    if (!enabled) {
      if (isMounted()) {
        setDeck([]);
        setIsLoading(false);
        setError(null);
      }
      return;
    }

    setIsLoading(true);
    setError(null);
    try {
      const collected: CivicsQuestionSummary[] = [];
      let page = 1;
      let totalPages = 1;

      do {
        const response = await getCivicsQuestions({
          categoryId,
          page,
          pageSize: PAGE_SIZE,
        });
        collected.push(...response.items);
        totalPages = response.totalPages;
        page += 1;
      } while (page <= totalPages && page <= MAX_PAGES);

      if (isMounted()) setDeck(collected);
    } catch (err) {
      if (isMounted()) {
        setDeck([]);
        setError(
          err instanceof Error
            ? err.message
            : 'The questions could not be loaded.',
        );
      }
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [categoryId, enabled, isMounted]);

  useEffect(() => {
    load();
  }, [load]);

  return { deck, isLoading, error };
}
