import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Nobody should have to open Coolify (or fix something "by hand" elsewhere) to
 * finish a task in Jongo. This scans user-facing copy - string literals that
 * read as sentences, and JSX text - and fails when one sends people there.
 * Log lines, comments and identifiers (coolifyServiceUuid, COOLIFY_API_TOKEN,
 * reason codes like "coolify_unreachable") are ignored.
 */
const SRC = join(__dirname, "..");
/**
 * Instructions, not mentions: naming Coolify where an admin links a Coolify
 * project is fine; telling anyone to go there (or to fix something "by hand")
 * is what this forbids.
 */
const BANNED = new RegExp(
  [
    String.raw`\b(in|from|via|using|open|check|inside) Coolify\b`,
    String.raw`\bCoolify (dashboard|UI|panel|console|tab)\b`,
    String.raw`\bStaging tab in\b`,
    String.raw`infrastructure panel`,
    String.raw`\b(manually|by hand) in\b`,
    String.raw`\b(delete|remove|provision|set|create|restart|start|deploy|finish|resolve|refund|check|clone|attach)\b[^.]{0,40}\b(manually|by hand)\b`
  ].join("|"),
  "i"
);

/** Admin-only facts that name where an app lives; they ask nobody to go there. */
const ALLOWED: Array<{ file: string; text: RegExp }> = [
  { file: "app/(platform)/usage/page.tsx", text: /in Coolify, no Jongo app/ },
  { file: "app/(platform)/sites/[siteId]/usage/page.tsx", text: /only known to Coolify so far/ },
  { file: "components/UnmappedCoolifyProjectsBanner.tsx", text: /exist in Coolify but have no Jongo client yet/ },
  // Keyword matcher that rewrites old server messages into plain copy.
  { file: "lib/staging-client-copy.ts", text: /^"infrastructure panel"$/ }
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === "node_modules" || name === "worker") continue;
      walk(path, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

const LITERAL = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g;

export function findBannedCopy(source: string, file: string): string[] {
  file = file.replace(/\\/g, "/");
  const hits: string[] = [];
  let inBlockComment = false;
  source.split("\n").forEach((raw, index) => {
    const line = raw.trim();
    if (inBlockComment) {
      if (line.includes("*/")) inBlockComment = false;
      return;
    }
    if (line.startsWith("/*") && !line.includes("*/")) {
      inBlockComment = true;
      return;
    }
    if (line.startsWith("//") || line.startsWith("*") || line.startsWith("/*") || line.startsWith("{/*")) return;
    if (/console\.(log|error|warn|info|debug)\(/.test(line)) return;

    const literals = line.match(LITERAL) ?? [];
    const sentences = literals.filter((literal) => /\s/.test(literal) && BANNED.test(literal));
    // JSX text sits outside quotes: check what is left once literals and a
    // trailing comment are removed.
    const rest = file.endsWith(".tsx") ? line.replace(LITERAL, "").replace(/\s\/\/.*$/, "") : "";
    const jsxText = BANNED.test(rest) ? [rest] : [];

    for (const hit of [...sentences, ...jsxText]) {
      if (ALLOWED.some((allowed) => file === allowed.file && allowed.text.test(hit))) continue;
      hits.push(`${file}:${index + 1}: ${hit.slice(0, 160)}`);
    }
  });
  return hits;
}

describe("user-facing copy never sends people to Coolify", () => {
  it("normalizes Windows paths without widening approved copy exceptions", () => {
    expect(findBannedCopy('const label = "in Coolify, no Jongo app";', 'app\\(platform)\\usage\\page.tsx')).toEqual([]);
    expect(findBannedCopy('const label = "Open Coolify dashboard";', 'app\\(platform)\\usage\\page.tsx')).toHaveLength(1);
  });
  it("flags the patterns it is meant to catch", () => {
    expect(findBannedCopy(`const m = "Restart it from Coolify if needed.";`, "x.ts")).toHaveLength(1);
    expect(findBannedCopy(`setError("Remove staging resources manually in the infrastructure panel.");`, "x.ts")).toHaveLength(1);
    expect(findBannedCopy(`  <span>Check the Staging tab in Coolify and refresh.</span>`, "x.tsx")).toHaveLength(1);
  });

  it("ignores identifiers, codes, comments and logs", () => {
    expect(findBannedCopy(`select: { coolifyServiceUuid: true }`, "x.ts")).toEqual([]);
    expect(findBannedCopy(`reason: "coolify_unreachable"`, "x.ts")).toEqual([]);
    expect(findBannedCopy(`// restart it from Coolify`, "x.ts")).toEqual([]);
    expect(findBannedCopy(`console.error("[jongo] Coolify said no", error);`, "x.ts")).toEqual([]);
    expect(findBannedCopy(`import type { CoolifyAppPickerOption } from "@/lib/coolify-app-picker";`, "x.tsx")).toEqual([]);
  });

  it("finds none in app/, components/ and lib/", () => {
    const hits = walk(SRC).flatMap((path) => findBannedCopy(readFileSync(path, "utf8"), relative(SRC, path)));
    expect(hits).toEqual([]);
  });
});
