/**
 * Load, save and test the deployment's AI configuration.
 *
 * Issue #33, epic #25. Shaped after `useEmailSettings` — same `isMounted`
 * discipline, same "error is a string the page renders" contract, same
 * boolean-returning `save` — with one departure this endpoint needs:
 *
 *   THE MODEL CATALOG IS A SECOND, INDEPENDENTLY-REFETCHED RESOURCE. It comes
 *   from a different endpoint, it can fail while the settings load perfectly
 *   (no server key stored yet, a provider outage), and it changes when the
 *   "show all models" toggle moves — which must not reload the form and
 *   discard the admin's unsaved edits. So it has its own loading flag, its own
 *   error, and its own fetch.
 *
 * THE ROLE LIST COMES FROM THE CATALOG, NOT FROM A CONSTANT HERE. The web app
 * deliberately keeps no copy — the same reasoning `getNotificationEvents`
 * documents — and `wired` in particular is a per-DEPLOYMENT fact, because the
 * API accounts for what the configured provider can actually serve. A static
 * copy would be wrong on any deployment whose provider differs.
 */

import { useCallback, useEffect, useState } from 'react';

import {
  ApiError,
  getAiModelCatalog,
  getAiSettings,
  testAiConnection,
  updateAiSettings,
} from '../services/api';
import type {
  AiModelCatalog,
  AiSettings,
  AiSettingsInput,
  AiTestResult,
} from '../types';
import { useIsMounted } from './useIsMounted';

interface UseAiSettingsReturn {
  settings: AiSettings | null;
  isLoading: boolean;
  /** Failure to LOAD. Distinct from `saveError`: "nothing to edit" vs "your edit did not stick". */
  loadError: string | null;

  /** The bindable models and the role registry. Null until first loaded. */
  catalog: AiModelCatalog | null;
  isCatalogLoading: boolean;
  /**
   * Failure to load the CATALOG.
   *
   * Separate from `loadError` because the page stays usable without it: the
   * settings still render, the master switch still saves, and the catalog's own
   * `notConfigured` / `error` fields explain the empty selects.
   */
  catalogError: string | null;
  /** Whether the escape hatch is engaged. */
  showAllModels: boolean;
  setShowAllModels: (showAll: boolean) => void;

  isSaving: boolean;
  saveError: string | null;
  isTesting: boolean;
  /** The last test attempt, success or failure, until the page clears it. */
  testResult: AiTestResult | null;

  /** Resolves `true` when the save landed, `false` when it did not — never throws. */
  save: (input: AiSettingsInput) => Promise<boolean>;
  test: () => Promise<void>;
  clearTestResult: () => void;
  clearSaveError: () => void;
  refresh: () => Promise<void>;
}

