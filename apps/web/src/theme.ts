import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";

const STORAGE_KEY = "screensway.theme";
const systemQuery = () => window.matchMedia("(prefers-color-scheme: light)");

function storedTheme(): Theme | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

function currentTheme(): Theme {
  const applied = document.documentElement.dataset.theme;
  if (applied === "light" || applied === "dark") return applied;
  return systemQuery().matches ? "light" : "dark";
}

/**
 * Follows the system appearance until the visitor picks a theme, then remembers it.
 * index.html applies a stored choice before first paint to avoid a flash.
 */
export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(currentTheme);

  useEffect(() => {
    const query = systemQuery();
    const onChange = () => {
      if (!storedTheme()) setThemeState(query.matches ? "light" : "dark");
    };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

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
