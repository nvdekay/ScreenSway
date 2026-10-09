import { invoke } from "@tauri-apps/api/core";
import { Loader2, Pause, Play, Square, X } from "lucide-react";
import { useState } from "react";
import { formatDuration } from "./format";
import { useI18n } from "./i18n";
import { useRecordingState } from "./recordingState";

/** Floating, always-on-top controls shown while recording. Excluded from the capture itself. */
export function RecordingHud() {
  const { t } = useI18n();
  const state = useRecordingState();
  const [busy, setBusy] = useState(false);

  async function run(command: string, args?: Record<string, unknown>) {
    setBusy(true);
    try {
      await invoke(command, args);
    } catch {
      // The main window reports recorder failures.
    } finally {
      setBusy(false);
    }
  }

  if (state.status === "countdown" || state.status === "idle") {
    return (
      <div className="hud-countdown">
        <div className="countdown-ring" key={state.countdown ?? 0}>
          <span>{state.countdown ?? ""}</span>
        </div>
        <p>{t("hud.startsIn")}</p>
        <button className="countdown-cancel" onClick={() => void run("cancel_countdown")}>
          <X size={12} /> {t("hud.cancel")}
        </button>
      </div>
    );
  }

  const paused = state.status === "paused";
  const finishing = state.status === "finishing";

  return (
    <div className="hud-bar" data-tauri-drag-region>
      <span className={`hud-dot${paused ? " paused" : ""}`} data-tauri-drag-region />
      <span className="hud-time" data-tauri-drag-region>
        {finishing ? t("hud.saving") : formatDuration(state.elapsedMs)}
      </span>
      <button
        className="hud-button"
        onClick={() => void run("set_recording_paused", { paused: !paused })}
        disabled={busy || finishing}
        aria-label={paused ? t("hud.resume") : t("hud.pause")}
        title={paused ? t("hud.resume") : t("hud.pause")}
      >
        {paused ? <Play size={14} fill="currentColor" /> : <Pause size={14} fill="currentColor" />}
      </button>
      <button
        className="hud-stop"
        onClick={() => void run("stop_recording")}
        disabled={busy || finishing}
      >
        {finishing ? <Loader2 size={13} className="spin" /> : <Square size={10} fill="currentColor" />}
        {finishing ? t("hud.savingShort") : t("hud.stop")}
      </button>
    </div>
  );
}
