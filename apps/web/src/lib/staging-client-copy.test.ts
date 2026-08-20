import { describe, expect, it } from "vitest";
import { toClientFacingStagingMessage } from "./staging-client-copy";

describe("toClientFacingStagingMessage", () => {
  it("removes provider terminology from provisioning messages", () => {
    expect(toClientFacingStagingMessage(
      "Staging is being provisioned in Coolify. Check the Staging tab in a few minutes."
    )).toBe("Staging setup is still finishing. Wait a few minutes and refresh.");
  });

  it("turns residual-resource instructions into a simple wait state", () => {
    expect(toClientFacingStagingMessage(
      "Re-enable is blocked while staging resources still exist. Finish unprovisioning in Coolify first."
    )).toBe("Staging is still being removed. Wait a few minutes and try again.");
  });

  it("preserves already client-safe messages", () => {
    expect(toClientFacingStagingMessage("Staging content sync completed automatically."))
      .toBe("Staging content sync completed automatically.");
  });
});
