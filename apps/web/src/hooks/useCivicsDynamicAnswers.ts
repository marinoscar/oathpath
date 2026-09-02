/**
 * List the dynamic civics answers, and correct one.
 *
 * Issue #126, epic #51. Shaped after `useEmailSettings` — same `isMounted`
 * discipline, same "an error is a string the page renders, never a rejected
 * promise a click handler has to catch" contract — with two departures that are
 * specific to this endpoint:
 *
 *   1. A CORRECTION IS NOT A SAVE OF THE THING ON SCREEN. `PUT` addresses one
 *      SLOT (`questionId` + `stateCode`) out of a list of many, so there is no
 *      form-level baseline to diff and no `isDirty`. What comes back is a pair
 *      of rows — the one that was closed and the one that was opened — and
 *      `lastCorrection` keeps it so the page can say which is which.
 *
 *   2. THE RESPONSE IS MERGED, NOT REFETCHED. The server hands back the newly
 *      opened row in full, so the list is updated in place: an admin correcting
 *      Ohio's governor sees Ohio's row change and keeps their scroll position,
 *      their filter and every accordion they had opened. A refetch would cost a
 *      round trip to be told what we were just told, and would collapse the
 *      page under the admin mid-task.
 *
 * Note what merging does to `missingStateCodes`: filling a gap removes that
 * code from the list, because the gap is now filled. Leaving it there would
 * leave the page reporting a state as unanswerable directly above the answer
 * that was just recorded for it.
 */

import { useCallback, useEffect, useState } from 'react';

import { ApiError, correctCivicsDynamicAnswer, getCivicsDynamicAnswers } from '../services/api';
import type {
  CivicsAdminScope,
  CivicsAnswerCorrection,
  CivicsAnswerCorrectionResult,
  CivicsDynamicAnswerItem,
} from '../types';
import { useIsMounted } from './useIsMounted';

/** The scope filter, including the "do not filter" value the API expresses by omission. */
export type CivicsScopeFilter = CivicsAdminScope | 'all';

/**
 * Questions per page.
 *
 * The API's own default is 20 and its ceiling is 100. Deliberately smaller than
 * the ceiling: one `state` question carries up to 56 answer rows, so a page of
 * 100 is thousands of rows of table for an admin who came to change one name.
 */
export const CIVICS_PAGE_SIZE = 20;

interface UseCivicsDynamicAnswersReturn {
  items: CivicsDynamicAnswerItem[];
  /** Counts QUESTIONS, not answer rows. */
  total: number;
  page: number;
  totalPages: number;
  scope: CivicsScopeFilter;
  setScope: (scope: CivicsScopeFilter) => void;
  setPage: (page: number) => void;
  isLoading: boolean;
  /** Failure to LOAD. Distinct from `saveError`: "nothing to look at" versus "your correction did not stick". */
  loadError: string | null;
  isSaving: boolean;
  saveError: string | null;
  clearSaveError: () => void;
  /** The last accepted correction — the closed row and the opened one — until the page clears it. */
  lastCorrection: CivicsAnswerCorrectionResult | null;
  clearLastCorrection: () => void;
  /** Resolves the result when the correction landed, `null` when it did not — never throws. */
  correct: (input: CivicsAnswerCorrection) => Promise<CivicsAnswerCorrectionResult | null>;
  refresh: () => Promise<void>;
}

/** Replace (or insert) the corrected slot's open row, and close the gap it filled. */
function applyCorrection(
  items: CivicsDynamicAnswerItem[],
  result: CivicsAnswerCorrectionResult,
): CivicsDynamicAnswerItem[] {
  return items.map((item) => {
    if (item.questionId !== result.questionId) return item;

    const withoutSlot = item.answers.filter(
      (answer) => answer.stateCode !== result.current.stateCode,
    );

    return {
      ...item,
      answers: [...withoutSlot, result.current].sort((a, b) =>
        (a.stateCode ?? '').localeCompare(b.stateCode ?? ''),
      ),
      missingStateCodes: item.missingStateCodes.filter(
        (code) => code !== result.current.stateCode,
      ),
    };
  });
}

export function useCivicsDynamicAnswers(): UseCivicsDynamicAnswersReturn {
  const [items, setItems] = useState<CivicsDynamicAnswerItem[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [page, setPage] = useState(1);
  const [scope, setScopeState] = useState<CivicsScopeFilter>('all');
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [lastCorrection, setLastCorrection] = useState<CivicsAnswerCorrectionResult | null>(null);

  // Every `setState` past an `await` is guarded, as in `useEmailSettings`: a
  // request that settles after the page is gone must not schedule an update on
  // it. Only the state write is skipped; what these functions return is
  // unchanged.
  const isMounted = useIsMounted();

  const fetchPage = useCallback(async () => {
    try {
      setIsLoading(true);
      setLoadError(null);
      const data = await getCivicsDynamicAnswers({
        page,
        pageSize: CIVICS_PAGE_SIZE,
        // OMITTED for 'all'. The query is a strict object server-side and has
        // no `all` value to send — "every scope" is expressed by the parameter
        // not being there.
        ...(scope === 'all' ? {} : { dynamicScope: scope }),
      });
      if (isMounted()) {
        setItems(data.items);
        setTotal(data.total);
        setTotalPages(data.totalPages);
      }
    } catch (err) {
      if (isMounted()) {
        // 403 is named explicitly because it is the one failure the admin can
        // act on themselves; everything else surfaces the API's own message.
        setLoadError(
          err instanceof ApiError && err.status === 403
            ? 'You do not have permission to view the civics answers'
            : err instanceof ApiError
              ? err.message
              : 'Failed to load the civics answers',
        );
      }
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [page, scope, isMounted]);

  useEffect(() => {
    fetchPage();
  }, [fetchPage]);

  /** Changing the filter returns to page 1: page 3 of the old result set is not page 3 of the new one. */
  const setScope = useCallback((next: CivicsScopeFilter) => {
    setScopeState(next);
    setPage(1);
  }, []);

  const correct = useCallback(
    async (input: CivicsAnswerCorrection): Promise<CivicsAnswerCorrectionResult | null> => {
      try {
        setIsSaving(true);
        setSaveError(null);
        const result = await correctCivicsDynamicAnswer(input);
        if (isMounted()) {
          setItems((current) => applyCorrection(current, result));
          setLastCorrection(result);
        }
        return result;
      } catch (err) {
        if (isMounted()) {
          // VERBATIM. The API's 400s here are explanatory sentences — why a
          // static answer is not administered at runtime, why a state is
          // required — and flattening them to "could not save" throws away the
          // only thing that tells the admin what to do instead.
          setSaveError(
            err instanceof ApiError ? err.message : 'The correction could not be recorded',
          );
        }
        return null;
      } finally {
        if (isMounted()) setIsSaving(false);
      }
    },
    [isMounted],
  );

  return {
    items,
    total,
    page,
    totalPages,
    scope,
    setScope,
    setPage,
    isLoading,
    loadError,
    isSaving,
    saveError,
    clearSaveError: useCallback(() => setSaveError(null), []),
    lastCorrection,
    clearLastCorrection: useCallback(() => setLastCorrection(null), []),
    correct,
    refresh: fetchPage,
  };
}
