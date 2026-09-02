/**
 * A page of civics questions — the middle level of `/learn`, and the deck
 * flashcard mode studies.
 *
 * Issue #121, epic #51.
 *
 * NO `testVersionCode` IS PASSED THROUGH, EVER. The API defaults it to the
 * caller's own resolved version (`services/api.ts` explains why the browser
 * must not "helpfully" send the code it happens to hold). This hook therefore
 * has no parameter for it, so there is nothing for a caller to get wrong.
 *
 * `enabled` exists because `/learn` renders four views off one route and only
 * two of them want a question page. A hook that fetched regardless would spend
 * a request every time a learner opened the category list.
 */

import { useCallback, useEffect, useState } from 'react';

import { getCivicsQuestions } from '../services/api';
import type { CivicsQuestionSummary } from '../types';
import { useIsMounted } from './useIsMounted';

export interface UseCivicsQuestionsParams {
  /** Restrict to one category, by the `id` from the categories route. */
  categoryId?: string;
  page: number;
  pageSize: number;
  /** When false, nothing is fetched and the previous page is dropped. */
  enabled?: boolean;
}

interface UseCivicsQuestionsReturn {
  questions: CivicsQuestionSummary[];
  total: number;
  totalPages: number;
  /** The page the SERVER answered with, which is what pagination must render. */
  page: number;
  isLoading: boolean;
  error: string | null;
}

export function useCivicsQuestions({
  categoryId,
  page,
  pageSize,
  enabled = true,
}: UseCivicsQuestionsParams): UseCivicsQuestionsReturn {
  const [questions, setQuestions] = useState<CivicsQuestionSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [serverPage, setServerPage] = useState(page);
  const [isLoading, setIsLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const load = useCallback(async () => {
    if (!enabled) {
      if (isMounted()) {
        setQuestions([]);
        setIsLoading(false);
        setError(null);
      }
      return;
    }

    setIsLoading(true);
    setError(null);
    try {
      const data = await getCivicsQuestions({ categoryId, page, pageSize });
      if (!isMounted()) return;
      setQuestions(data.items);
      setTotal(data.total);
      setTotalPages(data.totalPages);
      setServerPage(data.page);
    } catch (err) {
      if (isMounted()) {
        setQuestions([]);
        setTotal(0);
        setTotalPages(0);
        setError(
          err instanceof Error
            ? err.message
            : 'The questions could not be loaded.',
        );
      }
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [categoryId, enabled, isMounted, page, pageSize]);

  useEffect(() => {
    load();
  }, [load]);

  return {
    questions,
    total,
    totalPages,
    page: serverPage,
    isLoading,
    error,
  };
}
