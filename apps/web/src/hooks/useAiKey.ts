/**
 * Load, save, remove and test the CALLER'S OWN OpenAI key.
 *
 * Issue #40, epic #25. Two surfaces consume this — the first-run onboarding
 * screen (#41) and the ongoing management page (#42) — and neither forks it.
 *
 * SHAPED AFTER `useAiSettings`, with one structural difference that follows
 * from what this is: there is no `version` and no `If-Match`. A user's key has
 * exactly one writer, so optimistic concurrency has nothing to protect against
 * — two tabs belonging to the same person saving the same field is not a lost
 * update, it is that person changing their mind twice.
 *
 * THE TEST IS NOT A SAVE, and is tracked separately, because the page must be
 * able to say "your key saved and it cannot reach the grader's model" — which
 * is a real and common outcome, and the reason `POST /api/ai/key/test` checks
 * reachability rather than validity.
 */

import { useCallback, useEffect, useState } from 'react';

import {
  ApiError,
  deleteAiKey,
  getAiKeyStatus,
  setAiKey,
  testAiKey,
} from '../services/api';
import type { AiKeyStatus, AiTestResult } from '../types';
import { useIsMounted } from './useIsMounted';

/**
 * How a failed save or test should be described to the user.
 *
 * FOUR CLASSES, NOT ONE STRING. Epic #25 names this as the requirement most at
 * risk of being skipped, and the reason is that all four arrive through the
 * same code path and it is easy to render the provider's raw text for every
 * one of them. They demand completely different actions:
 *
 *   malformed   — fix what you pasted; you have not reached OpenAI yet
 *   rejected    — the key is wrong or revoked; get a new one
 *   unreachable — your key is FINE; it lacks access to a model this app uses
 *   network     — nothing is wrong with your key; try again
 *
 * Telling someone in the third case that their key was rejected sends them to
 * replace a perfectly good credential, which is the specific harm this
 * classification exists to prevent.
 */
export type AiKeyFailureKind =
  | 'malformed'
  | 'rejected'
  | 'unreachable'
  | 'network';

interface UseAiKeyReturn {
  status: AiKeyStatus | null;
  isLoading: boolean;
  loadError: string | null;

  isSaving: boolean;
  saveError: string | null;

  isTesting: boolean;
  testResult: AiTestResult | null;

  isRemoving: boolean;

  /** Resolves `true` when the save landed. Never throws. */
  save: (apiKey: string) => Promise<boolean>;
  /** Resolves `true` when the key was removed. Never throws. */
  remove: () => Promise<boolean>;
  test: () => Promise<void>;
  clearTestResult: () => void;
  clearSaveError: () => void;
  refresh: () => Promise<void>;
}

/**
 * The shape of a plausible OpenAI key, checked BEFORE the request.
 *
 * NOT A VALIDATION OF THE KEY — only OpenAI can say whether a key works. This
 * catches the paste accidents, and catching them locally is the point: a
 * half-copied key sent to the server comes back as "rejected", which tells the
 * user their key is wrong when what actually happened is that they missed the
 * end of it.
 *
 * Deliberately loose. `sk-` prefixed and long enough to be a real credential;
 * nothing about project or organisation segments, which OpenAI has changed
 * more than once and which a stricter pattern would start rejecting silently.
 */
const PLAUSIBLE_KEY = /^sk-\S{16,}$/;

/**
 * Is `value` shaped like a key at all? See {@link PLAUSIBLE_KEY}.
 *
 * TESTED AGAINST THE TRIMMED VALUE, deliberately, even though the key is SAVED
 * verbatim. Those are two different questions:
 *
 *   "is this shaped like a key?"  — about the characters the user copied
 *   "what exactly do we store?"   — about the bytes, which are theirs
 *
 * Conflating them would make the form contradict itself: it warns about
 * surrounding whitespace and says the user may keep it if they meant it (see
 * {@link hasSurroundingWhitespace}), and then a padded-but-complete key would
 * be refused as malformed — telling someone their key is incomplete when it is
 * merely indented. A half-copied key is still caught, which is the whole
 * purpose of the check.
 */
export function looksLikeApiKey(value: string): boolean {
  return PLAUSIBLE_KEY.test(value.trim());
}

/**
 * Does `value` carry whitespace that a paste probably added?
 *
 * REPORTED, NOT STRIPPED. The API stores a key byte-for-byte and this app must
 * not silently alter a secret — but a trailing newline from a terminal copy is
 * overwhelmingly a mistake, and saying so is far better than storing it and
 * letting authentication fail with no visible cause. The user decides.
 */
export function hasSurroundingWhitespace(value: string): boolean {
  return value !== value.trim() && value.trim().length > 0;
}

