import { afterEach, describe, expect, it, vi } from "vitest";
import { safeEqual } from "./safe-equal";

describe("safeEqual", () => {
  it("matches equal strings only", () => {
    expect(safeEqual("token-123", "token-123")).toBe(true);
    expect(safeEqual("token-123", "token-124")).toBe(false);
    expect(safeEqual("token-123", "token-1234")).toBe(false);
    expect(safeEqual("tökén", "tökén")).toBe(true);
  });

  it("never matches empty or missing values", () => {
    expect(safeEqual("", "")).toBe(false);
    expect(safeEqual(undefined, undefined)).toBe(false);
    expect(safeEqual(null, "x")).toBe(false);
    expect(safeEqual("x", "")).toBe(false);
  });
});

describe("Coolify overview without credentials", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("shows no invented projects, sites or deployments", async () => {
    vi.stubEnv("COOLIFY_API_BASE_URL", "");
    vi.stubEnv("COOLIFY_API_TOKEN", "");
    const { getCoolifyOverview } = await import("./coolify");
    const overview = await getCoolifyOverview();
    expect(overview.mode).toBe("mock");
    expect(overview.projects).toEqual([]);
    expect(overview.sites).toEqual([]);
    expect(overview.deployments).toEqual([]);
  });
});
