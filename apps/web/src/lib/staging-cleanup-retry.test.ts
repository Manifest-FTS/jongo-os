import { describe, expect, it } from "vitest";
import { shouldRetryStagingCleanup } from "./staging-cleanup-retry";

describe("shouldRetryStagingCleanup", () => {
  it("retries when the last toggle asked for removal and it failed", () => {
    expect(shouldRetryStagingCleanup({ actionType: "staging_disable_requested", burnExisting: true, destroyed: false })).toBe(true);
  });

  it("leaves a copy the admin chose to keep (disabled without removal)", () => {
    expect(shouldRetryStagingCleanup({ actionType: "staging_disable_requested", burnExisting: false, destroyed: false })).toBe(false);
  });

  it("does nothing once removal succeeded or staging was turned back on", () => {
    expect(shouldRetryStagingCleanup({ actionType: "staging_disable_destroy", burnExisting: true, destroyed: true })).toBe(false);
    expect(shouldRetryStagingCleanup({ actionType: "staging_enable_requested" })).toBe(false);
  });

  it("does nothing without history", () => {
    expect(shouldRetryStagingCleanup(null)).toBe(false);
  });
});
