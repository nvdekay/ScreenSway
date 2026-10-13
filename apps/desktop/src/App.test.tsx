// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LibraryCard, recordingMatches } from "./App";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
  invoke: vi.fn(),
}));
vi.mock("./i18n", () => ({
  LANGUAGES: [],
  useI18n: () => ({
    language: "en",
    t: (key: string, params?: Record<string, string>) => `${key}${params?.title ? ` ${params.title}` : ""}`,
  }),
}));

const entry = {
  projectPath: "/Videos/ScreenSway/Recording-1.screensway",
  videoPath: "/Videos/ScreenSway/Recording-1.screensway/media/screen.mp4",
  thumbnailPath: "/Videos/ScreenSway/Recording-1.screensway/media/thumbnail.jpg",
  title: "Product demo",
  createdAt: "2026-10-13T08:30:00Z",
  durationMs: 12_000,
  width: 1920,
  height: 1080,
};

afterEach(cleanup);

describe("recording library", () => {
  it("matches names, localized dates and dimensions", () => {
    expect(recordingMatches(entry, "product", "en")).toBe(true);
    expect(recordingMatches(entry, "1920", "en")).toBe(true);
    expect(recordingMatches(entry, "missing", "en")).toBe(false);
  });

  it("renames and deletes a recording from its card", async () => {
    const onRename = vi.fn().mockResolvedValue(true);
    const onDelete = vi.fn();
    render(<LibraryCard entry={entry} active={false} onOpen={vi.fn()} onRename={onRename} onDelete={onDelete} />);

    fireEvent.click(screen.getByRole("button", { name: "library.rename" }));
    const input = screen.getByRole("textbox", { name: "library.name" });
    fireEvent.change(input, { target: { value: "Launch walkthrough" } });
    fireEvent.click(screen.getByRole("button", { name: "library.saveName" }));
    await waitFor(() => expect(onRename).toHaveBeenCalledWith("Launch walkthrough"));

    fireEvent.click(screen.getByRole("button", { name: "library.delete" }));
    expect(onDelete).toHaveBeenCalledOnce();
  });

  it("loads the video only while hovering and scrubs from pointer position", () => {
    const { container } = render(<LibraryCard entry={entry} active={false} onOpen={vi.fn()} onRename={vi.fn()} onDelete={vi.fn()} />);
    const thumbnail = screen.getByRole("button", { name: "library.open Product demo" });
    expect(container.querySelector("video")).toBeNull();

    fireEvent.pointerEnter(thumbnail);
    const video = container.querySelector("video")!;
    Object.defineProperty(video, "duration", { configurable: true, value: 12 });
    vi.spyOn(thumbnail, "getBoundingClientRect").mockReturnValue({
      left: 20, width: 200, right: 220, top: 0, bottom: 100, height: 100, x: 20, y: 0, toJSON: () => ({}),
    });
    fireEvent.pointerMove(thumbnail, { clientX: 120 });
    expect(video.currentTime).toBe(6);

    fireEvent.pointerLeave(thumbnail);
    expect(container.querySelector("video")).toBeNull();
  });
});
