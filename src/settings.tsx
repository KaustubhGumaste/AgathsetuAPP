import * as SecureStore from 'expo-secure-store';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Platform, useColorScheme } from 'react-native';

/**
 * App-wide user settings (theme, crash location sharing) and the colour palettes.
 *
 * Styles are built once per palette (see `themedStyles`) and read through a proxy, so the existing
 * `styles.x` references keep working and switch palette when the theme changes. The provider sets the
 * active scheme while it renders, before any child reads a style.
 */

export type ThemeMode = 'system' | 'light' | 'dark';
export type Scheme = 'light' | 'dark';

const lightPalette = {
  page: '#F2F4F7',
  surface: '#FFFFFF',
  surfaceMuted: '#F9FAFB',
  border: '#E4E7EC',
  borderStrong: '#D0D5DD',
  divider: '#F2F4F7',
  chip: '#F2F4F7',
  track: '#EAECF0',
  text: '#101828',
  textStrong: '#344054',
  textBody: '#475467',
  textMuted: '#667085',
  placeholder: '#98A2B3',
  primary: '#175CD3',
  primaryDark: '#1849A9',
  primarySoft: '#EFF6FF',
  link: '#175CD3',
  danger: '#B42318',
  dangerSoft: '#FEF3F2',
  success: '#027A48',
  successSoft: '#ECFDF3',
  warning: '#B54708',
  warningSoft: '#FFFAEB',
  header: '#101828',
  ripple: '#EAECF0',
};

export type Palette = typeof lightPalette;

const darkPalette: Palette = {
  page: '#0B1220',
  surface: '#151E2E',
  surfaceMuted: '#1B2537',
  border: '#26324A',
  borderStrong: '#34425C',
  divider: '#1F2A3C',
  chip: '#222C3E',
  track: '#26324A',
  text: '#F2F4F7',
  textStrong: '#D0D5DD',
  textBody: '#B6C0CF',
  textMuted: '#8B97A8',
  placeholder: '#667085',
  primary: '#2F6FE0',
  primaryDark: '#A4C3FF',
  primarySoft: '#1A2B4A',
  link: '#84ADFF',
  danger: '#F97066',
  dangerSoft: '#3A1D1D',
  success: '#32D583',
  successSoft: '#0F2E22',
  warning: '#FDB022',
  warningSoft: '#3A2A0F',
  header: '#070C16',
  ripple: '#26324A',
};

export const palettes: Record<Scheme, Palette> = { light: lightPalette, dark: darkPalette };

let activeScheme: Scheme = 'light';

/** The active palette, for colours used directly in JSX (spinners, placeholders). */
export const colors: Palette = new Proxy({} as Palette, {
  get: (_target, key) => palettes[activeScheme][key as keyof Palette],
});

/** Builds a style sheet for each palette and returns a proxy that reads from the active one. */
export function themedStyles<T extends object>(factory: (palette: Palette) => T): T {
  const sheets: Record<Scheme, T> = { light: factory(lightPalette), dark: factory(darkPalette) };
  return new Proxy({} as T, {
    get: (_target, key) => sheets[activeScheme][key as keyof T],
  });
}

// ---- persisted preferences ----

const STORAGE_PREFIX = 'aghatsethu.settings.';
const memoryStore = new Map<string, string>();

async function readSetting(key: string): Promise<string | null> {
  try {
    if (Platform.OS === 'web') {
      return globalThis.localStorage?.getItem(STORAGE_PREFIX + key) ?? memoryStore.get(key) ?? null;
    }
    return await SecureStore.getItemAsync(STORAGE_PREFIX + key);
  } catch {
    return memoryStore.get(key) ?? null;
  }
}

async function writeSetting(key: string, value: string) {
  memoryStore.set(key, value);
  try {
    if (Platform.OS === 'web') globalThis.localStorage?.setItem(STORAGE_PREFIX + key, value);
    else await SecureStore.setItemAsync(STORAGE_PREFIX + key, value);
  } catch {
    // The setting still applies for this session.
  }
}

type SettingsValue = {
  themeMode: ThemeMode;
  setThemeMode: (mode: ThemeMode) => void;
  scheme: Scheme;
  palette: Palette;
  /** Share this phone's live location with responders while a crash involving you is open. */
  shareLocation: boolean;
  setShareLocation: (value: boolean) => void;
  loaded: boolean;
};

const SettingsContext = createContext<SettingsValue | null>(null);

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const system = useColorScheme();
  const [themeMode, setThemeModeState] = useState<ThemeMode>('system');
  const [shareLocation, setShareLocationState] = useState(true);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    void Promise.all([readSetting('themeMode'), readSetting('shareLocation')]).then(([mode, share]) => {
      if (!active) return;
      if (mode === 'light' || mode === 'dark' || mode === 'system') setThemeModeState(mode);
      if (share === 'false') setShareLocationState(false);
      setLoaded(true);
    });
    return () => { active = false; };
  }, []);

  const setThemeMode = useCallback((mode: ThemeMode) => {
    setThemeModeState(mode);
    void writeSetting('themeMode', mode);
  }, []);

  const setShareLocation = useCallback((value: boolean) => {
    setShareLocationState(value);
    void writeSetting('shareLocation', value ? 'true' : 'false');
  }, []);

  const scheme: Scheme = themeMode === 'system' ? (system === 'dark' ? 'dark' : 'light') : themeMode;
  // Set before children render so every `styles.x` read below this point uses the right palette.
  // Deliberate: the value is derived purely from state, so repeated or discarded renders set the same
  // scheme; the style proxies need it before any child renders.
  // eslint-disable-next-line react-hooks/globals
  activeScheme = scheme;

  const value = useMemo<SettingsValue>(() => ({
    themeMode,
    setThemeMode,
    scheme,
    palette: palettes[scheme],
    shareLocation,
    setShareLocation,
    loaded,
  }), [loaded, scheme, setShareLocation, setThemeMode, shareLocation, themeMode]);

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsValue {
  const value = useContext(SettingsContext);
  if (!value) throw new Error('useSettings must be used inside SettingsProvider.');
  return value;
}

/** Status-bar icon colour for screens drawn on the page background. */
export function pageStatusBarStyle(): 'light' | 'dark' {
  return activeScheme === 'dark' ? 'light' : 'dark';
}
