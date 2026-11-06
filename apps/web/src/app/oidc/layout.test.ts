import { describe, expect, it } from "vitest";
import { metadata } from "./layout";

describe("OIDC pages referrer policy", () => {
  // Under "no-referrer" browsers send `Origin: null` on the consent form POST, which the route rejects as expired.
  it("is not no-referrer, so the consent POST carries its real Origin", () => {
    expect(metadata.referrer).toBe("same-origin");
  });

  it("is never indexed", () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });
});
