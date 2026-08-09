import { describe, expect, it } from "vitest";
import { resolveStagingViewState } from "./staging-view-state";

const ready = { environmentReady: true, targetAttached: true, stagingEnabled: true };

describe("resolveStagingViewState", () => {
  it("reports staging as active when both signals are present", () => {
    const s = resolveStagingViewState(ready);
    expect(s.configured).toBe(true);
    expect(s.unknown).toBe(false);
    expect(s.hideControls).toBe(false);
  });

  // The instability: a rate-limited probe rendered as a definitive negative,
  // flipping the page every 12 seconds.
  it("never claims staging is missing when the probe failed", () => {
    const s = resolveStagingViewState({
      environmentReady: false,
      targetAttached: false,
      stagingEnabled: true,
      probeFailed: true
    });
    expect(s.unknown).toBe(true);
    expect(s.title).not.toMatch(/not configured/i);
    expect(s.detail).toContain("does not mean staging is missing");
  });

  it("keeps controls visible on a failed probe", () => {
    // The API re-checks before acting and refuses if staging is genuinely
    // absent, so hiding a working button over one failed lookup is the worse
    // of the two errors.
    const s = resolveStagingViewState({
      environmentReady: false,
      targetAttached: false,
      stagingEnabled: true,
      probeFailed: true
    });
    expect(s.hideControls).toBe(false);
  });

  it("prefers the last known good answer over an unobtainable one", () => {
    const s = resolveStagingViewState({
      environmentReady: false,
      targetAttached: false,
      stagingEnabled: true,
      probeFailed: true,
      lastKnownConfigured: true
    });
    expect(s.configured).toBe(true);
    expect(s.unknown).toBe(true);
    expect(s.detail).toContain("may be out of date");
  });

  it("still states the negative when the probe genuinely answered", () => {
    // A successful probe reporting nothing IS a fact, and must be stated.
    const s = resolveStagingViewState({
      environmentReady: false,
      targetAttached: false,
      stagingEnabled: true
    });
    expect(s.configured).toBe(false);
    expect(s.unknown).toBe(false);
    expect(s.title).toBe("Staging Not Configured");
    expect(s.hideControls).toBe(true);
  });

  it("distinguishes 'not enabled' from 'enabled but missing'", () => {
    // Different next steps: turn it on, versus find out why provisioning failed.
    const off = resolveStagingViewState({
      environmentReady: false,
      targetAttached: false,
      stagingEnabled: false
    });
    expect(off.detail).toContain("not enabled");
    expect(off.detail).not.toContain("provision it in your infrastructure panel");
  });

  it("treats a half-detected environment as not configured, not as ready", () => {
    const s = resolveStagingViewState({ ...ready, targetAttached: false });
    expect(s.configured).toBe(false);
  });
});
