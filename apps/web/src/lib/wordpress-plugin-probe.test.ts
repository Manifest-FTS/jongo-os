import { describe, expect, it } from "vitest";
import {
  PLUGIN_PROBE_PHP,
  UPDATE_AVAILABLE_LABEL,
  UP_TO_DATE_LABEL,
  UPDATE_DATA_STALE_AFTER_HOURS,
  buildPluginProbeScript,
  describeUpdateDataFreshness,
  parsePluginProbeOutput,
  readProbeTransport,
  toPluginInventory,
  type ProbedPlugin
} from "./wordpress-plugin-probe";

function plugin(overrides: Partial<ProbedPlugin> = {}): ProbedPlugin {
  return {
    file: "akismet/akismet.php",
    name: "Akismet",
    version: "5.7",
    active: true,
    updateAvailable: false,
    newVersion: null,
    ...overrides
  };
}

describe("PLUGIN_PROBE_PHP", () => {
  it("uses SHORTINIT so a broken plugin cannot hide the inventory", () => {
    // A live site fataled on mapsvg when WordPress was booted normally; the
    // inventory would have been hidden by the bug it exists to reveal.
    expect(PLUGIN_PROBE_PHP).toContain("define('SHORTINIT', true)");
  });

  it("never calls get_plugins, which needs a booted WordPress", () => {
    expect(PLUGIN_PROBE_PHP).not.toContain("get_plugins(");
  });

  it("only reads — no writes to the site", () => {
    expect(PLUGIN_PROBE_PHP).not.toMatch(/\b(UPDATE|INSERT|DELETE|DROP|ALTER)\s/i);
  });

  it("carries the update transient's last_checked so staleness is visible", () => {
    expect(PLUGIN_PROBE_PHP).toContain("last_checked");
  });
});

