#!/usr/bin/env node

/**
 * Repair stale Site -> Coolify resource mappings.
 *
 * The approved ownership sync is INSERT-ONLY: it never updates an existing
 * Site's coolifyServiceUuid. When a Coolify resource is recreated (new UUID),
 * the Site keeps pointing at the dead UUID, so backups/staging/etc. find nothing.
 *
 * This script finds Sites whose coolifyServiceUuid no longer matches a LIVE
 * Coolify resource, and proposes the current UUID by matching name (+ project).
 *
 *   DRY-RUN by default (prints a proposal table, changes nothing).
 *   --apply   actually UPDATE the mappings (only exact, unambiguous matches).
 *
 * Requires (available inside the jongo app container): COOLIFY_API_BASE_URL,
 * COOLIFY_API_TOKEN, DATABASE_URL.
 */

import { PrismaClient } from "@prisma/client";

const APPLY = process.argv.includes("--apply");

function normalize(v) {
  return String(v ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

async function coolifyGet(pathname) {
  const base = (process.env.COOLIFY_API_BASE_URL || "").replace(/\/+$/, "");
  const token = process.env.COOLIFY_API_TOKEN;
  if (!base || !token) throw new Error("COOLIFY_API_BASE_URL / COOLIFY_API_TOKEN required");
  const res = await fetch(`${base}/api/v1${pathname}`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` }
  });
  if (!res.ok) return [];
  return res.json().catch(() => []);
}

function projectIdOf(r) {
  return String(
    r.project_uuid ||
      r.project_id ||
      r?.environment?.project?.uuid ||
      r?.destination?.server?.project_uuid ||
      ""
  );
}

async function buildLiveResources() {
  const [services, applications, databases] = await Promise.all([
    coolifyGet("/services"),
    coolifyGet("/applications"),
    coolifyGet("/databases")
  ]);
  const rows = [];
  for (const [kind, list] of [["service", services], ["application", applications], ["database", databases]]) {
    for (const r of Array.isArray(list) ? list : []) {
      const uuid = String(r.uuid || r.id || "");
      if (!uuid) continue;
      rows.push({ uuid, kind, name: r.name || r.human_name || uuid, projectId: projectIdOf(r) });
    }
  }
  return rows;
}

async function main() {
  const prisma = new PrismaClient();
  try {
    const live = await buildLiveResources();
    const liveByUuid = new Set(live.map((r) => r.uuid));

    const sites = await prisma.site.findMany({
      where: { deletedAt: null, NOT: [{ coolifyServiceUuid: null }] },
      select: { id: true, name: true, slug: true, coolifyServiceUuid: true, coolifyProjectId: true }
    });

    const ok = [];
    const repairable = [];
    const ambiguous = [];
    const unmatched = [];

    for (const s of sites) {
      if (liveByUuid.has(s.coolifyServiceUuid)) {
        ok.push(s);
        continue;
      }
      // Stale. Find a live resource with the same name (+ project when known).
      let candidates = live.filter((r) => normalize(r.name) === normalize(s.name));
      if (candidates.length > 1 && s.coolifyProjectId) {
        const inProject = candidates.filter((r) => r.projectId === s.coolifyProjectId);
        if (inProject.length > 0) candidates = inProject;
      }
      if (candidates.length === 1) {
        repairable.push({ site: s, to: candidates[0] });
      } else if (candidates.length > 1) {
        ambiguous.push({ site: s, candidates });
      } else {
        unmatched.push(s);
      }
    }

    console.log(`Mode: ${APPLY ? "APPLY" : "dry-run"}`);
    console.log(`Live Coolify resources: ${live.length}`);
    console.log(`Sites with a coolifyServiceUuid: ${sites.length}`);
    console.log(`  already valid:  ${ok.length}`);
    console.log(`  repairable (1 match): ${repairable.length}`);
    console.log(`  ambiguous (>1 match, needs human): ${ambiguous.length}`);
    console.log(`  unmatched (no live resource by name): ${unmatched.length}`);

    if (repairable.length) {
      console.log("\n== Proposed remaps (review before applying) ==");
      for (const { site, to } of repairable) {
        console.log(`  ${site.name}: ${site.coolifyServiceUuid}  ->  ${to.uuid}  [${to.kind}]`);
      }
    }
    if (ambiguous.length) {
      console.log("\n== Ambiguous (multiple live resources share the name) ==");
      for (const { site, candidates } of ambiguous) {
        console.log(`  ${site.name}: candidates -> ${candidates.map((c) => `${c.uuid}[${c.kind}]`).join(", ")}`);
      }
    }
    if (unmatched.length) {
      console.log("\n== Unmatched (no live resource; likely deleted or renamed) ==");
      for (const s of unmatched) console.log(`  ${s.name}  (stale ${s.coolifyServiceUuid})`);
    }

    if (APPLY && repairable.length) {
      console.log("\nApplying repairable remaps...");
      let updated = 0;
      for (const { site, to } of repairable) {
        await prisma.site.update({ where: { id: site.id }, data: { coolifyServiceUuid: to.uuid } });
        updated += 1;
      }
      console.log(`Updated ${updated} site mapping(s). Ambiguous/unmatched were NOT touched.`);
    } else if (!APPLY) {
      console.log("\nDry-run only. Re-run with --apply to update the repairable mappings.");
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
