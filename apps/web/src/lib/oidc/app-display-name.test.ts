import { describe, expect, it } from "vitest";
import { appDisplayName } from "./authorize";

describe("appDisplayName", () => {
  it("drops the trailing Craft word the client is registered with", () => {
    expect(appDisplayName("The Golf Lab Website Craft")).toBe("The Golf Lab Website");
    expect(appDisplayName("Golf Lab craft")).toBe("Golf Lab");
    expect(appDisplayName("Golf Lab - Craft")).toBe("Golf Lab");
    expect(appDisplayName("Golf Lab: Craft ")).toBe("Golf Lab");
  });

  it("leaves other names alone, including Craft in the middle or as the whole name", () => {
    expect(appDisplayName("Golf Lab")).toBe("Golf Lab");
    expect(appDisplayName("Craft Beer Co")).toBe("Craft Beer Co");
    expect(appDisplayName("Craft")).toBe("Craft");
    expect(appDisplayName("Handcrafted")).toBe("Handcrafted");
  });
});
