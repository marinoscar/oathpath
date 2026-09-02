/**
 * One question, with its answers resolved for the caller — the leaf of `/learn`
 * and the back of every flashcard.
 *
 * Issue #121, epic #51.
 *
 * THIS HOOK DOES NOT INTERPRET `answerResolution`, and must not start to. The
 * discriminator travels to the component that renders it (`AnswerPanel`)
 * untouched, because `state_required` is a first-class UI STATE rather than an
 * error: collapsing it into `error` here — or into an empty `answers` array —
 * is exactly the "we don't know yet" / "this has no answers" confusion the API
 * introduced a discriminator to prevent.
 *
 * `null` for `id` means "no question is open", which is the ordinary state of
 * three of `/learn`'s four views. Nothing is fetched for it.
 */

import { useCallback, useEffect, useState } from 'react';

import { getCivicsQuestion } from '../services/api';
import type { CivicsQuestionDetail } from '../types';
import { useIsMounted } from './useIsMounted';

interface UseCivicsQuestionReturn {
  question: CivicsQuestionDetail | null;
  isLoading: boolean;
  error: string | null;
}

export function useCivicsQuestion(id: string | null): UseCivicsQuestionReturn {
  const [question, setQuestion] = useState<CivicsQuestionDetail | null>(null);
  const [isLoading, setIsLoading] = useState(id !== null);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const load = useCallback(async () => {
    if (!id) {
      if (isMounted()) {
        setQuestion(null);
        setIsLoading(false);
        setError(null);
      }
      return;
    }

    setIsLoading(true);
    setError(null);
    // Dropped rather than kept: showing the PREVIOUS card's answer under the
    // next card's prompt for the length of a request is worse than showing
    // nothing, and on a flashcard it is worse than an error.
    setQuestion(null);
    try {
      const data = await getCivicsQuestion(id);
      if (isMounted()) setQuestion(data);
    } catch (err) {
      if (isMounted()) {
        setError(
          err instanceof Error
            ? err.message
            : 'This question could not be loaded.',
        );
      }
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [id, isMounted]);

  useEffect(() => {
    load();
  }, [load]);

  return { question, isLoading, error };
}
