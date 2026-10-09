import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";

export type RecordingStatus = "idle" | "countdown" | "recording" | "paused" | "finishing";

export interface RecordingState {
  status: RecordingStatus;
  countdown: number | null;
  elapsedMs: number;
}

const IDLE: RecordingState = { status: "idle", countdown: null, elapsedMs: 0 };

/** Mirrors the recorder state owned by the desktop shell, with a locally ticking timer. */
export function useRecordingState(): RecordingState {
  const [state, setState] = useState(IDLE);
  const [receivedAt, setReceivedAt] = useState(() => performance.now());
  const [now, setNow] = useState(() => performance.now());

  useEffect(() => {
    let disposed = false;
    const apply = (next: RecordingState) => {
      if (disposed) return;
      setState(next);
      setReceivedAt(performance.now());
    };
    void invoke<RecordingState>("get_recording_state").then(apply).catch(() => {});
    const unlisten = listen<RecordingState>("recording-state", (event) => apply(event.payload));
    return () => {
      disposed = true;
      void unlisten.then((dispose) => dispose());
    };
  }, []);

  useEffect(() => {
    if (state.status !== "recording") return;
    const timer = window.setInterval(() => setNow(performance.now()), 250);
    return () => window.clearInterval(timer);
  }, [state.status]);

  if (state.status !== "recording") return state;
  return { ...state, elapsedMs: state.elapsedMs + Math.max(0, now - receivedAt) };
}
