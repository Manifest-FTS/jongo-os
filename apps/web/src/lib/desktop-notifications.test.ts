import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { areDesktopNotificationsEnabled, setDesktopNotificationsEnabled } from "./desktop-notifications";

const values = new Map<string, string>();

beforeEach(() => {
  values.clear();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value)
    }
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("desktop notification preference", () => {
  it("defaults to enabled for existing users", () => {
    expect(areDesktopNotificationsEnabled()).toBe(true);
  });

  it("persists a user's off/on choice", () => {
    setDesktopNotificationsEnabled(false);
    expect(areDesktopNotificationsEnabled()).toBe(false);

    setDesktopNotificationsEnabled(true);
    expect(areDesktopNotificationsEnabled()).toBe(true);
  });
});
