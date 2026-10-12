import { describe, expect, it } from "vitest";
import { assertInstallUsable } from "./github-access";

const install = { id: "i1", organizationId: "org-a", status: "active", coolifySourceUuid: "src" };

describe("assertInstallUsable", () => {
  it("allows the owning organization", () => {
    expect(assertInstallUsable(install, "org-a")).toEqual({ ok: true });
  });
  it("refuses another organization, with a 403", () => {
    const result = assertInstallUsable(install, "org-b");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });
  it("refuses a missing, suspended or removed install", () => {
    expect(assertInstallUsable(null, "org-a").ok).toBe(false);
    expect(assertInstallUsable({ ...install, status: "suspended" }, "org-a").ok).toBe(false);
    expect(assertInstallUsable({ ...install, status: "removed" }, "org-a").ok).toBe(false);
  });
  it("refuses deploy setup until the hosting source exists, when asked", () => {
    const result = assertInstallUsable({ ...install, coolifySourceUuid: null }, "org-a", { needSource: true });
    expect(result.ok).toBe(false);
    expect(assertInstallUsable({ ...install, coolifySourceUuid: null }, "org-a").ok).toBe(true);
  });
});
