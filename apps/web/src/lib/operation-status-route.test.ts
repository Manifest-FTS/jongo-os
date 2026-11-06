import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ auth: vi.fn(), access: vi.fn(), get: vi.fn() }));
vi.mock("@/lib/auth.config", () => ({ auth: m.auth }));
vi.mock("@/lib/tenant-route-access", () => ({ resolveSiteAccess: m.access }));
vi.mock("@/lib/operations", () => ({ getOperation: m.get }));

import { GET } from "../app/api/operations/[operationId]/route";

const SITE = "11111111-1111-4111-8111-111111111111";
const OP = {
  id: "22222222-2222-4222-8222-222222222222",
  kind: "site.deploy",
  resourceType: "site",
  resourceId: SITE,
  status: "running",
  input: { environment: "production" },
  steps: [{ name: "build", status: "started", at: "" }],
  result: { hostingDeploymentId: "hosting-internal-id" },
  error: null
};
const call = () => GET(new Request("http://localhost") as any, { params: Promise.resolve({ operationId: OP.id }) });

beforeEach(() => {
  vi.clearAllMocks();
  m.auth.mockResolvedValue({ user: { id: "user-a" } });
  m.get.mockResolvedValue(OP);
  m.access.mockResolvedValue({ site: { id: SITE } });
});

describe("GET /api/operations/[id]", () => {
  it("requires sign-in", async () => {
    m.auth.mockResolvedValue(null);
    expect((await call()).status).toBe(401);
  });

  it("answers not-found for a deploy in another organization", async () => {
    m.access.mockResolvedValue(null);
    const res = await call();
    expect(res.status).toBe(404);
    expect(m.access).toHaveBeenCalledWith(SITE, "user-a");
  });

  it("answers not-found for tasks not tied to an app", async () => {
    m.get.mockResolvedValue({ ...OP, resourceType: "organization" });
    expect((await call()).status).toBe(404);
  });

  it("shows progress to someone with access, without hosting ids", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    const text = JSON.stringify(await res.json());
    expect(text).toContain('"stage":"building"');
    expect(text).not.toContain("hosting-internal-id");
  });
});
