import { describe, expect, it, vi } from "vitest";
import {
  buildInstallInput,
  buildInstallScript,
  defaultAdminUser,
  installWordPressWhenReady,
  parseInstallOutput
} from "./wordpress-install";

const base = { url: "https://acme.mfts.link", siteName: "acme", fallbackEmail: "Owner@Example.test" };

describe("WordPress setup input", () => {
  it("fills sensible defaults when nothing is typed", () => {
    const result = buildInstallInput(base);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config).toEqual({ url: "https://acme.mfts.link", title: "acme", adminUser: "owner", adminEmail: "owner@example.test" });
    expect(result.generatedPassword).toBe(true);
    expect(result.password.length).toBe(20);
  });

  it("never defaults to the username admin", () => {
    expect(defaultAdminUser("admin@example.test")).toBe("siteowner");
    expect(defaultAdminUser("jo@example.test")).toBe("siteowner");
    const typed = buildInstallInput({ ...base, adminUser: "Admin" });
    expect(typed.ok ? "" : typed.field).toBe("adminUser");
  });

  it("rejects usernames WordPress would silently change", () => {
    const result = buildInstallInput({ ...base, adminUser: "jo smith" });
    expect(result.ok ? "" : result.field).toBe("adminUser");
  });

  it("rejects short passwords and bad emails, keeps a typed password", () => {
    expect(buildInstallInput({ ...base, adminPassword: "short" }).ok).toBe(false);
    expect(buildInstallInput({ ...base, adminEmail: "nope" }).ok).toBe(false);
    const ok = buildInstallInput({ ...base, adminPassword: "a long enough password" });
    expect(ok.ok && ok.password).toBe("a long enough password");
    expect(ok.ok && ok.generatedPassword).toBe(false);
  });

  it("needs an address", () => {
    const result = buildInstallInput({ ...base, url: null });
    expect(result.ok ? "" : result.field).toBe("url");
  });
});

describe("WordPress setup script", () => {
  it("carries hostile input only as base64, never in shell or PHP source", () => {
    const title = `'; rm -rf / #$(reboot)\`id\` ?>`;
    const script = buildInstallScript({
      resourceUuid: "abc123",
      config: { url: "https://acme.mfts.link", title, adminUser: "owner", adminEmail: "o@example.test" },
      password: "pa'ss\"word$HOME"
    });
    expect(script).not.toContain("rm -rf");
    expect(script).not.toContain("pa'ss");
    expect(script).toContain("<<'JONGOPHPEOF'");
    const payload = /\$JONGO_PAYLOAD = '([A-Za-z0-9+/=]+)';/.exec(script)?.[1];
    expect(payload).toBeTruthy();
    const decoded = JSON.parse(Buffer.from(payload!, "base64").toString("utf8"));
    expect(decoded).toMatchObject({ title, password: "pa'ss\"word$HOME", user: "owner" });
  });

  it("reads the last report line", () => {
    expect(parseInstallOutput('noise\nJONGO_INSTALL={"status":"installed"}\n')).toEqual({ status: "installed" });
    expect(parseInstallOutput('<html>db error</html>\nJONGO_INSTALL={"status":"waiting","error":"wordpress_not_ready"}')).toEqual({
      status: "waiting",
      reason: "wordpress_not_ready"
    });
    expect(parseInstallOutput('JONGO_INSTALL={"status":"failed","error":"install_failed"}').status).toBe("failed");
    expect(parseInstallOutput("").status).toBe("waiting");
  });
});

describe("waiting for the site to start", () => {
  const input = { resourceUuid: "abc", config: { url: "https://a.test", title: "a", adminUser: "owner", adminEmail: "o@a.test" }, password: "x".repeat(20) };

  it("retries while the site is starting, then stops on success", async () => {
    const attempt = vi
      .fn()
      .mockResolvedValueOnce({ status: "waiting", reason: "no_wordpress_container" })
      .mockResolvedValueOnce({ status: "waiting", reason: "wordpress_not_ready" })
      .mockResolvedValueOnce({ status: "installed" });
    expect(await installWordPressWhenReady(input, { attempt, intervalMs: 1, deadlineMs: 5000 })).toEqual({ status: "installed" });
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it("gives up at the deadline and does not retry a real failure", async () => {
    const waiting = vi.fn().mockResolvedValue({ status: "waiting", reason: "files_not_ready" });
    expect((await installWordPressWhenReady(input, { attempt: waiting, intervalMs: 5, deadlineMs: 30 })).status).toBe("waiting");
    const failing = vi.fn().mockResolvedValue({ status: "failed", reason: "install_failed" });
    await installWordPressWhenReady(input, { attempt: failing, intervalMs: 1, deadlineMs: 5000 });
    expect(failing).toHaveBeenCalledTimes(1);
  });
});
