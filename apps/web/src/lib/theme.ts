export type Theme = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'careops-theme';

export function getStoredTheme(): Theme {
  if (typeof window === 'undefined') return 'system';
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  try {
    if (theme === 'system') window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Private browsing: the attribute still applies for this page view.
  }
  window.dispatchEvent(new Event('careops-theme'));
}

/** External store for the stored theme: same-tab events plus cross-tab storage. */
export function subscribeTheme(onChange: () => void): () => void {
  window.addEventListener('careops-theme', onChange);
  window.addEventListener('storage', onChange);
  return () => {
    window.removeEventListener('careops-theme', onChange);
    window.removeEventListener('storage', onChange);
  };
}

/** Runs before first paint (inlined in the root document) to avoid a theme flash. */
export const THEME_BOOT_SCRIPT = `(function(){try{var t=localStorage.getItem('${STORAGE_KEY}');document.documentElement.dataset.theme=t==='light'||t==='dark'?t:'system';}catch(e){document.documentElement.dataset.theme='system';}})();`;
