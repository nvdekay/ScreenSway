import type { Update } from "@tauri-apps/plugin-updater";
import { useCallback, useEffect, useRef, useState } from "react";

export type UpdaterState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "upToDate" }
  | { status: "available"; version: string; notes?: string }
  | { status: "downloading"; version: string; progress: number | null }
  | { status: "restarting" }
  | { status: "error"; message: string };

export interface UpdaterController {
  state: UpdaterState;
  checkNow: () => Promise<void>;
  install: () => Promise<void>;
}

/** Checks the signed public release feed and installs only artifacts verified by Tauri. */
export function useUpdater(): UpdaterController {
  const [state, setState] = useState<UpdaterState>({ status: "idle" });
  const updateRef = useRef<Update | null>(null);
  const mounted = useRef(true);
  const checking = useRef(false);

  const checkForUpdate = useCallback(async (silent: boolean) => {
    if (checking.current || !("__TAURI_INTERNALS__" in window)) return;
    checking.current = true;
    if (!silent) setState({ status: "checking" });
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check({ timeout: 15_000 });
      if (!mounted.current) {
        await update?.close();
        return;
      }
      if (updateRef.current) await updateRef.current.close().catch(() => {});
      updateRef.current = update;
      setState(update
        ? { status: "available", version: update.version, notes: update.body }
        : silent ? { status: "idle" } : { status: "upToDate" });
    } catch (error) {
      if (mounted.current && !silent) setState({ status: "error", message: String(error) });
    } finally {
      checking.current = false;
    }
  }, []);

  const install = useCallback(async () => {
    const update = updateRef.current;
    if (!update) return;
    let downloaded = 0;
    let total: number | undefined;
    setState({ status: "downloading", version: update.version, progress: null });
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") total = event.data.contentLength;
        if (event.event === "Progress") downloaded += event.data.chunkLength;
        if (mounted.current) {
          setState({
            status: "downloading",
            version: update.version,
            progress: total ? Math.min(100, Math.round((downloaded / total) * 100)) : null,
          });
        }
      });
      if (!mounted.current) return;
      setState({ status: "restarting" });
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (error) {
      if (mounted.current) setState({ status: "error", message: String(error) });
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    if (!("__TAURI_INTERNALS__" in window)) return;
    const timer = window.setTimeout(() => void checkForUpdate(true), 4_000);
    return () => {
      mounted.current = false;
      window.clearTimeout(timer);
      const update = updateRef.current;
      updateRef.current = null;
      void update?.close().catch(() => {});
    };
  }, [checkForUpdate]);

  return {
    state,
    checkNow: () => checkForUpdate(false),
    install,
  };
}
