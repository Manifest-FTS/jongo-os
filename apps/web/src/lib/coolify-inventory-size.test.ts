import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("./coolify-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./coolify-core")>()),
  coolifyFetch: fetchMock
}));

import { getCoolifyOverview } from "./coolify";

const APPLICATIONS = 25;
const application = (n: number) => ({
  uuid: `app-${String(n).padStart(2, "0")}`,
  name: n === APPLICATIONS ? "The Golf Lab" : `App ${n}`,
  type: "application",
  git_repository: "Manifest-FTS/example",
  fqdn: `https://app-${n}.example.com`,
  status: "running:healthy",
  environment_id: 1
});

beforeEach(() => {
  vi.stubEnv("COOLIFY_API_BASE_URL", "https://coolify.test");
  vi.stubEnv("COOLIFY_API_TOKEN", "test-token");
  vi.stubEnv("COOLIFY_OVERVIEW_TTL_MS", "0");
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (path: string) => {
    if (path === "/api/v1/resources") return Array.from({ length: APPLICATIONS }, (_, i) => application(i + 1));
    return [];
  });
});
afterEach(() => vi.unstubAllEnvs());

describe("Coolify inventory size", () => {
  it("lists every application, not just the first twenty", async () => {
    const overview = await getCoolifyOverview();
    const names = overview.sites.map((site) => site.name);
    expect(overview.mode).toBe("live");
    expect(names).toHaveLength(APPLICATIONS);
    expect(names).toContain("The Golf Lab");
  });

  it("still bounds the per-application deployment lookups", async () => {
    await getCoolifyOverview();
    const deploymentCalls = fetchMock.mock.calls.filter(([path]) => String(path).startsWith("/api/v1/deployments/applications/"));
    expect(deploymentCalls.length).toBeLessThanOrEqual(8);
  });
});
