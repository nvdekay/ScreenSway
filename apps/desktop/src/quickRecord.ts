import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { useCallback, useEffect, useRef, useState } from "react";

export const QUICK_RECORD_SHORTCUTS = [
  "CommandOrControl+Shift+R",
  "CommandOrControl+Shift+7",
  "Alt+Shift+R",
] as const;

const STORAGE_KEY = "screensway.quickRecordShortcut";
const DEFAULT_SHORTCUT = QUICK_RECORD_SHORTCUTS[0];

function storedShortcut(): string {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value && QUICK_RECORD_SHORTCUTS.includes(value as typeof DEFAULT_SHORTCUT) ? value : DEFAULT_SHORTCUT;
  } catch {
    return DEFAULT_SHORTCUT;
  }
}

export function useQuickRecordShortcut(onTrigger: () => void) {
  const [shortcut, setShortcutState] = useState(storedShortcut);
  const [error, setError] = useState<string | null>(null);
  const trigger = useRef(onTrigger);
  trigger.current = onTrigger;

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let active = true;
    register(shortcut, (event) => {
      if (event.state === "Pressed") trigger.current();
    }).then(() => {
      if (active) setError(null);
    }).catch((reason) => {
      if (active) setError(String(reason));
    });
    return () => {
      active = false;
      void unregister(shortcut).catch(() => {});
    };
  }, [shortcut]);

  const setShortcut = useCallback((next: string) => {
    if (!QUICK_RECORD_SHORTCUTS.includes(next as typeof DEFAULT_SHORTCUT)) return;
    setShortcutState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // The shortcut still applies for this session.
    }
  }, []);

  return { shortcut, setShortcut, error };
}
