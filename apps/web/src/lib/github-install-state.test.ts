import { describe, expect, it } from "vitest";
import { signInstallState, verifyInstallState } from "./github-install-state";

const secret = "nextauth-secret";
const now = 1_800_000_000_000;

describe("install state", () => {
  it("round-trips org and user", () => {
    const token = signInstallState({ orgId: "org-1", userId: "user-1" }, secret, now);
    expect(verifyInstallState(token, secret, now + 1000)).toEqual({ ok: true, payload: { orgId: "org-1", userId: "user-1" } });
  });
  it("expires after 10 minutes", () => {
    const token = signInstallState({ orgId: "org-1", userId: "user-1" }, secret, now);
    expect(verifyInstallState(token, secret, now + 10 * 60_000 + 1)).toEqual({ ok: false, reason: "expired" });
  });
  it("rejects a payload changed to another org", () => {
    const token = signInstallState({ orgId: "org-1", userId: "user-1" }, secret, now);
    const [, sig] = token.split(".");
    const forged = `${Buffer.from(JSON.stringify({ o: "org-2", u: "user-1", e: now + 600_000 })).toString("base64url")}.${sig}`;
    expect(verifyInstallState(forged, secret, now)).toEqual({ ok: false, reason: "bad_signature" });
  });
  it("rejects another secret and garbage", () => {
    const token = signInstallState({ orgId: "org-1", userId: "user-1" }, secret, now);
    expect(verifyInstallState(token, "other", now)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyInstallState("nonsense", secret, now)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyInstallState("", secret, now)).toEqual({ ok: false, reason: "malformed" });
  });
  it("carries which Git source the flow is for", () => {
    const token = signInstallState({ orgId: "org-1", userId: "user-1", sourceId: "src-1" }, secret, now);
    expect(verifyInstallState(token, secret, now)).toEqual({ ok: true, payload: { orgId: "org-1", userId: "user-1", sourceId: "src-1" } });
  });
});
