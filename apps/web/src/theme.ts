import { useCallback, useState } from "react";

export type Theme = "light" | "dark";

const STORAGE_KEY = "screensway.theme";

function currentTheme(): Theme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

/**
 * Starts dark regardless of the system appearance and remembers the visitor's choice.
 * index.html applies a stored choice before first paint to avoid a flash.
 */
export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(currentTheme);

  const toggleTheme = useCallback(() => {
    const next: Theme = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // The choice still applies for this visit.
    }
    setThemeState(next);
  }, []);

  return { theme, toggleTheme };
}
