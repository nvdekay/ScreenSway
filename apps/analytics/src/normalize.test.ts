import { describe, expect, it } from "vitest";
import { dayOf, daysBetween, normalizeCountry, osFromAgent, quantile, randomId, shiftDay, tzOffsetMinutes } from "./normalize";

describe("Vietnam days", () => {
  it("starts a new day at 17:00 UTC", () => {
    expect(dayOf(Date.parse("2026-10-21T16:59:59.999Z"))).toBe("2026-10-21");
    expect(dayOf(Date.parse("2026-10-21T17:00:00.000Z"))).toBe("2026-10-22");
    expect(dayOf(Date.parse("2026-12-31T17:00:00.000Z"))).toBe("2027-01-01");
  });

  it("reads the configured offset and falls back to Vietnam's", () => {
    expect(tzOffsetMinutes("420")).toBe(420);
    expect(tzOffsetMinutes(undefined)).toBe(420);
    expect(tzOffsetMinutes("not a number")).toBe(420);
  });

  it("moves across months and counts days", () => {
    expect(shiftDay("2026-10-31", 1)).toBe("2026-11-01");
    expect(shiftDay("2026-03-01", -1)).toBe("2026-02-28");
    expect(daysBetween("2026-10-01", "2026-10-31")).toBe(30);
  });
});

describe("countries", () => {
  it("keeps ISO codes and Cloudflare's special codes", () => {
    expect(normalizeCountry("VN")).toBe("VN");
    expect(normalizeCountry("US")).toBe("US");
    expect(normalizeCountry("XX")).toBe("XX");
    expect(normalizeCountry("T1")).toBe("T1");
    expect(normalizeCountry("vn")).toBe("VN");
  });

  it("drops anything else", () => {
    expect(normalizeCountry(null)).toBeNull();
    expect(normalizeCountry(undefined)).toBeNull();
    expect(normalizeCountry("Vietnam")).toBeNull();
    expect(normalizeCountry("V1")).toBeNull();
    expect(normalizeCountry("<b>")).toBeNull();
    expect(normalizeCountry(84)).toBeNull();
  });
});

describe("other helpers", () => {
  it("reads the system from a User-Agent", () => {
    expect(osFromAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("macos");
    expect(osFromAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("windows");
    expect(osFromAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)")).toBe("mobile");
    expect(osFromAgent("Mozilla/5.0 (X11; Linux x86_64)")).toBe("linux");
    expect(osFromAgent("")).toBe("other");
  });

  it("accepts only random-looking IDs", () => {
    expect(randomId("0123456789abcdef0123456789abcdef")).toBe("0123456789abcdef0123456789abcdef");
    expect(randomId("short")).toBeNull();
    expect(randomId("someone@example.com-0123456789")).toBeNull();
    expect(randomId("a".repeat(65))).toBeNull();
  });

  it("takes nearest-rank quantiles", () => {
    expect(quantile([], 0.5)).toBeNull();
    expect(quantile([5], 0.9)).toBe(5);
    expect(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5)).toBe(5);
    expect(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
  });
});
