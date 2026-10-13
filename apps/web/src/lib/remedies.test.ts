import { describe, expect, it } from "vitest";
import { canRunRemedy, remedy, remedyCooldownMs, remedyGateKey, SITE_REMEDY_ACTIONS } from "./remedies";
import { getPermissions } from "./permissions";

const admin = getPermissions("admin");
const collaborator = getPermissions("collaborator");
const platformAdmin = getPermissions("admin", true);

describe("canRunRemedy", () => {
  it("lets a client admin run every site remedy", () => {
    for (const action of SITE_REMEDY_ACTIONS) {
      expect(canRunRemedy(action, admin)).toEqual({ ok: true });
    }
  });

  it("lets a collaborator restart (they can promote) but nothing destructive", () => {
    expect(canRunRemedy("restart_site", collaborator)).toEqual({ ok: true });
    for (const action of ["apply_site_domain", "retry_staging_cleanup", "retry_staging_provision", "retry_site_delete"] as const) {
      const result = canRunRemedy(action, collaborator);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).not.toMatch(/coolify/i);
    }
  });

  it("keeps domain-order remedies to platform admins", () => {
    expect(canRunRemedy("retry_domain_order", admin).ok).toBe(false);
    expect(canRunRemedy("refund_domain_order", admin).ok).toBe(false);
    expect(canRunRemedy("retry_domain_order", platformAdmin)).toEqual({ ok: true });
    expect(canRunRemedy("refund_domain_order", platformAdmin)).toEqual({ ok: true });
  });

  it("refuses an unknown action", () => {
    expect(canRunRemedy("format_disk" as never, platformAdmin).ok).toBe(false);
  });
});

describe("remedy", () => {
  it("builds a labelled remedy", () => {
    expect(remedy("restart_site", { target: "production" })).toEqual({ action: "restart_site", label: "Restart site", target: "production" });
    expect(remedy("restart_site", { target: "staging" }).label).toBe("Restart staging");
    expect(remedy("retry_staging_cleanup").label).toBe("Remove old staging copy");
  });
});

describe("retry_staging_database", () => {
  it("is open to whoever can sync staging (it only rewrites staging's own data)", () => {
    expect(canRunRemedy("retry_staging_database", collaborator)).toEqual({ ok: true });
    expect(canRunRemedy("retry_staging_database", { canSyncStaging: false }).ok).toBe(false);
    expect(remedy("retry_staging_database").label).toBe("Try again");
    expect(remedyCooldownMs("retry_staging_database")).toBe(60_000);
  });
});

describe("cooldowns", () => {
  it("uses 30 s for restarts and retries, 60 s for provisioning", () => {
    expect(remedyCooldownMs("restart_site")).toBe(30_000);
    expect(remedyCooldownMs("retry_staging_cleanup")).toBe(30_000);
    expect(remedyCooldownMs("retry_staging_provision")).toBe(60_000);
  });

  it("keys the gate per site, action and target", () => {
    expect(remedyGateKey("s1", "restart_site", "production")).not.toBe(remedyGateKey("s1", "restart_site", "staging"));
    expect(remedyGateKey("s1", "restart_site")).not.toBe(remedyGateKey("s2", "restart_site"));
  });
});
