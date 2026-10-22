// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeatureSurvey } from "./FeatureSurvey";
import { markSurveyShown, SURVEY_COOLDOWN_MS, SURVEY_FEATURES, surveyDue } from "./feedback";

const mocks = vi.hoisted(() => ({ track: vi.fn() }));

vi.mock("./telemetry", () => ({ track: mocks.track }));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: (key: string) => key, language: "en" }) }));

const storage = new Map<string, string>();

beforeEach(() => {
  mocks.track.mockReset();
  storage.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("feature survey cooldown", () => {
  it("shows at most once every 14 days", () => {
    const now = Date.UTC(2026, 9, 22);
    expect(surveyDue(now)).toBe(true);
    markSurveyShown(now);
    expect(storage.get("screensway.survey.shownAt")).toBe(String(now));
    expect(surveyDue(now + 1_000)).toBe(false);
    expect(surveyDue(now + SURVEY_COOLDOWN_MS - 1)).toBe(false);
    expect(surveyDue(now + SURVEY_COOLDOWN_MS)).toBe(true);
  });

  it("stays hidden when storage is unavailable", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(surveyDue()).toBe(false);
    expect(() => markSurveyShown()).not.toThrow();
  });
});

describe("feature survey", () => {
  it("sends one event per chosen feature, with the feature name only", () => {
    const onOther = vi.fn();
    render(<FeatureSurvey onOther={onOther} onDismiss={vi.fn()} />);
    expect(screen.getAllByRole("button", { pressed: false })).toHaveLength(SURVEY_FEATURES.length);
    fireEvent.click(screen.getByRole("button", { name: "survey.feature.webcam" }));
    fireEvent.click(screen.getByRole("button", { name: "survey.feature.gif" }));
    fireEvent.click(screen.getByRole("button", { name: "survey.feature.gif" }));
    fireEvent.click(screen.getByRole("button", { name: "survey.feature.export_4k60" }));
    fireEvent.click(screen.getByRole("button", { name: "survey.submit" }));

    expect(mocks.track.mock.calls).toEqual([
      ["feature_interest", { feature: "webcam" }],
      ["feature_interest", { feature: "export_4k60" }],
    ]);
    expect(onOther).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toContain("survey.thanks");
  });

  it("hands text written under Other to the feedback form, never to an event", () => {
    const onOther = vi.fn();
    render(<FeatureSurvey onOther={onOther} onDismiss={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "survey.feature.other" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "  Blur faces automatically " } });
    fireEvent.click(screen.getByRole("button", { name: "survey.submit" }));

    expect(mocks.track.mock.calls).toEqual([["feature_interest", { feature: "other" }]]);
    expect(JSON.stringify(mocks.track.mock.calls)).not.toContain("Blur");
    expect(onOther).toHaveBeenCalledExactlyOnceWith("Blur faces automatically");
  });

  it("can be dismissed without sending anything", () => {
    const onDismiss = vi.fn();
    render(<FeatureSurvey onOther={vi.fn()} onDismiss={onDismiss} />);
    fireEvent.click(screen.getAllByRole("button", { name: "survey.dismiss" })[0]);
    expect(onDismiss).toHaveBeenCalled();
    expect(mocks.track).not.toHaveBeenCalled();
  });
});
