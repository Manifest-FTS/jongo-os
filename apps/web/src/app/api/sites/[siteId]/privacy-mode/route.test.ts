import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "crypto";

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  workspace: vi.fn(),
  permissions: vi.fn(),
  enable: vi.fn(),
  disable: vi.fn(),
  getDb: vi.fn()
}));
vi.mock("@/lib/auth.config", () => ({ auth: m.auth }));
vi.mock("@/lib/repositories", () => ({ getSiteWorkspace: m.workspace }));
vi.mock("@/lib/permissions", () => ({ resolveSitePermissionSnapshot: m.permissions }));
vi.mock("@/lib/privacy-mode-apply", () => ({ enablePrivacyMode: m.enable, disablePrivacyMode: m.disable }));
vi.mock("@/lib/db", () => ({ getDb: m.getDb }));

import { GET, POST } from "./route";
import { decryptSecret, encryptSecret } from "@/lib/secret-box";

const siteId = "site-1";
const params = { params: Promise.resolve({ siteId }) };
let row: Record<string, any>;
const db = {
  site: {
    findUnique: vi.fn(async () => row),
    update: vi.fn(async ({ data }: any) => (row = { ...row, ...data })),
    updateMany: vi.fn(async ({ where, data }: any) => {
      if (where.privacyModePassword !== row.privacyModePassword) return { count: 0 };
      row = { ...row, ...data };
      return { count: 1 };
    })
  },
  auditLog: { create: vi.fn(async () => ({})) }
};

const post = (body: unknown) =>
  POST(new Request("http://x", { method: "POST", body: JSON.stringify(body) }), params);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SECRETS_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
  row = { id: siteId, organizationId: "org-1", privacyModeEnabled: false, privacyModeUsername: null, privacyModePassword: null };
  m.auth.mockResolvedValue({ user: { id: "u1", email: "a@example.test" } });
  m.workspace.mockResolvedValue({ id: siteId, coolifyServiceUuid: "svc-1" });
  m.permissions.mockResolvedValue({ canEnablePrivacyMode: true, canDisablePrivacyMode: true, canManagePrivacyCredentials: true });
  m.enable.mockResolvedValue({ ok: true });
  m.disable.mockResolvedValue({ ok: true });
  m.getDb.mockResolvedValue(db);
});
afterEach(() => vi.unstubAllEnvs());

describe("privacy-mode password storage", () => {
  it("stores the password encrypted and shows it in plain text", async () => {
    const res = await post({ enabled: true });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.password).toMatch(/\S{8,}/);
    expect(row.privacyModePassword).toMatch(/^v2:/);
    expect(decryptSecret(row.privacyModePassword)).toBe(body.password);
    expect(m.enable).toHaveBeenCalledWith(expect.objectContaining({ password: body.password }));
  });

  it("keeps the same password when only the username changes", async () => {
    row = { ...row, privacyModeEnabled: true, privacyModeUsername: "guest", privacyModePassword: encryptSecret("kept-password-1") };
    const body = await (await post({ enabled: true, username: "client" })).json();
    expect(body.password).toBe("kept-password-1");
    expect(m.enable).toHaveBeenCalledWith(expect.objectContaining({ username: "client", password: "kept-password-1" }));
  });

  it("encrypts a legacy plain-text password on read", async () => {
    row = { ...row, privacyModeEnabled: true, privacyModePassword: "legacy-plain-1" };
    const body = await (await GET(new Request("http://x"), params)).json();
    expect(body.password).toBe("legacy-plain-1");
    expect(row.privacyModePassword).toMatch(/^v2:/);
    expect(decryptSecret(row.privacyModePassword)).toBe("legacy-plain-1");
  });

  it("shows no password, rather than failing, when it can't be read back", async () => {
    row = { ...row, privacyModeEnabled: true, privacyModePassword: "v2:deadbeef:aaa:bbb:ccc" };
    const res = await GET(new Request("http://x"), params);
    expect(res.status).toBe(200);
    expect((await res.json()).password).toBeNull();
  });

  it("refuses before touching the proxy when no encryption key is set in production", async () => {
    vi.stubEnv("SECRETS_ENCRYPTION_KEY", "");
    vi.stubEnv("NODE_ENV", "production");
    const res = await post({ enabled: true });
    expect(res.status).toBe(503);
    expect(m.enable).not.toHaveBeenCalled();
    expect(row.privacyModePassword).toBeNull();
  });
});
