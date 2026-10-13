// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecordingStudio } from "./RecordingStudio";

const tauri = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), unlisten: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen }));
vi.mock("../i18n", () => ({ useI18n: () => ({ t: (key: string) => key, language: "en" }) }));
vi.mock("../ZoomPreview", () => ({
  ZoomPreview: ({ edits, captions, onEditsChange }: any) => (
    <section>
      <output data-testid="trim">{edits.trimStartMs}</output>
      <output data-testid="caption">{captions?.lines[0]?.text ?? "none"}</output>
      <button onClick={() => onEditsChange((current: any) => ({ ...current, trimStartMs: 500 }))}>change-edits</button>
    </section>
  ),
}));
vi.mock("./FrameEditor", () => ({ FrameEditor: ({ children }: any) => <div>{children}</div> }));
vi.mock("./CaptionsPanel", () => ({
  CaptionsPanel: ({ captions, onGenerate }: any) => (
    <section>
      <output data-testid="panel-caption">{captions?.lines[0]?.text ?? "none"}</output>
      <button onClick={() => onGenerate("en-US")}>generate-captions</button>
    </section>
  ),
}));
vi.mock("./paint", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./paint")>()),
  paintFrameBase: vi.fn(),
  renderCursorPng: vi.fn(() => "data:image/png;base64,Y3Vyc29y"),
}));

const recording = {
  projectPath: "/Movies/ScreenSway/Recording-1.screensway",
  videoPath: "/Movies/ScreenSway/Recording-1.screensway/media/screen.mp4",
  pointerEventsPath: "/Movies/ScreenSway/Recording-1.screensway/metadata/pointer-events.json",
  durationMs: 5_000,
  width: 1920,
  height: 1080,
  pointerEvents: [],
};

describe("RecordingStudio orchestration", () => {
  const storage = new Map<string, string>();

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    storage.clear();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
      clear: () => storage.clear(),
    });
    tauri.unlisten.mockReset();
    tauri.listen.mockReset().mockResolvedValue(tauri.unlisten);
    tauri.invoke.mockReset().mockImplementation((command: string) => {
      if (command === "load_edits") return Promise.resolve({ trimStartMs: 250, trimEndMs: 4_500, zooms: [] });
      if (command === "load_captions") return Promise.resolve({ locale: "en-US", enabled: true, lines: [{ id: "caption-1", startMs: 100, endMs: 900, text: "Saved caption" }] });
      if (command === "list_background_images") return Promise.resolve([]);
      if (command === "transcribe_recording") return Promise.resolve({ locale: "en-US", words: [{ text: "Fresh", startMs: 100, endMs: 400 }, { text: "caption", startMs: 450, endMs: 800 }] });
      return Promise.resolve(null);
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const flushEffects = () => act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  it("restores recording-specific edits and captions", async () => {
    render(<RecordingStudio recording={recording} />);

    await flushEffects();
    expect(screen.getByTestId("trim").textContent).toBe("250");
    expect(screen.getByTestId("caption").textContent).toBe("Saved caption");
    expect(tauri.invoke).toHaveBeenCalledWith("load_edits", { projectPath: recording.projectPath });
    expect(tauri.invoke).toHaveBeenCalledWith("load_captions", { projectPath: recording.projectPath });
  });

  it("debounces edit persistence", async () => {
    render(<RecordingStudio recording={recording} />);
    await flushEffects();
    expect(screen.getByTestId("trim").textContent).toBe("250");

    fireEvent.click(screen.getByText("change-edits"));
    expect(tauri.invoke).not.toHaveBeenCalledWith("save_edits", expect.anything());
    await act(async () => vi.advanceTimersByTime(300));

    expect(tauri.invoke).toHaveBeenCalledWith("save_edits", {
      projectPath: recording.projectPath,
      edits: { trimStartMs: 500, trimEndMs: 4_500, zooms: [] },
    });
  });

  it("turns timed transcription words into editable captions and persists them", async () => {
    render(<RecordingStudio recording={recording} />);
    await flushEffects();
    expect(screen.getByTestId("panel-caption").textContent).toBe("Saved caption");

    fireEvent.click(screen.getByText("generate-captions"));
    await flushEffects();
    expect(screen.getByTestId("panel-caption").textContent).toBe("Fresh caption");
    expect(tauri.invoke).toHaveBeenCalledWith("transcribe_recording", {
      projectPath: recording.projectPath,
      locale: "en-US",
    });
    await act(async () => vi.advanceTimersByTime(400));
    expect(tauri.invoke).toHaveBeenCalledWith("save_captions", {
      projectPath: recording.projectPath,
      captions: expect.objectContaining({ locale: "en-US", enabled: true }),
    });
  });
});
