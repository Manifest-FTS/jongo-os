import { describe, expect, it } from "vitest";
import {
  buildBackupEventEmail,
  collectSiteRecipients,
  isBackupEventNotified,
  shouldNotifyBackupFailure,
  BACKUP_FAILURE_COOLDOWN_HOURS,
  type SiteEvent
} from "./site-notify";

const at = new Date("2026-08-09T03:14:00Z");

describe("collectSiteRecipients", () => {
  it("includes the owner, org collaborators and app collaborators", () => {
    const r = collectSiteRecipients({
      ownerEmail: "owner@example.com",
      organizationCollaboratorEmails: ["orgadmin@example.com"],
      collaboratorEmails: ["dev@example.com"]
    });
    expect(r).toEqual(["owner@example.com", "orgadmin@example.com", "dev@example.com"]);
  });

  it("deduplicates the same person case-insensitively", () => {
    // The owner is very often also a collaborator; they must not be mailed twice.
    const r = collectSiteRecipients({
      ownerEmail: "Owner@Example.com",
      organizationCollaboratorEmails: ["owner@example.com"],
      collaboratorEmails: ["OWNER@EXAMPLE.COM", "dev@example.com"]
    });
    expect(r).toEqual(["Owner@Example.com", "dev@example.com"]);
  });

  it("drops empty, null and malformed addresses", () => {
    const r = collectSiteRecipients({
      ownerEmail: null,
      organizationCollaboratorEmails: ["", "   ", undefined, "not-an-email"],
      collaboratorEmails: ["ok@example.com"]
    });
    expect(r).toEqual(["ok@example.com"]);
  });

  it("returns an empty list when nobody is reachable", () => {
    expect(collectSiteRecipients({})).toEqual([]);
  });
});

describe("isBackupEventNotified", () => {
  it("mails the decisions a human made and the failure that costs a restore point", () => {
    for (const event of ["staging_created", "staging_synced_to_production", "backup_failed"] as SiteEvent[]) {
      expect(isBackupEventNotified(event)).toBe(true);
    }
  });

  it("stays quiet about routine backup traffic", () => {
    // A nightly success mail per app is ~1,500/month across the fleet and gets
    // the sender filtered, taking the failure alert with it.
    for (const event of ["backup_started", "backup_succeeded"] as SiteEvent[]) {
      expect(isBackupEventNotified(event)).toBe(false);
    }
  });

  it("does not mail a schedule toggle the person already made", () => {
    for (const event of ["schedule_enabled", "schedule_disabled"] as SiteEvent[]) {
      expect(isBackupEventNotified(event)).toBe(false);
    }
  });
});

describe("shouldNotifyBackupFailure", () => {
  const now = new Date("2026-08-10T12:00:00Z");
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);

  it("always sends the first failure after a healthy run", () => {
    expect(shouldNotifyBackupFailure({ lastAlertAt: null, now })).toEqual({
      notify: true,
      reason: "first_failure"
    });
  });

  it("suppresses a repeat inside the window", () => {
    // A site broken for a week must not email every night.
    expect(shouldNotifyBackupFailure({ lastAlertAt: hoursAgo(3), now }).notify).toBe(false);
  });

  it("sends again once the cooldown has elapsed", () => {
    const decision = shouldNotifyBackupFailure({ lastAlertAt: hoursAgo(BACKUP_FAILURE_COOLDOWN_HOURS + 1), now });
    expect(decision).toEqual({ notify: true, reason: "cooldown_elapsed" });
  });

  it("treats an unparseable stamp as never alerted rather than silently muting", () => {
    expect(shouldNotifyBackupFailure({ lastAlertAt: "not a date", now }).notify).toBe(true);
  });
});

describe("buildBackupEventEmail", () => {
  const base = { siteName: "Acme Dental", siteUrl: "https://jongo.example/apps/acme/backups", at };

  it("names the site and links the backups tab on every event", () => {
    const events: SiteEvent[] = [
      "backup_started",
      "backup_succeeded",
      "backup_failed",
      "schedule_enabled",
      "schedule_disabled",
      "staging_created",
      "staging_synced_to_production"
    ];
    for (const event of events) {
      const m = buildBackupEventEmail({ ...base, event });
      expect(m.subject).toContain("Acme Dental");
      expect(m.text).toContain(base.siteUrl);
    }
  });

  it("distinguishes a promote-triggered backup from a scheduled one", () => {
    // The reader needs to know why a backup they did not schedule appeared.
    expect(buildBackupEventEmail({ ...base, event: "backup_started", trigger: "promote" }).text)
      .toContain("before a promotion to production");
    expect(buildBackupEventEmail({ ...base, event: "backup_started", trigger: "scheduled" }).text)
      .toContain("automatic scheduled backup");
  });

  it("reports a human-readable size on success", () => {
    const m = buildBackupEventEmail({ ...base, event: "backup_succeeded", sizeBytes: 5 * 1024 * 1024 });
    expect(m.text).toContain("5.0 MB");
  });

  it("says size was not reported rather than inventing a zero", () => {
    const m = buildBackupEventEmail({ ...base, event: "backup_succeeded", sizeBytes: null });
    expect(m.text).toMatch(/Size: not reported/i);
    expect(m.text).not.toContain("Size: 0");
  });

  it("tells a failure reader what they can still restore", () => {
    const m = buildBackupEventEmail({
      ...base,
      event: "backup_failed",
      error: "ssh timeout",
      lastSuccessAt: new Date("2026-08-08T03:12:00Z")
    });
    expect(m.text).toContain("ssh timeout");
    expect(m.text).toContain("2026-08-08 03:12 UTC");
    expect(m.text).toMatch(/you can still restore/i);
  });

  it("states plainly when a failure leaves no restore point at all", () => {
    const m = buildBackupEventEmail({ ...base, event: "backup_failed", lastSuccessAt: null });
    expect(m.text).toMatch(/no restore point/i);
    expect(m.text).toContain("nothing can be restored right now");
  });

  it("ignores an unparseable last-success timestamp rather than printing garbage", () => {
    const m = buildBackupEventEmail({ ...base, event: "backup_failed", lastSuccessAt: "not a date" });
    expect(m.text).toMatch(/no restore point/i);
    expect(m.text).not.toContain("Invalid Date");
    expect(m.text).not.toContain("NaN");
  });

  it("names the frequency when the schedule is turned on", () => {
    const m = buildBackupEventEmail({ ...base, event: "schedule_enabled", frequencyLabel: "Daily" });
    expect(m.subject).toContain("turned on");
    expect(m.text).toContain("Frequency: Daily");
  });

  it("warns that no new restore points will be made when turned off", () => {
    const m = buildBackupEventEmail({ ...base, event: "schedule_disabled" });
    expect(m.subject).toContain("turned off");
    expect(m.text).toContain("No new restore points");
  });
});

