import { describe, expect, it } from "vitest";
import { resolveBackupViewCapability } from "./backup-view-capability";

describe("resolveBackupViewCapability", () => {
  it("offers the action when the answer is unknown (the reported bug)", () => {
    // Coolify rate limited the live probe, so the page showed a Backups section
    // with no way to take a backup and no explanation.
    const r = resolveBackupViewCapability({
      cachedBackupable: null,
      cachedReason: null,
      liveBackupable: false,
      liveReason: "unknown"
    });
    expect(r.allowBackupAction).toBe(true);
    expect(r.showBackupFeatures).toBe(true);
    expect(r.unverifiedNote).toMatch(/could not reach/i);
  });

  it("treats a missing live answer as unknown rather than as no data", () => {
    const r = resolveBackupViewCapability({});
    expect(r.reason).toBe("unknown");
    expect(r.allowBackupAction).toBe(true);
  });

  it("prefers the cached answer over a live probe, so the page makes no API call", () => {
    const r = resolveBackupViewCapability({
      cachedBackupable: true,
      cachedReason: "linked_database",
      liveBackupable: false,
      liveReason: "unknown"
    });
    expect(r.backupable).toBe(true);
    expect(r.reason).toBe("linked_database");
    expect(r.allowBackupAction).toBe(true);
  });

  it("ignores a cached 'unknown' and falls back to the live answer", () => {
    const r = resolveBackupViewCapability({
      cachedBackupable: false,
      cachedReason: "unknown",
      liveBackupable: true,
      liveReason: "service_containers"
    });
    expect(r.backupable).toBe(true);
    expect(r.reason).toBe("service_containers");
  });

  it("hides the feature only on a definitive stateless answer", () => {
    const r = resolveBackupViewCapability({
      cachedBackupable: false,
      cachedReason: "stateless"
    });
    expect(r.showBackupFeatures).toBe(false);
    expect(r.allowBackupAction).toBe(false);
  });

  it("keeps the section for an external database but offers no action", () => {
    // It is the one place the owner is told the data is not backed up here.
    const r = resolveBackupViewCapability({
      cachedBackupable: false,
      cachedReason: "external_database"
    });
    expect(r.showBackupFeatures).toBe(false);
    expect(r.allowBackupAction).toBe(false);
    expect(r.reason).toBe("external_database");
  });

  it("never offers backups for a staging copy", () => {
    const r = resolveBackupViewCapability({
      cachedBackupable: true,
      cachedReason: "service_containers",
      isStagingResource: true
    });
    expect(r.showBackupFeatures).toBe(false);
    expect(r.allowBackupAction).toBe(false);
  });

  it("never leaves the section visible with the action disabled and no reason", () => {
    // The exact incoherence reported: a Backups section with no button and no
    // explanation must be impossible.
    const cases = [
      { cachedBackupable: null, cachedReason: null, liveBackupable: false, liveReason: "unknown" },
      { cachedBackupable: null, cachedReason: null },
      { cachedBackupable: false, cachedReason: "stateless" },
      { cachedBackupable: false, cachedReason: "external_database" },
      { cachedBackupable: true, cachedReason: "standalone_database" }
    ];
    for (const input of cases) {
      const r = resolveBackupViewCapability(input);
      if (r.showBackupFeatures && !r.allowBackupAction) {
        throw new Error(`inert section for ${JSON.stringify(input)}`);
      }
      // And whenever we offer an unverified action, we must say why.
      if (r.allowBackupAction && !r.backupable && r.reason === "unknown") {
        expect(r.unverifiedNote).toBeTruthy();
      }
    }
  });
});
