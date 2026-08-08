import { describe, expect, it } from "vitest";
import { buildBackupSlackMessage, resolveSlackWebhooks } from "./backup-slack";

describe("buildBackupSlackMessage", () => {
  it("reports a failed scheduled backup in red, with the last good restore point", () => {
    const m = buildBackupSlackMessage({
      kind: "backup_failed",
      siteName: "Fucarino.com",
      error: "fail_restic",
      lastSuccessAt: new Date("2026-08-05T12:13:00Z")
    });
    expect(m.color).toBe("#d7263d");
    expect(m.title).toContain("Fucarino.com");
    // "Am I exposed right now?" is the question this answers.
    expect(m.fields.find((f) => f.title === "Last successful backup")?.value).toContain("2026-08-05");
  });

  it("says 'never' when there has never been a successful backup", () => {
    const m = buildBackupSlackMessage({ kind: "backup_failed", siteName: "x", lastSuccessAt: null });
    expect(m.fields.find((f) => f.title === "Last successful backup")?.value).toBe("never");
  });

  it("uses amber for an empty capture, not red", () => {
    // Nothing is broken — the backup ran correctly and found nothing. Red here
    // would train people to ignore the colour that means a real failure.
    const m = buildBackupSlackMessage({ kind: "backup_empty", siteName: "x", detail: "no tables" });
    expect(m.color).toBe("#f5a623");
    expect(m.title).toContain("captured nothing");
  });

  it("states plainly that a rehearsal failure means the backup will not restore", () => {
    const m = buildBackupSlackMessage({ kind: "rehearsal_failed", siteName: "x", reason: "restored_empty" });
    expect(m.color).toBe("#d7263d");
    expect(m.text).toContain("would not restore");
  });

  it("omits fields with no value rather than showing empty rows", () => {
    const m = buildBackupSlackMessage({ kind: "backup_empty", siteName: "x" });
    expect(m.fields.every((f) => f.value.trim().length > 0)).toBe(true);
  });
});

describe("resolveSlackWebhooks", () => {
  const ok = "https://hooks.slack.com/services/T000/B000/xxx";

  it("accepts a platform webhook", () => {
    expect(resolveSlackWebhooks({ platformWebhook: ok })).toEqual([ok]);
  });

  it("combines platform and per-org webhooks", () => {
    const other = "https://hooks.slack.com/services/T111/B111/yyy";
    expect(resolveSlackWebhooks({ platformWebhook: ok, orgWebhooks: [other] })).toEqual([ok, other]);
  });

  it("deduplicates", () => {
    expect(resolveSlackWebhooks({ platformWebhook: ok, orgWebhooks: [ok] })).toEqual([ok]);
  });

  // A misconfigured value must not cause backup outcomes to be POSTed to an
  // arbitrary host.
  it("rejects anything that is not a Slack webhook", () => {
    expect(resolveSlackWebhooks({ platformWebhook: "https://evil.example.com/hook" })).toEqual([]);
    expect(resolveSlackWebhooks({ platformWebhook: "http://hooks.slack.com/services/x" })).toEqual([]);
    expect(resolveSlackWebhooks({ platformWebhook: "not a url" })).toEqual([]);
  });

  it("ignores empty and missing entries", () => {
    expect(resolveSlackWebhooks({ platformWebhook: null, orgWebhooks: [undefined, "  "] })).toEqual([]);
  });
});
