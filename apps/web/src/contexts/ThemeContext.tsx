import {
  createContext,
  useContext,
  useState,
  useMemo,
  ReactNode,
  useCallback,
} from 'react';
import { Theme, useMediaQuery } from '@mui/material';
import { lightTheme, darkTheme, ThemeMode } from '../theme';

interface ThemeContextValue {
  mode: ThemeMode;
  theme: Theme;
  setMode: (mode: ThemeMode) => void;
  toggleMode: () => void;
  isDarkMode: boolean;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const THEME_STORAGE_KEY = 'theme_mode';

interface ThemeContextProviderProps {
  children: ReactNode;
}

export function ThemeContextProvider({ children }: ThemeContextProviderProps) {
  // Check system preference
  const prefersDarkMode = useMediaQuery('(prefers-color-scheme: dark)');

  // Load saved preference or default to 'system'
  const [mode, setModeState] = useState<ThemeMode>(() => {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === 'light' || saved === 'dark' || saved === 'system') {
      return saved;
    }
    return 'system';
  });

  // Persist mode changes
  const setMode = useCallback((newMode: ThemeMode) => {
    setModeState(newMode);
    localStorage.setItem(THEME_STORAGE_KEY, newMode);
  }, []);

  // Resolve actual theme based on mode and system preference
  const isDarkMode = useMemo(() => {
    if (mode === 'system') {
      return prefersDarkMode;
    }
    return mode === 'dark';
  }, [mode, prefersDarkMode]);

  const theme = useMemo(() => {
    return isDarkMode ? darkTheme : lightTheme;
  }, [isDarkMode]);

  const toggleMode = useCallback(() => {
    setMode(isDarkMode ? 'light' : 'dark');
  }, [isDarkMode, setMode]);

  const value: ThemeContextValue = {
    mode,
    theme,
    setMode,
    toggleMode,
    isDarkMode,
  };

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useThemeContext(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useThemeContext must be used within a ThemeContextProvider');
  }
  return context;
}

/**
 * The theme context IF there is one, `null` otherwise — the non-throwing
 * accessor, on the exact model of `useOptionalAiStatus`.
 *
 * FOR POINT-OF-USE CALLERS THAT DO NOT WANT THE THEME AT ALL. `useUserSettings`
 * is one settings document read by several unrelated surfaces, and only the
 * ones that edit the theme (`syncTheme: true`, the default) need this provider
 * above them. A practice screen reading its own `voice` preferences out of the
 * same document (#288) does not, and making the whole session page depend on
 * theme chrome would be a coupling with no behaviour behind it.
 *
 * `useThemeContext` above still THROWS, unchanged, and remains the accessor for
 * every caller that genuinely needs the theme: an unusable `setMode` that fails
 * silently is worse than a loud error for those. This one is the deliberate
 * opt-out, not a softer default — do not swap the call sites over wholesale.
 */
export function useOptionalThemeContext(): ThemeContextValue | null {
  return useContext(ThemeContext) ?? null;
}