describe("buildBackupEventEmail — HTML part", () => {
  const base = { siteName: "Acme Dental", siteUrl: "https://jongo.example/apps/acme/backups", at };
  const events: SiteEvent[] = [
    "backup_started",
    "backup_succeeded",
    "backup_failed",
    "schedule_enabled",
    "schedule_disabled",
    "staging_created",
    "staging_synced_to_production"
  ];

  it("sends a complete document with a preheader and the brand header", () => {
    for (const event of events) {
      const { html } = buildBackupEventEmail({ ...base, event });
      expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
      expect(html).toContain("Manifest FTS");
      expect(html).toContain("Jongo");
      // Hidden inbox-preview line; without it the client previews raw markup text.
      expect(html).toContain("mso-hide:all");
    }
  });

  it("builds the layout from tables, not flex or grid", () => {
    // Outlook renders through Word and drops both, collapsing the design.
    const { html } = buildBackupEventEmail({ ...base, event: "backup_succeeded" });
    expect(html).toContain('role="presentation"');
    expect(html).not.toContain("display:flex");
    expect(html).not.toContain("display:grid");
  });

  it("links the CTA and repeats the URL as text for clients that strip buttons", () => {
    const { html } = buildBackupEventEmail({ ...base, event: "backup_succeeded" });
    expect(html).toContain(`href="${base.siteUrl}"`);
    expect(html).toContain("View backups");
    expect(html).toContain("Or open this link:");
  });

  it("carries no remote images, which most clients block by default", () => {
    for (const event of events) {
      expect(buildBackupEventEmail({ ...base, event }).html).not.toMatch(/<img/i);
    }
  });

  it("tones the badge to the outcome", () => {
    expect(buildBackupEventEmail({ ...base, event: "backup_succeeded" }).html).toContain("Backup completed");
    expect(buildBackupEventEmail({ ...base, event: "backup_failed" }).html).toContain("Backup failed");
    // Failure uses the danger red; success must not.
    expect(buildBackupEventEmail({ ...base, event: "backup_failed" }).html).toContain("#b3261e");
    expect(buildBackupEventEmail({ ...base, event: "backup_succeeded" }).html).not.toContain("#b3261e");
  });

  it("escapes site names and failure reasons rather than injecting them", () => {
    const { html } = buildBackupEventEmail({
      ...base,
      siteName: 'Bob & Co <script>alert("x")</script>',
      event: "backup_failed",
      error: 'exit 1 <b>"broken"</b>'
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("Bob &amp; Co");
    expect(html).toContain("&lt;b&gt;");
  });

  it("refuses a non-http CTA target instead of rendering it as a button", () => {
    // The base URL comes from configuration, so a junk value must not become a link.
    const { html } = buildBackupEventEmail({
      ...base,
      siteUrl: "javascript:alert(1)",
      event: "backup_succeeded"
    });
    expect(html).not.toContain("javascript:alert(1)");
    expect(html).not.toContain("View backups");
  });

  it("still includes the plain-text alternative for every event", () => {
    for (const event of events) {
      const { text } = buildBackupEventEmail({ ...base, event });
      expect(text).toContain("Acme Dental");
      expect(text).toContain(base.siteUrl);
      expect(text).not.toContain("<");
    }
  });
});

describe("staging event copy", () => {
  const base = { siteName: "Acme Dental", siteUrl: "https://jongo.example/apps/acme/backups", at };

  it("names both addresses when staging is created", () => {
    const m = buildBackupEventEmail({
      ...base,
      event: "staging_created",
      stagingUrl: "https://stage.acme.mfts.link",
      productionUrl: "https://acme.mfts.link",
      contentSynced: true
    });
    expect(m.subject).toContain("Staging site created");
    expect(m.text).toContain("https://stage.acme.mfts.link");
    expect(m.text).toContain("https://acme.mfts.link");
  });

  it("warns when staging was created without production content", () => {
    // Testing against a fresh install instead of the live site is worse than useless.
    const m = buildBackupEventEmail({ ...base, event: "staging_created", contentSynced: false });
    expect(m.text).toContain("Not yet");
    expect(m.text).toMatch(/content sync/i);
  });

  it("says a promotion changed the live site and points at the backup", () => {
    const m = buildBackupEventEmail({
      ...base,
      event: "staging_synced_to_production",
      productionUrl: "https://acme.mfts.link",
      urlRowsRewritten: 77,
      deploymentId: "dep-123"
    });
    expect(m.subject).toContain("promoted to production");
    expect(m.text).toContain("77 rows");
    expect(m.text).toContain("dep-123");
    expect(m.text).toMatch(/changed the live site/i);
  });
});
