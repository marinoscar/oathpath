import { useState, useEffect, useCallback } from 'react';
import { api, ApiError } from '../services/api';
import { UserSettings, UserSettingsUpdate } from '../types';
import { useOptionalThemeContext } from '../contexts/ThemeContext';
import { useIsMounted } from './useIsMounted';

interface UseUserSettingsOptions {
  /**
   * Whether loading/saving settings should push the theme into ThemeContext.
   * Defaults to `true`, which is what the settings page wants.
   *
   * Pass `false` when mounting this hook from always-present chrome (AppBar,
   * navigation rail, layout shells). There, syncing would make the STORED
   * theme authoritative on every page load: the moment the user flips the
   * AppBar's light/dark toggle, any refetch — or simply navigating to a route
   * that remounts the chrome — calls setMode() with the persisted value and
   * stamps the toggle right back. Do not "simplify" this option away.
   *
   * `false` ALSO DROPS THE `ThemeContextProvider` REQUIREMENT (#288). A caller
   * that has opted out of theme syncing never calls `setMode`, so demanding a
   * provider it will not use would keep `voice` preferences from being read on
   * the practice and writing screens — surfaces whose reason to exist has
   * nothing to do with theme chrome. `syncTheme: true` still throws without
   * one, unchanged: there, a silently inert `setMode` would be a theme control
   * that does nothing.
   */
  syncTheme?: boolean;
}

/**
 * `setMode` for a `syncTheme: false` caller with no provider above it.
 *
 * MODULE-LEVEL so its identity is stable — it lands in the dependency array of
 * `fetchSettings`/`updateSettings`, and a fresh function per render would
 * re-create both callbacks (and so re-fire the fetch effect) on every render.
 */
const NO_THEME_SYNC = () => undefined;

interface UseUserSettingsReturn {
  settings: UserSettings | null;
  isLoading: boolean;
  error: string | null;
  isSaving: boolean;
  updateSettings: (updates: UserSettingsUpdate) => Promise<void>;
  updateTheme: (theme: 'light' | 'dark' | 'system') => Promise<void>;
  updateProfile: (profile: UserSettings['profile']) => Promise<void>;
  refresh: () => Promise<void>;
}

export function useUserSettings(options: UseUserSettingsOptions = {}): UseUserSettingsReturn {
  const { syncTheme = true } = options;
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const themeContext = useOptionalThemeContext();
  // The throw is preserved for the callers that genuinely need the theme, and
  // is a plain render-time check rather than a conditional hook call.
  if (syncTheme && !themeContext) {
    throw new Error('useThemeContext must be used within a ThemeContextProvider');
  }
  const setMode = themeContext?.setMode ?? NO_THEME_SYNC;
  // Every `setState` past an `await` is guarded: a request that settles after
  // the component is gone must not schedule an update on it. `setMode` is
  // included — it writes ThemeContext state and is just as unsafe once the
  // tree is gone. Only the state write is skipped; what these functions
  // return or throw is unchanged.
  const isMounted = useIsMounted();

  const fetchSettings = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const data = await api.get<UserSettings>('/user-settings');
      if (isMounted()) {
        setSettings(data);
        // Sync theme with settings (opt-out via syncTheme: false)
        if (syncTheme) {
          setMode(data.theme);
        }
      }
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Failed to load settings';
      if (isMounted()) setError(message);
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [setMode, syncTheme, isMounted]);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  const updateSettings = useCallback(
    async (updates: UserSettingsUpdate) => {
      if (!settings) return;

      try {
        setIsSaving(true);
        setError(null);

        const data = await api.patch<UserSettings>('/user-settings', updates, {
          headers: {
            'If-Match': settings.version.toString(),
          },
        });

        if (isMounted()) {
          setSettings(data);

          // Sync theme if changed (opt-out via syncTheme: false)
          if (syncTheme && updates.theme) {
            setMode(updates.theme);
          }
        }
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          // Version conflict - refresh and retry
          await fetchSettings();
          throw new Error('Settings were updated elsewhere. Please try again.');
        }
        const message = err instanceof ApiError ? err.message : 'Failed to save settings';
        if (isMounted()) setError(message);
        throw err;
      } finally {
        if (isMounted()) setIsSaving(false);
      }
    },
    [settings, setMode, syncTheme, fetchSettings, isMounted],
  );

  const updateTheme = useCallback(
    async (theme: 'light' | 'dark' | 'system') => {
      await updateSettings({ theme });
    },
    [updateSettings],
  );

  const updateProfile = useCallback(
    async (profile: UserSettings['profile']) => {
      await updateSettings({ profile });
    },
    [updateSettings],
  );

  return {
    settings,
    isLoading,
    error,
    isSaving,
    updateSettings,
    updateTheme,
    updateProfile,
    refresh: fetchSettings,
  };
}
