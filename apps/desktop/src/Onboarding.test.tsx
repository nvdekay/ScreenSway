// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Onboarding } from "./Onboarding";

vi.mock("./i18n", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) =>
      params?.count === undefined ? key : `${key} ${params.count}`,
  }),
}));

afterEach(cleanup);

function renderSetup(screenCheck: "idle" | "checking" | "ready" | "denied" | "error" = "idle") {
  const actions = {
    onCheckScreen: vi.fn(),
    onOpenScreenSettings: vi.fn(),
    onComplete: vi.fn(),
    onTestRecording: vi.fn(),
  };
  render(<Onboarding screenCheck={screenCheck} sourceCount={4} canClose={false} {...actions} />);
  return actions;
}

describe("first-run setup", () => {
  it("waits for an explicit action before checking screen access", () => {
    const actions = renderSetup();
    fireEvent.click(screen.getByRole("button", { name: /onboarding.continue/ }));

    expect(actions.onCheckScreen).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "onboarding.checkScreen" }));
    expect(actions.onCheckScreen).toHaveBeenCalledOnce();
  });

  it("offers settings when access is denied", () => {
    const actions = renderSetup("denied");
    fireEvent.click(screen.getByRole("button", { name: /onboarding.continue/ }));
    fireEvent.click(screen.getByRole("button", { name: "permission.open" }));
    expect(actions.onOpenScreenSettings).toHaveBeenCalledOnce();
  });

  it("finishes setup or starts a local test after sources are ready", () => {
    const actions = renderSetup("ready");
    fireEvent.click(screen.getByRole("button", { name: /onboarding.continue/ }));
    expect(screen.getByText("onboarding.sourcesFound 4")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /onboarding.continue/ }));

    fireEvent.click(screen.getByRole("button", { name: "onboarding.test" }));
    expect(actions.onTestRecording).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "onboarding.finish" }));
    expect(actions.onComplete).toHaveBeenCalledOnce();
  });
});
