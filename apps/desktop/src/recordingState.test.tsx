// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRecordingState, type RecordingState } from "./recordingState";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  unlisten: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen }));

describe("useRecordingState", () => {
  let emit: (state: RecordingState) => void;
  let now: number;

  beforeEach(() => {
    vi.useFakeTimers();
    now = 100;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    tauri.unlisten.mockReset();
    tauri.invoke.mockReset().mockResolvedValue({ status: "idle", countdown: null, elapsedMs: 0 });
    tauri.listen.mockReset().mockImplementation((_name, handler) => {
      emit = (state) => handler({ payload: state });
      return Promise.resolve(tauri.unlisten);
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("loads shell state and follows recording events", async () => {
    tauri.invoke.mockResolvedValue({ status: "countdown", countdown: 3, elapsedMs: 0 });
    const { result } = renderHook(() => useRecordingState());

    await act(async () => { await Promise.resolve(); });
    expect(result.current.status).toBe("countdown");
    expect(tauri.invoke).toHaveBeenCalledWith("get_recording_state");
    expect(tauri.listen).toHaveBeenCalledWith("recording-state", expect.any(Function));

    act(() => emit({ status: "paused", countdown: null, elapsedMs: 2_400 }));
    expect(result.current).toEqual({ status: "paused", countdown: null, elapsedMs: 2_400 });
  });

  it("ticks only while recording and freezes the shell elapsed time when paused", async () => {
    const { result } = renderHook(() => useRecordingState());
    await act(async () => { await Promise.resolve(); });
    expect(tauri.listen).toHaveBeenCalled();

    act(() => emit({ status: "recording", countdown: null, elapsedMs: 1_000 }));
    now = 600;
    act(() => vi.advanceTimersByTime(250));
    expect(result.current.elapsedMs).toBe(1_500);

    act(() => emit({ status: "paused", countdown: null, elapsedMs: 1_550 }));
    now = 2_000;
    act(() => vi.advanceTimersByTime(1_000));
    expect(result.current.elapsedMs).toBe(1_550);
  });

  it("unsubscribes and ignores a late initial response after unmount", async () => {
    let resolveInitial!: (state: RecordingState) => void;
    tauri.invoke.mockReturnValue(new Promise((resolve) => { resolveInitial = resolve; }));
    const { unmount } = renderHook(() => useRecordingState());
    await act(async () => { await Promise.resolve(); });
    expect(tauri.listen).toHaveBeenCalled();

    unmount();
    await act(async () => {
      resolveInitial({ status: "recording", countdown: null, elapsedMs: 10 });
      await Promise.resolve();
    });
    await act(async () => { await Promise.resolve(); });
    expect(tauri.unlisten).toHaveBeenCalledOnce();
  });
});
