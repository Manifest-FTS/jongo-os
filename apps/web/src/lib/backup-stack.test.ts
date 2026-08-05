import { describe, expect, it } from "vitest";
import { detectStack, summarizeBackupContent, BACKUP_EXCLUDES } from "./backup-stack";

describe("detectStack", () => {
  it("detects WordPress from the version marker", () => {
    expect(detectStack({ wpVersion: "6.5.2" })).toBe("wordpress");
  });

  it("detects WordPress from the container name when the version probe failed", () => {
    // The version probe runs inside the container and can fail on its own; the
    // container name is still proof of what this is.
    expect(detectStack({ containers: ["wordpress-abc", "mariadb-abc"], wpVersion: null })).toBe("wordpress");
  });

  it("does not mistake a container merely containing 'wordpress' for the app", () => {
    expect(detectStack({ containers: ["my-wordpress-proxy-abc"] })).toBe("service");
  });

  it("detects Next.js", () => {
    expect(detectStack({ nodeFramework: "next" })).toBe("nextjs");
    expect(detectStack({ nodeFramework: "Next.js" })).toBe("nextjs");
  });

  it("detects Nuxt", () => {
    expect(detectStack({ nodeFramework: "nuxt" })).toBe("nuxt");
    expect(detectStack({ nodeFramework: "NuxtJS" })).toBe("nuxt");
  });

  it("classifies an unrecognised framework marker as a generic node app", () => {
    expect(detectStack({ nodeFramework: "sveltekit" })).toBe("node");
  });

  it("prefers the framework over the captured shape", () => {
    // The old rule was pure arithmetic on volumes/databases, so a Next.js app
    // with a database could only ever come out as "service".
    expect(detectStack({ nodeFramework: "next", volumeCount: 0, databaseCount: 1 })).toBe("nextjs");
  });

  it("classifies databases with no file volumes as a database", () => {
    expect(detectStack({ volumeCount: 0, databaseCount: 1 })).toBe("database");
  });

  it("classifies anything else as a service", () => {
    expect(detectStack({ volumeCount: 2, databaseCount: 1 })).toBe("service");
    expect(detectStack({})).toBe("service");
  });

  it("ignores empty and null container entries", () => {
    expect(detectStack({ containers: ["", null as unknown as string] })).toBe("service");
  });
});

describe("summarizeBackupContent", () => {
  it("reports WordPress content metrics", () => {
    const summary = summarizeBackupContent({
      wpVersion: "6.5.2",
      posts: 12,
      pages: 4,
      plugins: 9,
      comments: 30
    });
    expect(summary.stack).toBe("wordpress");
    expect(summary.label).toBe("WordPress");
    expect(summary.metrics.map((m) => m.label)).toEqual(["Posts", "Pages", "Plugins", "Comments", "WP Version"]);
    expect(summary.metrics.find((m) => m.label === "Posts")?.value).toBe(12);
  });

  it("reports framework metrics for a Next.js app", () => {
    const summary = summarizeBackupContent(
      { nodeFramework: "next", appVersion: "1.4.0", volumeCount: 1, databaseCount: 1, databaseTables: 22 },
      { formattedSize: "412 MB" }
    );
    expect(summary.stack).toBe("nextjs");
    expect(summary.label).toBe("Next.js");
    expect(summary.metrics.find((m) => m.label === "Version")?.value).toBe("1.4.0");
    expect(summary.metrics.find((m) => m.label === "Tables")?.value).toBe(22);
    expect(summary.metrics.find((m) => m.label === "Size")?.value).toBe("412 MB");
  });

  it("singularises volume and database labels", () => {
    const one = summarizeBackupContent({ volumeCount: 1, databaseCount: 1, nodeFramework: "next" });
    expect(one.metrics.map((m) => m.label)).toContain("Volume");
    expect(one.metrics.map((m) => m.label)).toContain("Database");

    const many = summarizeBackupContent({ volumeCount: 3, databaseCount: 2, nodeFramework: "next" });
    expect(many.metrics.map((m) => m.label)).toContain("Volumes");
    expect(many.metrics.map((m) => m.label)).toContain("Databases");
  });

  it("reports database metrics for a standalone database", () => {
    const summary = summarizeBackupContent({ volumeCount: 0, databaseCount: 1, databaseTables: 40 });
    expect(summary.stack).toBe("database");
    expect(summary.metrics.map((m) => m.label)).toEqual(["Database", "Tables", "Size"]);
  });

  it("falls back to the generic service shape", () => {
    const summary = summarizeBackupContent({ volumeCount: 2, databaseCount: 0 });
    expect(summary.stack).toBe("service");
    expect(summary.metrics.map((m) => m.label)).toEqual(["Volumes", "Databases", "Size"]);
  });

  it("renders missing values as null rather than zero", () => {
    // A metric that was never measured must not read as a measured zero — that
    // is the same class of lie as reporting an empty backup as healthy.
    const summary = summarizeBackupContent({ wpVersion: "6.5.2" });
    expect(summary.metrics.find((m) => m.label === "Posts")?.value).toBeNull();
    expect(summary.metrics.find((m) => m.label === "WP Version")?.value).toBe("6.5.2");
  });

  it("keeps a measured zero as zero", () => {
    const summary = summarizeBackupContent({ wpVersion: "6.5.2", posts: 0 });
    expect(summary.metrics.find((m) => m.label === "Posts")?.value).toBe(0);
  });

  it("passes a missing size through as null", () => {
    const summary = summarizeBackupContent({ volumeCount: 2 });
    expect(summary.metrics.find((m) => m.label === "Size")?.value).toBeNull();
  });
});

describe("BACKUP_EXCLUDES", () => {
  it("covers the caches of every supported stack", () => {
    // One superset, because excludes must be chosen before restic runs while
    // detection only finishes afterwards.
    expect(BACKUP_EXCLUDES).toContain("**/wp-content/cache");
    expect(BACKUP_EXCLUDES).toContain("**/.next/cache");
    expect(BACKUP_EXCLUDES).toContain("**/.nuxt/cache");
  });

  it("excludes only regenerable output", () => {
    // A rule that removed real data would be silent loss, so nothing here may
    // name a content, upload, or database path.
    for (const pattern of BACKUP_EXCLUDES) {
      expect(pattern).not.toMatch(/uploads|\.sql|_data\b/);
    }
  });
});
