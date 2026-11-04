import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ find: vi.fn(), update: vi.fn(), deploy: vi.fn(), audit: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { site: { findFirst: m.find, update: m.update } } }));
vi.mock("@/lib/secret-box", () => ({ decryptSecret: (value: string) => value.replace("enc:", "") }));
vi.mock("@/lib/deploy-operation", () => ({ deployOnPush: m.deploy }));
vi.mock("@/lib/github-installations", () => ({ audit: m.audit }));

import { POST } from "../app/api/webhooks/git/[siteId]/route";

const SITE = "11111111-1111-4111-8111-111111111111";
const SECRET = "hook-secret";
const push = (branch: string, secret = SECRET, extra: Record<string, string> = {}) => {
  const body = JSON.stringify({ ref: `refs/heads/${branch}`, after: "abc", head_commit: { message: "m" } });
  const sig = createHmac("sha256", secret).update(body).digest("hex");
  return POST(
    new Request(`http://x/api/webhooks/git/${SITE}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-github-event": "push", "x-hub-signature-256": `sha256=${sig}`, ...extra },
      body
    }),
    { params: Promise.resolve({ siteId: SITE }) }
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  m.find.mockResolvedValue({ id: SITE, organizationId: "org", coolifyServiceUuid: "app-uuid", gitBranch: "main", autoDeploy: true, gitWebhookSecretEnc: `enc:${SECRET}` });
  m.deploy.mockResolvedValue({ ok: true, via: "operation", message: "ok" });
});

describe("POST /api/webhooks/git/[siteId]", () => {
  it("deploys a verified push to the app's branch", async () => {
    const res = await push("main");
    expect(res.status).toBe(202);
    expect(m.deploy).toHaveBeenCalledWith({ siteId: SITE, organizationId: "org", environment: "production", targetUuid: "app-uuid" });
    expect(m.update).toHaveBeenCalledWith({ where: { id: SITE }, data: expect.objectContaining({ lastDeployedSha: "abc" }) });
  });

  it("refuses a wrong secret, and answers the same for unknown apps", async () => {
    expect((await push("main", "guess")).status).toBe(401);
    m.find.mockResolvedValue(null);
    expect((await push("main")).status).toBe(401);
    expect(m.deploy).not.toHaveBeenCalled();
  });

  it("ignores pushes to other branches", async () => {
    const res = await push("feature/x");
    expect(res.status).toBe(200);
    expect((await res.json()).skipped).toContain("feature/x");
    expect(m.deploy).not.toHaveBeenCalled();
  });

  it("records the commit instead of deploying when automatic deploys are off", async () => {
    m.find.mockResolvedValue({ id: SITE, organizationId: "org", coolifyServiceUuid: "app-uuid", gitBranch: "main", autoDeploy: false, gitWebhookSecretEnc: `enc:${SECRET}` });
    const res = await push("main");
    expect((await res.json()).deployed).toBe(false);
    expect(m.deploy).not.toHaveBeenCalled();
    expect(m.update).toHaveBeenCalledWith({ where: { id: SITE }, data: { pendingCommitSha: "abc", pendingCommitMessage: "m" } });
  });

  it("rejects ids that aren't app ids before touching the database", async () => {
    const res = await POST(new Request("http://x", { method: "POST", body: "{}" }), { params: Promise.resolve({ siteId: "../etc" }) });
    expect(res.status).toBe(401);
    expect(m.find).not.toHaveBeenCalled();
  });
});
