import { describe, expect, it } from "vitest";
import { preserveResolvedStagingCapability } from "./staging-capability-refresh";

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
});
