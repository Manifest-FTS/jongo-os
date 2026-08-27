import { describe, expect, it } from "vitest";
import { describeForViewer, isInternalOnlyDescription } from "./site-description";

describe("isInternalOnlyDescription", () => {
  it("flags any mention of Coolify, case-insensitively", () => {
    expect(isInternalOnlyDescription("Imported from approved Coolify ownership mapping")).toBe(true);
    expect(isInternalOnlyDescription("Runs on COOLIFY")).toBe(true);
  });

  it("does not flag ordinary descriptions", () => {
    expect(isInternalOnlyDescription("The client's marketing site")).toBe(false);
  });

  it("does not flag null or undefined", () => {
    expect(isInternalOnlyDescription(null)).toBe(false);
    expect(isInternalOnlyDescription(undefined)).toBe(false);
  });
});

describe("describeForViewer", () => {
  it("hides an internal-only description from a non-admin viewer", () => {
    expect(describeForViewer("Imported from approved Coolify ownership mapping", false)).toBeNull();
  });

  it("still shows it to an admin viewer", () => {
    expect(describeForViewer("Imported from approved Coolify ownership mapping", true)).toBe(
      "Imported from approved Coolify ownership mapping"
    );
  });

  it("shows an ordinary description to any viewer", () => {
    expect(describeForViewer("The client's marketing site", false)).toBe("The client's marketing site");
  });

  it("passes through null", () => {
    expect(describeForViewer(null, false)).toBeNull();
  });
});