export function useAiSettings(): UseAiSettingsReturn {
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [catalog, setCatalog] = useState<AiModelCatalog | null>(null);
  const [isCatalogLoading, setIsCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [showAllModels, setShowAllModels] = useState(false);

  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<AiTestResult | null>(null);

  // Every `setState` past an `await` is guarded: a request that settles after
  // the component is gone must not schedule an update on it.
  const isMounted = useIsMounted();

  const fetchSettings = useCallback(async () => {
    try {
      setIsLoading(true);
      setLoadError(null);
      const data = await getAiSettings();
      if (isMounted()) setSettings(data);
    } catch (err) {
      if (isMounted()) {
        // 403 is named explicitly because it is the one failure the reader can
        // act on themselves; everything else surfaces the API's own message.
        if (err instanceof ApiError && err.status === 403) {
          setLoadError('You do not have permission to view AI settings');
        } else {
          setLoadError(
            err instanceof ApiError ? err.message : 'Failed to load AI settings',
          );
        }
      }
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted]);

  const fetchCatalog = useCallback(
    async (showAll: boolean) => {
      try {
        setIsCatalogLoading(true);
        setCatalogError(null);
        const data = await getAiModelCatalog({ showAll });
        if (isMounted()) setCatalog(data);
      } catch (err) {
        if (isMounted()) {
          // NOTE: this is the call FAILING, not the provider refusing. A
          // provider refusal arrives as a 200 with `catalog.error` set, and
          // the page renders that from the catalog itself — the same
          // distinction the test result draws.
          setCatalogError(
            err instanceof ApiError
              ? err.message
              : 'Failed to load the model list',
          );
        }
      } finally {
        if (isMounted()) setIsCatalogLoading(false);
      }
    },
    [isMounted],
  );

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  // Refetched when the escape hatch moves, and ONLY the catalog — the form
  // keeps whatever the admin has typed. Reloading the settings here would
  // discard unsaved edits every time someone toggled a checkbox to look for a
  // model.
  useEffect(() => {
    fetchCatalog(showAllModels);
  }, [fetchCatalog, showAllModels]);

  /**
   * PUT the form, adopt whatever the server says the settings now are.
   *
   * THE RESPONSE IS THE NEW BASELINE, not the input. The server owns
   * `apiKeyStatus`, `settingsError`, `version`, `updatedAt` and `updatedBy`,
   * and the key status in particular must come back from the server: after a
   * save that stored a key for the first time, a page still holding
   * `configured: false` would keep telling the admin no key is stored while one
   * is. `version` matters for the same reason — the response carries the number
   * the NEXT save must send as `If-Match`, so two saves in a row work without a
   * reload in between.
   *
   * THE CATALOG IS REFETCHED AFTER A SUCCESSFUL SAVE, because the key may have
   * changed. An admin who has just pasted a working key expects the selects to
   * fill in, and the API invalidates its own cache on the same write.
   */
  const save = useCallback(
    async (input: AiSettingsInput): Promise<boolean> => {
      try {
        setIsSaving(true);
        setSaveError(null);
        // `?? 0` rather than omitting: 0 is the API's way of asserting "I
        // believe nothing is stored yet", so even a first save is guarded.
        const data = await updateAiSettings(input, settings?.version ?? 0);
        if (isMounted()) setSettings(data);
        await fetchCatalog(showAllModels);
        return true;
      } catch (err) {
        // 409 IS NOT A GENERIC FAILURE. Somebody else saved between this
        // page's load and this click, so every retry would 409 identically
        // until the form is rebuilt from the current row. Reload it, and say
        // plainly that the fields on screen have been replaced — a message
        // alone, over a form still holding stale values, would invite the
        // admin to press Save again and overwrite the colleague's change for
        // real.
        //
        // The API also uses 409 for "you selected a provider with no key
        // stored". That one is not a concurrency problem, so the message is
        // taken from the response rather than replaced with the reload text —
        // distinguished by whether a reload actually changed the version.
        if (err instanceof ApiError && err.status === 409) {
          await fetchSettings();
          if (isMounted()) {
            setSaveError(
              isConcurrencyConflict(err)
                ? 'Someone else changed the AI settings while you were editing. ' +
                    'The form has been reloaded with the current configuration — review it and save again.'
                : err.message,
            );
          }
          return false;
        }
        if (isMounted()) {
          setSaveError(
            err instanceof ApiError ? err.message : 'Failed to save AI settings',
          );
        }
        return false;
      } finally {
        if (isMounted()) setIsSaving(false);
      }
    },
    [settings, fetchSettings, fetchCatalog, showAllModels, isMounted],
  );

  /**
   * Ask the API to prove the stored server key works.
   *
   * TWO KINDS OF FAILURE, ONE SURFACE. The endpoint answers 200 with
   * `{ success: false, error }` when the provider refuses — that is the
   * interesting case, and it is NOT an exception. It rejects only when the call
   * itself fails (403, 500, connection dropped). Both are failed tests, so both
   * end up in the same `testResult`; the page has one region to render and no
   * way to accidentally treat a resolved promise as a working key.
   */
  const test = useCallback(async () => {
    try {
      setIsTesting(true);
      setTestResult(null);
      const result = await testAiConnection();
      if (isMounted()) setTestResult(result);
    } catch (err) {
      if (isMounted()) {
        setTestResult({
          success: false,
          authenticated: false,
          roles: [],
          providerKind: null,
          // The API's message verbatim — a 403 from a read-only admin and a
          // 500 from a broken provider module read very differently, and
          // flattening both to "test failed" would throw away the only clue.
          error:
            err instanceof ApiError
              ? err.message
              : 'The test request could not be sent',
        });
      }
    } finally {
      if (isMounted()) setIsTesting(false);
    }
  }, [isMounted]);

  const clearTestResult = useCallback(() => setTestResult(null), []);
  const clearSaveError = useCallback(() => setSaveError(null), []);

  return {
    settings,
    isLoading,
    loadError,
    catalog,
    isCatalogLoading,
    catalogError,
    showAllModels,
    setShowAllModels,
    isSaving,
    saveError,
    isTesting,
    testResult,
    save,
    test,
    clearTestResult,
    clearSaveError,
    refresh: fetchSettings,
  };
}

/**
 * Is this 409 an optimistic-concurrency conflict, or the API's other 409?
 *
 * `AiSettingsService.update` returns 409 for two different things: a version
 * mismatch, and "you selected a provider while no key is stored". Only the
 * first is a stale-form problem whose remedy is "we reloaded it for you";
 * telling an admin their form was replaced when the real problem is a missing
 * key sends them looking for a colleague who did not touch anything.
 *
 * Matched on the API's own wording rather than a distinct status, which is the
 * honest trade: two 409s with one status is the API's shape, and a second
 * status would have been the better design there. Falling back to the reload
 * message on an unrecognised 409 is safe — it reloads and says so, which is
 * never wrong, only sometimes imprecise.
 */
function isConcurrencyConflict(err: ApiError): boolean {
  return /version mismatch/i.test(err.message);
}
