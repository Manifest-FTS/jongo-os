import { describe, expect, it } from "vitest";
import {
  URL_REWRITE_PHP,
  buildReplacementPairs,
  parseRewriteReport,
  parseSiteUrl,
  summarizeRewriteReport
} from "./wp-url-rewrite";

/** Applies the pairs in order, the way the PHP walk does. */
function applyPairs(input: string, from: string, to: string): string {
  return buildReplacementPairs(from, to).reduce(
    (text, pair) => text.split(pair.from).join(pair.to),
    input
  );
}

describe("parseSiteUrl", () => {
  it("accepts a bare host or a full URL", () => {
    expect(parseSiteUrl("example.com")).toEqual({ scheme: "https", host: "example.com" });
    expect(parseSiteUrl("http://example.com/")).toEqual({ scheme: "http", host: "example.com" });
  });

  it("normalises case and strips trailing slashes", () => {
    expect(parseSiteUrl("HTTPS://Example.COM///")).toEqual({ scheme: "https", host: "example.com" });
  });

  it("keeps a non-standard port, which appears in content", () => {
    // Dropping it would rewrite every URL to an unreachable host.
    expect(parseSiteUrl("http://localhost:8080")).toEqual({ scheme: "http", host: "localhost:8080" });
  });

  it("rejects junk rather than inventing a host", () => {
    for (const value of ["", "   ", "https://"]) {
      expect(parseSiteUrl(value)).toBeNull();
    }
  });
});

describe("buildReplacementPairs", () => {
  it("returns nothing when the URL has not changed", () => {
    expect(buildReplacementPairs("https://a.com", "https://a.com/")).toEqual([]);
  });

  it("replaces the bare host so every spelling is covered at once", () => {
    expect(buildReplacementPairs("https://old.com", "https://new.com")).toEqual([
      { from: "old.com", to: "new.com" }
    ]);
  });

  it("rewrites the plain, escaped and protocol-relative forms with one pair", () => {
    // The escaped form is the one a naive `https://old` replace misses, and it is
    // where page builders keep their JSON.
    const before = [
      'src="https://gsequality.wpengine.com/logo.png"',
      '"url":"https:\\/\\/gsequality.wpengine.com\\/logo.png"',
      'src="//gsequality.wpengine.com/logo.png"'
    ].join(" | ");

    const after = applyPairs(before, "https://gsequality.wpengine.com", "https://stage.newgse.mfts.link");

    expect(after).not.toContain("gsequality.wpengine.com");
    expect(after).toContain('src="https://stage.newgse.mfts.link/logo.png"');
    expect(after).toContain('"url":"https:\\/\\/stage.newgse.mfts.link\\/logo.png"');
    expect(after).toContain('src="//stage.newgse.mfts.link/logo.png"');
  });

  it("upgrades the scheme after the host, including the escaped spelling", () => {
    const pairs = buildReplacementPairs("http://old.com", "https://new.com");
    expect(pairs[0]).toEqual({ from: "old.com", to: "new.com" });
    // Applied second, so it matches text the host swap has already rewritten.
    expect(pairs).toContainEqual({ from: "http://new.com", to: "https://new.com" });
    expect(pairs).toContainEqual({ from: "http:\\/\\/new.com", to: "https:\\/\\/new.com" });

    const after = applyPairs('a="http://old.com/x" b="http:\\/\\/old.com\\/x"', "http://old.com", "https://new.com");
    expect(after).toBe('a="https://new.com/x" b="https:\\/\\/new.com\\/x"');
  });

  it("handles a scheme upgrade on the same host", () => {
    const after = applyPairs('"http://same.com/a"', "http://same.com", "https://same.com");
    expect(after).toBe('"https://same.com/a"');
  });

  it("returns nothing when either side is unusable", () => {
    expect(buildReplacementPairs("", "https://new.com")).toEqual([]);
    expect(buildReplacementPairs("https://old.com", "not a url ://")).toEqual([]);
  });
});

describe("URL_REWRITE_PHP", () => {
  it("re-serializes rather than substituting inside serialized text", () => {
    // A byte-length prefix left claiming the old length makes unserialize()
    // return false, and WordPress then treats the whole option as empty.
    expect(URL_REWRITE_PHP).toContain("serialize(jongo_walk(");
  });

  it("uses SHORTINIT so a migrating site's plugins are not booted", () => {
    expect(URL_REWRITE_PHP).toContain("define('SHORTINIT', true)");
  });

  it("reads its replacements from the environment, not from interpolated code", () => {
    expect(URL_REWRITE_PHP).toContain("getenv('JONGO_REWRITE')");
  });

  it("pages on the primary key so an unchangeable row cannot loop forever", () => {
    // An OFFSET window would either skip rows (rewritten ones stop matching) or
    // re-select an unparseable row forever.
    expect(URL_REWRITE_PHP).toContain("$lastPk");
    expect(URL_REWRITE_PHP).toContain('AND {$pk} > ');
    expect(URL_REWRITE_PHP).not.toMatch(/LIMIT \{\$batch\} OFFSET/);
  });

  it("counts values it refused to touch instead of reporting a clean run", () => {
    expect(URL_REWRITE_PHP).toContain("$skipped++");
  });

  it("covers the tables that actually hold URLs", () => {
    for (const table of ["options", "posts", "postmeta", "termmeta", "comments", "commentmeta", "usermeta"]) {
      expect(URL_REWRITE_PHP).toContain(`$wpdb->${table}`);
    }
    expect(URL_REWRITE_PHP).toContain("guid");
  });
});

describe("parseRewriteReport", () => {
  it("parses a dry-run report", () => {
    const report = parseRewriteReport(
      JSON.stringify({
        ok: true,
        dryRun: true,
        rowsChanged: 77,
        skippedUnserializable: 0,
        tables: [{ table: "wp_posts", column: "guid", rowsChanged: 75 }]
      })
    );
    expect(report.ok).toBe(true);
    expect(report.dryRun).toBe(true);
    expect(report.rowsChanged).toBe(77);
    expect(report.tables[0]).toEqual({ table: "wp_posts", column: "guid", rowsChanged: 75 });
  });

  it("surfaces a reported failure", () => {
    const report = parseRewriteReport(JSON.stringify({ ok: false, error: "wpdb unavailable under SHORTINIT" }));
    expect(report.ok).toBe(false);
    expect(report.error).toContain("wpdb unavailable");
  });

  it("does not report success for unreadable output", () => {
    for (const raw of ["", "ssh: connection refused", "{broken"]) {
      expect(parseRewriteReport(raw).ok).toBe(false);
    }
  });
});

describe("summarizeRewriteReport", () => {
  it("distinguishes a dry run from a completed rewrite", () => {
    const base = { ok: true as const, error: null, tables: [], rowsChanged: 5, skippedUnserializable: 0 };
    expect(summarizeRewriteReport({ ...base, dryRun: true })).toContain("would change 5 rows");
    expect(summarizeRewriteReport({ ...base, dryRun: false })).toContain("changed 5 rows");
  });

  it("always mentions values it could not rewrite", () => {
    // Those rows still hold the old URL; a silent summary is how it stays broken.
    const summary = summarizeRewriteReport({
      ok: true,
      dryRun: false,
      error: null,
      tables: [],
      rowsChanged: 3,
      skippedUnserializable: 2
    });
    expect(summary).toContain("2 unparseable serialized value(s) left untouched");
  });
});
