import { afterEach, describe, expect, it, vi } from "vitest";
import { isDirectLocalRequest, opsTokenOriginAllowed } from "./ops-request";
import { localAppUrl, stagingSyncAutomationUrl } from "./local-app-url";
// @ts-expect-error plain .mjs module without types
import { parseKnownHosts, pinSshHostKey } from "../../../../scripts/ssh-host-key.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const h = (values: Record<string, string>) => new Headers(values);

describe("machine tokens only from inside the container", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("accepts direct local calls", () => {
    expect(isDirectLocalRequest(h({ host: "127.0.0.1:3000" }))).toBe(true);
    expect(isDirectLocalRequest(h({ host: "localhost:3000", "x-forwarded-for": "127.0.0.1" }))).toBe(true);
    expect(isDirectLocalRequest(h({ host: "[::1]:3000", "x-forwarded-for": "::1" }))).toBe(true);
    expect(isDirectLocalRequest(h({ host: "127.0.0.1:3000", "x-forwarded-for": "::ffff:127.0.0.1" }))).toBe(true);
  });

  it("refuses anything that came through the proxy or names the public host", () => {
    expect(isDirectLocalRequest(h({ host: "jongo.app" }))).toBe(false);
    expect(isDirectLocalRequest(h({ host: "127.0.0.1:3000", "x-real-ip": "203.0.113.9" }))).toBe(false);
    expect(isDirectLocalRequest(h({ host: "127.0.0.1:3000", "x-forwarded-for": "203.0.113.9, 127.0.0.1" }))).toBe(false);
    expect(isDirectLocalRequest(h({ host: "127.0.0.1:3000", forwarded: "for=203.0.113.9" }))).toBe(false);
    expect(isDirectLocalRequest(h({ host: "10.0.1.5:3000" }))).toBe(false);
    expect(isDirectLocalRequest(h({}))).toBe(false);
  });

  it("allows remote use only when explicitly switched on", () => {
    const remote = h({ host: "jongo.app", "x-real-ip": "203.0.113.9" });
    expect(opsTokenOriginAllowed(remote, {})).toBe(false);
    expect(opsTokenOriginAllowed(remote, { OPS_TOKEN_ALLOW_REMOTE: "yes" })).toBe(false);
    expect(opsTokenOriginAllowed(remote, { OPS_TOKEN_ALLOW_REMOTE: "true" })).toBe(true);
  });

  it("calls this app's own staging sync endpoint locally, whatever address was configured", () => {
    vi.stubEnv("PORT", "3000");
    vi.stubEnv("STAGING_SYNC_AUTOMATION_URL", "https://jongo.manifest-fts.com/api/ops/staging-sync-automation");
    expect(stagingSyncAutomationUrl()).toBe("http://127.0.0.1:3000/api/ops/staging-sync-automation");
    vi.stubEnv("STAGING_SYNC_AUTOMATION_URL", "https://sync.example.test/run");
    expect(stagingSyncAutomationUrl()).toBe("https://sync.example.test/run");
    expect(localAppUrl("api/x")).toBe("http://127.0.0.1:3000/api/x");
  });
});

describe("SSH host key pinning", () => {
  const LINE = "203.0.113.5 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";

  it("pins valid ssh-keyscan output for every SSH caller", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pin-"));
    const env: Record<string, string> = { STAGING_SYNC_SSH_HOST: "203.0.113.5", STAGING_SYNC_SSH_KNOWN_HOSTS: `# scanned\n${LINE}\\n` };
    const out = pinSshHostKey(env, { dir });
    expect(out).toMatchObject({ status: "pinned", lines: 1 });
    expect(env.STAGING_SYNC_SSH_STRICT_HOST_KEY_CHECKING).toBe("yes");
    expect(fs.readFileSync(env.STAGING_SYNC_SSH_USER_KNOWN_HOSTS_FILE, "utf8")).toBe(`${LINE}\n`);
  });

  it("ignores malformed input and leaves settings alone", () => {
    const env: Record<string, string> = { STAGING_SYNC_SSH_KNOWN_HOSTS: "not a key" };
    expect(pinSshHostKey(env).status).toBe("invalid");
    expect(env.STAGING_SYNC_SSH_STRICT_HOST_KEY_CHECKING).toBeUndefined();
    expect(parseKnownHosts(`${LINE}\nrm -rf /`).bad).toBe("rm -rf /");
  });

  it("reports when SSH is configured but not pinned", () => {
    expect(pinSshHostKey({ STAGING_SYNC_SSH_HOST: "h" })).toEqual({ status: "missing", sshConfigured: true });
  });
});
