import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendFeedback } from "./backend";
import { forgetOldVisitorId, identityFields, JOURNEY_KEY, journeyId, OLD_VISITOR_KEY } from "./identity";

const CHROME_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

let session: ReturnType<typeof memoryStorage>;
let local: ReturnType<typeof memoryStorage>;

function browser(privacy: { doNotTrack?: string; globalPrivacyControl?: boolean } = {}) {
  vi.stubGlobal("navigator", { userAgent: CHROME_MAC, doNotTrack: privacy.doNotTrack ?? null, globalPrivacyControl: privacy.globalPrivacyControl });
}

beforeEach(() => {
  session = memoryStorage();
  local = memoryStorage();
  vi.stubGlobal("sessionStorage", session);
  vi.stubGlobal("localStorage", local);
  browser();
});
afterEach(() => vi.unstubAllGlobals());

describe("journey ID", () => {
  it("is made once per tab and shared by every page of the site", () => {
    expect(session.values.size).toBe(0);
    const first = journeyId();
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(session.values.get(JOURNEY_KEY)).toBe(first);
    expect(journeyId()).toBe(first);
  });

  it("falls back to one ID for the page when session storage is blocked", () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
    });
    const first = journeyId();
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(journeyId()).toBe(first);
  });
});

describe("visitor ID", () => {
  it("is never sent, and one stored by an earlier build is deleted", () => {
    local.values.set(OLD_VISITOR_KEY, "a".repeat(32));
    expect(identityFields()).toEqual({ sessionId: expect.stringMatching(/^[0-9a-f]{32}$/) });
    forgetOldVisitorId();
    expect(local.values.has(OLD_VISITOR_KEY)).toBe(false);
  });
});

describe("privacy signals", () => {
  it.each([{ doNotTrack: "1" }, { globalPrivacyControl: true }])("make and store no IDs (%o)", (privacy) => {
    browser(privacy);
    expect(journeyId()).toBeNull();
    expect(identityFields()).toEqual({});
    expect(session.values.size).toBe(0);
  });
});

describe("web feedback", () => {
  const form = { category: "bug" as const, rating: 3, message: " It froze ", email: null, includeMetadata: true, locale: "vi", website: "" };

  function answer(status: number) {
    const fetch = vi.fn().mockResolvedValue(new Response(status === 201 ? '{"ok":true}' : '{"error":"x"}', { status }));
    vi.stubGlobal("fetch", fetch);
    return fetch;
  }

  it("posts the form with this visit's technical details", async () => {
    const fetch = answer(201);
    await sendFeedback(form, "https://stats.example");
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://stats.example/v1/feedback");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      source: "studio",
      category: "bug",
      rating: 3,
      message: "It froze",
      email: null,
      includeMetadata: true,
      metadata: { version: expect.stringMatching(/^\d+\.\d+\.\d+/), os: "macos", browser: "chrome", locale: "vi", sessionId: journeyId() },
      website: "",
    });
  });

  it("leaves the details out when unchecked and passes the honeypot on", async () => {
    const fetch = answer(201);
    await sendFeedback({ ...form, includeMetadata: false, website: "filled" }, "https://stats.example");
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body).not.toHaveProperty("metadata");
    expect(body.website).toBe("filled");
  });

  it("treats a duplicate as sent and maps failures to message keys", async () => {
    answer(409);
    await expect(sendFeedback(form, "https://stats.example")).resolves.toBeUndefined();
    answer(429);
    await expect(sendFeedback(form, "https://stats.example")).rejects.toBe("feedback.errorRateLimited");
    answer(400);
    await expect(sendFeedback(form, "https://stats.example")).rejects.toBe("feedback.errorInvalid");
    answer(503);
    await expect(sendFeedback(form, "https://stats.example")).rejects.toBe("feedback.errorUnavailable");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    await expect(sendFeedback(form, "https://stats.example")).rejects.toBe("feedback.errorNetwork");
    await expect(sendFeedback(form, "")).rejects.toBe("feedback.errorUnavailable");
    await expect(sendFeedback({ ...form, message: "  " }, "https://stats.example")).rejects.toBe("feedback.errorInvalid");
  });
});
