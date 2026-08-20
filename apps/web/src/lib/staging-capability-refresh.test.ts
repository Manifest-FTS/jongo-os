import { describe, expect, it } from "vitest";
import {
  extractCreatedResourceUuid,
  preserveResolvedStagingCapability,
  resolveStagingSyncReadiness
} from "./staging-capability-refresh";

describe("preserveResolvedStagingCapability", () => {
  it("keeps the staging UUID when a post-deploy refresh returns fetch_error", () => {
    const resolved = {
      detected: true,
      applicationUuid: "staging-uuid",
      note: "full_staging_detected"
    };
    const refreshed = {
      detected: false,
      note: "fetch_error"
    };

    expect(preserveResolvedStagingCapability(resolved, refreshed)).toBe(resolved);
  });

  it("uses a successful refresh with the resolved target", () => {
    const resolved = {
      detected: true,
      applicationUuid: "staging-uuid",
      note: "full_staging_detected"
    };
    const refreshed = {
      detected: true,
      applicationUuid: "staging-uuid",
      note: "full_staging_detected"
    };

    expect(preserveResolvedStagingCapability(resolved, refreshed)).toBe(refreshed);
  });

  it("does not call required content sync 'not required' when the target UUID is missing", () => {
    expect(resolveStagingSyncReadiness(true, undefined)).toBe("missing_target");
    expect(resolveStagingSyncReadiness(true, "staging-uuid")).toBe("ready");
    expect(resolveStagingSyncReadiness(false, undefined)).toBe("not_required");
  });

  it("extracts the new service UUID directly from Coolify's create response", () => {
    expect(extractCreatedResourceUuid({ uuid: "new-service-uuid" })).toBe("new-service-uuid");
    expect(extractCreatedResourceUuid({ data: { uuid: "nested-service-uuid" } })).toBe("nested-service-uuid");
    expect(extractCreatedResourceUuid({ message: "created" })).toBeUndefined();
  });
});