describe("buildPluginProbeScript", () => {
  it("matches the uuid as a whole segment, not a prefix", () => {
    // Coolify names service containers <app>-<uuid>; anchoring at the start
    // would miss every one of them.
    const script = buildPluginProbeScript("abc123");
    expect(script).toContain('grep -E "(^|-)$RUUID($|-)"');
  });

  it("yields to a deploy in progress", () => {
    expect(buildPluginProbeScript("abc123")).toContain("coolify-helper");
  });

  it("quotes the uuid so a hostile value cannot break out of the shell", () => {
    const script = buildPluginProbeScript("abc'; rm -rf /; echo '");
    expect(script).toContain(`RUUID='abc'\\''; rm -rf /; echo '\\'''`);
    expect(script).not.toMatch(/RUUID=abc';\s*rm -rf/);
  });

  it("pipes the PHP over stdin via a quoted heredoc rather than nested quoting", () => {
    const script = buildPluginProbeScript("abc123");
    expect(script).toContain("docker exec -i \"$WP_CONTAINER\" php <<'JONGOPHPEOF'");
    expect(script).toContain(PLUGIN_PROBE_PHP);
  });
});

describe("readProbeTransport", () => {
  it("separates a deferral from a failure", () => {
    // A busy host must not be recorded as a broken app.
    expect(readProbeTransport("JONGO_RESULT=deferred_deploy_in_progress\n")).toEqual({ kind: "deferred" });
  });

  it("reports the two container-shaped outcomes distinctly", () => {
    expect(readProbeTransport("JONGO_RESULT=no_containers")).toEqual({ kind: "no_containers" });
    expect(readProbeTransport("JONGO_RESULT=no_wordpress_container")).toEqual({ kind: "no_wordpress_container" });
  });

  it("returns the payload after the marker", () => {
    const out = readProbeTransport('JONGO_RESULT=ok\n{"ok":true,"plugins":[]}');
    expect(out.kind).toBe("json");
    expect(out.kind === "json" && out.raw).toBe('{"ok":true,"plugins":[]}');
  });

  it("treats a missing marker as unusable rather than empty", () => {
    // ssh failing before bash ran must not read as "this site has no plugins".
    const out = readProbeTransport("ssh: connect to host 1.2.3.4 port 22: Connection refused");
    expect(out.kind).toBe("unusable");
  });

  it("treats an ok marker with no payload as unusable", () => {
    expect(readProbeTransport("JONGO_RESULT=ok\n   ").kind).toBe("unusable");
  });
});

describe("parsePluginProbeOutput", () => {
  it("parses a successful read", () => {
    const result = parsePluginProbeOutput(
      JSON.stringify({
        ok: true,
        wpVersion: "7.0.3",
        updateDataCheckedAt: 1786238444,
        plugins: [{ file: "a/a.php", name: "Alpha", version: "1.0", active: true, updateAvailable: true, newVersion: "1.1" }]
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.wpVersion).toBe("7.0.3");
    expect(result.updateDataCheckedAt).toBe(1786238444);
    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0]).toMatchObject({ name: "Alpha", active: true, updateAvailable: true, newVersion: "1.1" });
  });

  it("finds the JSON even when PHP printed a warning first", () => {
    const result = parsePluginProbeOutput('PHP Warning: something\n{"ok":true,"plugins":[]}');
    expect(result.ok).toBe(true);
  });

  it("surfaces a site-level failure the probe reported", () => {
    const result = parsePluginProbeOutput(JSON.stringify({ ok: false, error: "wp-load.php not found under /var/www/html" }));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("wp-load.php not found");
  });

  it("fails loudly on unparseable output instead of returning zero plugins", () => {
    // Returning an empty list here would render as "this site has no plugins".
    for (const raw of ["", "not json at all", "{oops"]) {
      expect(parsePluginProbeOutput(raw).ok).toBe(false);
    }
  });

  it("drops rows with no name rather than rendering a blank table line", () => {
    const result = parsePluginProbeOutput(
      JSON.stringify({ ok: true, plugins: [{ file: "x.php", name: "  " }, { file: "y.php", name: "Yes" }] })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plugins.map((p) => p.name)).toEqual(["Yes"]);
  });

  it("normalises a missing or zero update timestamp to null", () => {
    for (const value of [undefined, 0, -1, "nope"]) {
      const result = parsePluginProbeOutput(JSON.stringify({ ok: true, updateDataCheckedAt: value, plugins: [] }));
      expect(result.ok && result.updateDataCheckedAt).toBeFalsy();
    }
  });
});

describe("toPluginInventory", () => {
  it("uses the exact strings the Plugins page branches on", () => {
    // The page checks `updateStatus === "Update available"` to show the warning
    // badge; a differently-cased variant silently renders as plain text.
    const { rows } = toPluginInventory([plugin({ updateAvailable: true }), plugin({ active: false })]);
    expect(rows[0].updateStatus).toBe(UPDATE_AVAILABLE_LABEL);
    expect(rows[0].status).toBe("Active");
    expect(rows[1].updateStatus).toBe(UP_TO_DATE_LABEL);
    expect(rows[1].status).toBe("Inactive");
  });

  it("counts active, inactive and updates", () => {
    const summary = toPluginInventory([
      plugin({ name: "A", active: true, updateAvailable: true }),
      plugin({ name: "B", active: true }),
      plugin({ name: "C", active: false })
    ]);
    expect(summary.activePlugins).toBe(2);
    expect(summary.inactivePlugins).toBe(1);
    expect(summary.updatesAvailable).toBe(1);
  });

  it("leaves security issues null rather than asserting a clean bill of health", () => {
    // No vulnerability feed is wired up; "None" would claim something unchecked.
    expect(toPluginInventory([plugin()]).rows[0].securityIssues).toBeNull();
  });

  it("handles an empty inventory", () => {
    expect(toPluginInventory([])).toEqual({ rows: [], activePlugins: 0, inactivePlugins: 0, updatesAvailable: 0 });
  });
});

describe("describeUpdateDataFreshness", () => {
  const now = new Date("2026-08-09T12:00:00Z");
  const hoursAgo = (h: number) => Math.floor((now.getTime() - h * 3_600_000) / 1000);

  it("treats a recent check as trustworthy", () => {
    const f = describeUpdateDataFreshness(hoursAgo(3), now);
    expect(f.stale).toBe(false);
    expect(f.ageHours).toBe(3);
  });

  it("flags a check older than the stale window", () => {
    // wp-cron has stopped, so every plugin reads as up to date — reassuring and wrong.
    const f = describeUpdateDataFreshness(hoursAgo(UPDATE_DATA_STALE_AFTER_HOURS + 5), now);
    expect(f.stale).toBe(true);
    expect(f.detail).toContain("wp-cron");
  });

  it("treats a missing timestamp as stale, not as fresh", () => {
    const f = describeUpdateDataFreshness(null, now);
    expect(f.stale).toBe(true);
    expect(f.ageHours).toBeNull();
  });
});
