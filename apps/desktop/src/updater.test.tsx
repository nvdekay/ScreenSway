// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUpdater } from "./updater";

const plugin = vi.hoisted(() => ({ check: vi.fn(), relaunch: vi.fn(), invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: plugin.invoke }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: plugin.check }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: plugin.relaunch }));

describe("useUpdater", () => {
  beforeEach(() => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    plugin.check.mockReset();
    plugin.relaunch.mockReset().mockResolvedValue(undefined);
    plugin.invoke.mockReset().mockResolvedValue(false);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reports a signed update returned by the native plugin", async () => {
    const update = { version: "0.4.0", body: "New library", close: vi.fn().mockResolvedValue(undefined) };
    plugin.check.mockResolvedValue(update);
    const { result } = renderHook(() => useUpdater());

    await act(async () => result.current.checkNow());
    expect(plugin.check).toHaveBeenCalledWith({ timeout: 15_000 });
    expect(result.current.state).toEqual({ status: "available", version: "0.4.0", notes: "New library" });
  });

  function downloadableUpdate() {
    return {
      version: "0.4.0",
      body: "New library",
      close: vi.fn().mockResolvedValue(undefined),
      download: vi.fn(async (onEvent: (event: any) => void) => {
        onEvent({ event: "Started", data: { contentLength: 100 } });
        onEvent({ event: "Progress", data: { chunkLength: 60 } });
        onEvent({ event: "Progress", data: { chunkLength: 40 } });
        onEvent({ event: "Finished" });
      }),
      install: vi.fn().mockResolvedValue(undefined),
    };
  }

  it("tracks download progress, installs and relaunches", async () => {
    const update = downloadableUpdate();
    plugin.check.mockResolvedValue(update);
    const { result } = renderHook(() => useUpdater());
    await act(async () => result.current.checkNow());
    await act(async () => result.current.install());

    expect(update.download).toHaveBeenCalledOnce();
    expect(plugin.invoke).toHaveBeenCalledWith("background_work_active");
    expect(update.install).toHaveBeenCalledOnce();
    expect(plugin.relaunch).toHaveBeenCalledOnce();
    expect(result.current.state).toEqual({ status: "restarting" });
  });

  it("waits for a running export before installing, without downloading again", async () => {
    const update = downloadableUpdate();
    plugin.check.mockResolvedValue(update);
    plugin.invoke.mockResolvedValue(true);
    const { result } = renderHook(() => useUpdater());
    await act(async () => result.current.checkNow());
    await act(async () => result.current.install());

    expect(update.install).not.toHaveBeenCalled();
    expect(result.current.state).toEqual({ status: "waiting", version: "0.4.0" });

    // A manual check keeps the downloaded update instead of replacing it.
    await act(async () => result.current.checkNow());
    expect(result.current.state).toEqual({ status: "waiting", version: "0.4.0" });

    plugin.invoke.mockResolvedValue(false);
    await act(async () => result.current.install());
    expect(update.download).toHaveBeenCalledOnce();
    expect(update.install).toHaveBeenCalledOnce();
    expect(plugin.relaunch).toHaveBeenCalledOnce();
  });
});
