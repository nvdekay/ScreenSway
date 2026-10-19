import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import { isWeb } from "./platform";

/**
 * Optional, anonymous usage statistics. The shell decides whether anything is sent
 * (only after the user agrees) and strips every value down to short labels, so
 * callers pass feature names and settings, never recording content or file names.
 */
type TelemetryEvent =
  | "app_open"
  | "telemetry_enabled"
  | "recording_started"
  | "recording_finished"
  | "recording_failed"
  | "recording_opened"
  | "export_finished"
  | "export_failed"
  | "export_cancelled"
  | "captions_generated"
  | "captions_failed"
  | "style_applied";

interface TelemetryStatus {
  /** False when this build has no analytics endpoint. */
  available: boolean;
  /** `null` until the user has answered the first-run question. */
  enabled: boolean | null;
}

const inShell = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const CHANGED_EVENT = "screensway:telemetry";

export function track(name: TelemetryEvent, props: Record<string, string | number | boolean> = {}, locale?: string) {
  // The browser version answers this command itself, with its own anonymous statistics.
  if (!inShell && !isWeb) return;
  void invoke("track_event", { name, props, locale: locale ?? (document.documentElement.lang || null) }).catch(() => {});
}

/** Coarse length groups, so a duration never identifies a particular recording. */
export function durationBucket(ms: number): string {
  if (ms < 30_000) return "<30s";
  if (ms < 120_000) return "30s-2m";
  if (ms < 600_000) return "2-10m";
  return ">10m";
}

export function useTelemetry() {
  const [status, setStatus] = useState<TelemetryStatus>({ available: false, enabled: null });

  useEffect(() => {
    if (!inShell) return;
    let cancelled = false;
    const refresh = () =>
      void invoke<TelemetryStatus>("telemetry_status")
        .then((next) => {
          if (!cancelled) setStatus(next);
        })
        .catch(() => {});
    refresh();
    // The first-run question and the settings switch are separate components.
    window.addEventListener(CHANGED_EVENT, refresh);
    return () => {
      cancelled = true;
      window.removeEventListener(CHANGED_EVENT, refresh);
    };
  }, []);

  const setEnabled = useCallback(async (enabled: boolean) => {
    try {
      setStatus(await invoke<TelemetryStatus>("set_telemetry", { enabled }));
      if (enabled) {
        track("telemetry_enabled");
        track("app_open");
      }
      window.dispatchEvent(new Event(CHANGED_EVENT));
    } catch {
      // The choice could not be saved; the question stays available.
    }
  }, []);

  return { status, setEnabled };
}
