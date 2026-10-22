// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeedbackDialog } from "./FeedbackDialog";
import { feedbackProblem, isEmail } from "./feedback";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), track: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("./telemetry", () => ({ track: mocks.track }));
vi.mock("./i18n", () => ({
  useI18n: () => ({
    language: "vi",
    t: (key: string, params?: Record<string, string | number>) => (params && "count" in params ? `${key} ${params.count}` : key),
  }),
}));

beforeEach(() => {
  mocks.invoke.mockReset().mockResolvedValue(undefined);
  mocks.track.mockReset();
});
afterEach(cleanup);

const message = () => screen.getByRole("textbox", { name: "feedback.message" });
const send = () => act(async () => void fireEvent.click(screen.getByRole("button", { name: "feedback.send" })));

describe("feedback form", () => {
  it("needs a message before anything is sent", async () => {
    render(<FeedbackDialog onClose={vi.fn()} />);
    fireEvent.change(message(), { target: { value: "   " } });
    await send();
    expect(screen.getByRole("alert").textContent).toContain("feedback.needMessage");
    expect(mocks.invoke).not.toHaveBeenCalled();

    fireEvent.change(message(), { target: { value: "Hello" } });
    fireEvent.change(screen.getByRole("textbox", { name: "feedback.email" }), { target: { value: "not an address" } });
    await send();
    expect(screen.getByRole("alert").textContent).toContain("feedback.badEmail");
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("sends the form fields, the honeypot and the chosen rating, then counts only the category", async () => {
    render(<FeedbackDialog initialCategory="bug" onClose={vi.fn()} />);
    fireEvent.change(message(), { target: { value: "  The export stops at 90%.  " } });
    expect(screen.getByText("feedback.count 28")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("radio", { name: "feedback.ratingValue" })[0]);
    fireEvent.change(screen.getByRole("textbox", { name: "feedback.email" }), { target: { value: " me@example.com " } });
    const honeypot = document.querySelector<HTMLInputElement>('input[name="website"]')!;
    expect(honeypot.tabIndex).toBe(-1);
    expect(honeypot.autocomplete).toBe("off");
    expect(honeypot.closest("[aria-hidden='true']")).not.toBeNull();
    fireEvent.change(honeypot, { target: { value: "bot" } });
    await send();

    expect(mocks.invoke).toHaveBeenCalledWith("send_feedback", {
      feedback: {
        category: "bug",
        rating: 1,
        message: "The export stops at 90%.",
        email: "me@example.com",
        includeMetadata: true,
        locale: "vi",
        website: "bot",
      },
    });
    expect(screen.getByRole("status").textContent).toContain("feedback.thanks");
    expect(mocks.track).toHaveBeenCalledExactlyOnceWith("feedback_submitted", { category: "bug" });
  });

  it("leaves technical details out when unchecked, and a rating can be cleared", async () => {
    render(<FeedbackDialog onClose={vi.fn()} />);
    fireEvent.change(message(), { target: { value: "Idea" } });
    fireEvent.click(screen.getAllByRole("radio")[3]);
    fireEvent.click(screen.getByRole("button", { name: "feedback.ratingClear" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /feedback.metadata/ }));
    await send();
    expect(mocks.invoke).toHaveBeenCalledWith("send_feedback", {
      feedback: expect.objectContaining({ category: "idea", rating: null, email: null, includeMetadata: false, website: "" }),
    });
  });

  it("keeps the text after a failed send and retries it", async () => {
    mocks.invoke.mockRejectedValueOnce("feedback.errorRateLimited");
    render(<FeedbackDialog onClose={vi.fn()} />);
    fireEvent.change(message(), { target: { value: "Please add a timer" } });
    await send();
    expect(screen.getByRole("alert").textContent).toContain("feedback.errorRateLimited");
    expect((message() as HTMLTextAreaElement).value).toBe("Please add a timer");
    expect(mocks.track).not.toHaveBeenCalled();

    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "feedback.retry" })));
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    expect(mocks.invoke).toHaveBeenLastCalledWith("send_feedback", { feedback: expect.objectContaining({ message: "Please add a timer" }) });
    expect(screen.getByRole("status").textContent).toContain("feedback.thanks");
  });

  it("starts from the text and category it is given", () => {
    render(<FeedbackDialog initialCategory="feature" initialMessage="Zoom presets" onClose={vi.fn()} />);
    expect((message() as HTMLTextAreaElement).value).toBe("Zoom presets");
    expect((screen.getByRole("combobox", { name: "feedback.category" }) as HTMLSelectElement).value).toBe("feature");
  });
});

describe("feedback checks", () => {
  it("match the server's limits", () => {
    const base = { category: "idea" as const, rating: null, message: "Hi", email: null };
    expect(feedbackProblem(base)).toBeNull();
    expect(feedbackProblem({ ...base, message: "x".repeat(4_001) })).toBe("feedback.tooLong");
    expect(feedbackProblem({ ...base, rating: 6 })).toBe("feedback.errorInvalid");
    expect(feedbackProblem({ ...base, category: "pricing" as never })).toBe("feedback.errorInvalid");
    expect(isEmail("a@b.co")).toBe(true);
    expect(isEmail("a@b")).toBe(false);
    expect(isEmail("a b@c.de")).toBe(false);
  });
});
