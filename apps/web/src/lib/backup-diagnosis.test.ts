import { describe, expect, it } from "vitest";

describe("service-embedded databases Coolify cannot schedule", () => {
  const wordpressStack = {
    backupable: true,
    capabilityReason: "service_containers" as const,
    isConfigured: false,
    hasSuccessfulBackup: false
  };

  it("does not alarm when the only missing schedule is unschedulable", () => {
    // A WordPress stack's MariaDB is embedded in a service, and Coolify's API
    // answers 404 for it. "Contact your platform administrator" is an
    // instruction nobody can carry out.
    const diagnosis = buildBackupDiagnosis({
      ...wordpressStack,
      missingSchedulable: 0,
      missingUnschedulable: 1
    });
    expect(diagnosis.showNotConfiguredAlarm).toBe(false);
    expect(diagnosis.configuredDetail).toContain("embedded in a service");
  });

  it("still alarms when a schedulable database is missing its schedule", () => {
    const diagnosis = buildBackupDiagnosis({
      ...wordpressStack,
      missingSchedulable: 1,
      missingUnschedulable: 1
    });
    expect(diagnosis.showNotConfiguredAlarm).toBe(true);
  });

  it("reports no successful backup as an error even when scheduling is impossible", () => {
    // Coolify being unable to schedule is not a reason to call the app healthy:
    // if Jongo has never backed it up either, nothing is protecting it.
    const diagnosis = buildBackupDiagnosis({
      ...wordpressStack,
      missingSchedulable: 0,
      missingUnschedulable: 1
    });
    expect(diagnosis.successTone).toBe("error");
  });

  it("reports healthy once Jongo's own backup has succeeded", () => {
    const diagnosis = buildBackupDiagnosis({
      ...wordpressStack,
      hasSuccessfulBackup: true,
      missingSchedulable: 0,
      missingUnschedulable: 1
    });
    expect(diagnosis.successTone).toBe("healthy");
    expect(diagnosis.showNotConfiguredAlarm).toBe(false);
  });

  it("keeps the old behaviour when the caller passes no counts", () => {
    // Callers that have not been updated must not silently lose the alarm.
    const diagnosis = buildBackupDiagnosis(wordpressStack);
    expect(diagnosis.showNotConfiguredAlarm).toBe(true);
  });
});
import { buildBackupDiagnosis } from "./backup-diagnosis";

describe("buildBackupDiagnosis", () => {
  it("does not alarm on a stateless app (the Millenion Fitness case)", () => {
    // Live example: no volumes, no database env vars. It was shown an orange
    // "Backups not configured — verify resource mapping" directly above an
    // accurate "Nothing to back up for this app".
    const d = buildBackupDiagnosis({
      backupable: false,
      capabilityReason: "stateless",
      isConfigured: false,
      hasSuccessfulBackup: false
    });
    expect(d.applicable).toBe(false);
    expect(d.showNotConfiguredAlarm).toBe(false);
    expect(d.configuredTone).toBe("unknown");
    expect(d.successTone).toBe("unknown");
    expect(d.notApplicableDetail).toMatch(/nothing to schedule/i);
  });

  it("does not alarm on an app whose database is external", () => {
    const d = buildBackupDiagnosis({
      backupable: false,
      capabilityReason: "external_database",
      isConfigured: false,
      hasSuccessfulBackup: false
    });
    expect(d.showNotConfiguredAlarm).toBe(false);
    expect(d.notApplicableDetail).toMatch(/external database/i);
    expect(d.configuredDetail).toMatch(/external/i);
  });

  it("does not alarm on a staging copy, which is restored from production", () => {
    const d = buildBackupDiagnosis({
      backupable: true,
      capabilityReason: "service_containers",
      isStagingResource: true,
      isConfigured: false,
      hasSuccessfulBackup: false
    });
    expect(d.applicable).toBe(false);
    expect(d.showNotConfiguredAlarm).toBe(false);
    expect(d.notApplicableDetail).toMatch(/staging copy/i);
  });

  it("never treats an undetermined answer as nothing to back up", () => {
    // Coolify rate limits (429) under a platform-wide sweep. Treating that as
    // "stateless" is what hid backups from apps that have a database.
    const d = buildBackupDiagnosis({
      backupable: false,
      capabilityReason: "unknown",
      isConfigured: false,
      hasSuccessfulBackup: false
    });
    expect(d.applicable).toBe(true);
    expect(d.notApplicableDetail).toBe("");
    expect(d.configuredDetail).toMatch(/could not reach/i);
    // Must not alarm either: we do not know that anything is wrong.
    expect(d.showNotConfiguredAlarm).toBe(false);
    expect(d.successTone).toBe("unknown");
  });

  it("still alarms on a real app that holds data and has no schedule", () => {
    // The alarm must survive: this is the case it exists for.
    const d = buildBackupDiagnosis({
      backupable: true,
      capabilityReason: "service_containers",
      isConfigured: false,
      hasSuccessfulBackup: false
    });
    expect(d.applicable).toBe(true);
    expect(d.showNotConfiguredAlarm).toBe(true);
    expect(d.configuredTone).toBe("error");
    expect(d.successTone).toBe("error");
  });

  it("reports healthy for a data-holding app that is configured and has backed up", () => {
    const d = buildBackupDiagnosis({
      backupable: true,
      capabilityReason: "linked_database",
      isConfigured: true,
      hasSuccessfulBackup: true
    });
    expect(d.applicable).toBe(true);
    expect(d.showNotConfiguredAlarm).toBe(false);
    expect(d.configuredTone).toBe("healthy");
    expect(d.successTone).toBe("healthy");
  });

  it("flags a configured app that has never actually produced a backup", () => {
    // Configured but never succeeded is exactly the false-confidence case.
    const d = buildBackupDiagnosis({
      backupable: true,
      capabilityReason: "standalone_database",
      isConfigured: true,
      hasSuccessfulBackup: false
    });
    expect(d.configuredTone).toBe("healthy");
    expect(d.successTone).toBe("error");
  });

  it("treats staging as not-applicable even when it would otherwise be backupable", () => {
    const d = buildBackupDiagnosis({
      backupable: true,
      capabilityReason: "persistent_volumes",
      isStagingResource: true,
      isConfigured: true,
      hasSuccessfulBackup: true
    });
    expect(d.applicable).toBe(false);
  });
});