export function useAiKey(): UseAiKeyReturn {
  const [status, setStatus] = useState<AiKeyStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<AiTestResult | null>(null);
  const [isRemoving, setIsRemoving] = useState(false);

  const isMounted = useIsMounted();

  const fetchStatus = useCallback(async () => {
    try {
      setIsLoading(true);
      setLoadError(null);
      const data = await getAiKeyStatus();
      if (isMounted()) setStatus(data);
    } catch (err) {
      if (isMounted()) {
        setLoadError(
          err instanceof ApiError
            ? err.message
            : 'Could not check whether you have a key saved',
        );
      }
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  /**
   * Save the key VERBATIM.
   *
   * No trim, no normalisation. The form warns about surrounding whitespace
   * (see {@link hasSurroundingWhitespace}) and lets the user decide; silently
   * altering a secret's bytes produces an authentication failure with no
   * visible cause, and this app is not the place that decision gets made.
   */
  const save = useCallback(
    async (apiKey: string): Promise<boolean> => {
      try {
        setIsSaving(true);
        setSaveError(null);
        // A previous diagnosis describes the PREVIOUS key. Leaving it on
        // screen next to a new one invites reading an old failure as current.
        setTestResult(null);
        const data = await setAiKey(apiKey);
        if (isMounted()) setStatus(data);
        return true;
      } catch (err) {
        if (isMounted()) {
          setSaveError(
            err instanceof ApiError ? err.message : 'Could not save your key',
          );
        }
        return false;
      } finally {
        if (isMounted()) setIsSaving(false);
      }
    },
    [isMounted],
  );

  /**
   * Remove the stored key.
   *
   * NOTE THE CONSEQUENCE, which the calling page must state before asking:
   * removing the key re-arms the first-run gate, so the user is returned to
   * onboarding. This is not a "clear a field" operation.
   */
  const remove = useCallback(async (): Promise<boolean> => {
    try {
      setIsRemoving(true);
      setSaveError(null);
      setTestResult(null);
      const data = await deleteAiKey();
      if (isMounted()) setStatus(data);
      return true;
    } catch (err) {
      if (isMounted()) {
        setSaveError(
          err instanceof ApiError ? err.message : 'Could not remove your key',
        );
      }
      return false;
    } finally {
      if (isMounted()) setIsRemoving(false);
    }
  }, [isMounted]);

  /**
   * Prove the stored key reaches the models this app uses.
   *
   * TWO KINDS OF FAILURE, ONE SURFACE. The endpoint answers 200 with
   * `{ success: false }` when the provider refuses — the interesting case, and
   * NOT an exception. It rejects only when the call itself fails. Both are
   * failed tests, so both land in `testResult`, and there is no way to treat a
   * resolved promise as a working key.
   */
  const test = useCallback(async () => {
    try {
      setIsTesting(true);
      setTestResult(null);
      const result = await testAiKey();
      if (isMounted()) setTestResult(result);
    } catch (err) {
      if (isMounted()) {
        setTestResult({
          success: false,
          authenticated: false,
          roles: [],
          providerKind: null,
          error:
            err instanceof ApiError
              ? err.message
              : 'The test could not be sent. Check your connection and try again.',
        });
      }
    } finally {
      if (isMounted()) setIsTesting(false);
    }
  }, [isMounted]);

  const clearTestResult = useCallback(() => setTestResult(null), []);
  const clearSaveError = useCallback(() => setSaveError(null), []);

  return {
    status,
    isLoading,
    loadError,
    isSaving,
    saveError,
    isTesting,
    testResult,
    isRemoving,
    save,
    remove,
    test,
    clearTestResult,
    clearSaveError,
    refresh: fetchStatus,
  };
}

/**
 * Which of the four failure classes a test result represents.
 *
 * A PURE FUNCTION, exported and tested directly, because this is the decision
 * the whole "name the actual problem" requirement rests on and it must not be
 * buried in JSX.
 *
 * @param result the test outcome. `null` means nothing to classify.
 */
export function classifyTestFailure(
  result: AiTestResult | null,
): AiKeyFailureKind | null {
  if (!result || result.success) return null;

  // The key authenticated, so it is NOT wrong. Something it should reach is
  // out of its reach. This is the case that must never be reported as a bad
  // key — see `AiKeyFailureKind`.
  if (result.authenticated) return 'unreachable';

  // The request never got there. `providerKind: null` with no per-role results
  // is what the hook writes when the call itself failed, and what the API
  // returns when it could not attempt anything.
  if (result.providerKind === null && /connection|network|could not be sent/i.test(result.error ?? '')) {
    return 'network';
  }

  return 'rejected';
}
