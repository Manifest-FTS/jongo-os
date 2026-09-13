import { describe, expect, it } from "vitest";
import {
  MAX_SPREAD_SECONDS,
  attributeContainer,
  computeLive,
  computeRun,
  containerDelta,
  containerStateKey,
  hostStateKey,
  parseCollectorOutput,
  spreadAcrossHours,
  uuidTokens,
  workingSetBytes,
  type CounterState,
  type SiteRef
} from "./usage-parse";

/*
 * Fixture in the exact format scripts/usage-collect.sh prints (verified against
 * a real host run), with invented names and ids — this repository is public,
 * so no real client or container identifiers belong in it.
 */
const APP_UUID = "aaaaaaaaaaaaaaaaaaaaaaa1"; // an application
const WP_UUID = "bbbbbbbbbbbbbbbbbbbbbbb2"; // a WordPress compose service
const DB_UUID = "ccccccccccccccccccccccc3"; // a standalone database nested in APP
const ORPHAN_UUID = "ddddddddddddddddddddddd4"; // in Coolify, not in Jongo

const T0 = 1_800_000_000; // an exact hour boundary (1_800_000_000 % 3600 === 0)
const STARTED = "2026-09-01T00:00:00.000000000Z";

function C(fields: {
  ts?: number; id: string; name: string; started?: string; netMode?: string;
  traefik?: string; cpu: number | "-"; mem: number | "-"; inactive?: number | "-"; rx?: number | "-"; tx?: number | "-";
}) {
  return [
    "C", fields.ts ?? T0, fields.id, fields.name, fields.started ?? STARTED, fields.netMode ?? "coolify",
    0, 0, "service", "demo-project", "demo-resource", "production", fields.traefik ?? "-",
    fields.cpu, fields.mem, fields.inactive ?? 0, fields.rx ?? 0, fields.tx ?? 0
  ].join("\t");
}

function H(ts: number, busyUsec = 1_000_000_000, netRx = 5_000, netTx = 9_000) {
  return ["H", ts, "host-1", 8, 32e9, 12e9, busyUsec, netRx, netTx, 240e9, 160e9].join("\t");
}

const sites: SiteRef[] = [
  { id: "site-app", coolifyServiceUuid: APP_UUID, name: "Demo App", organizationId: "org-1", parentSiteId: null },
  { id: "site-wp", coolifyServiceUuid: WP_UUID, name: "Demo WordPress", organizationId: "org-1", parentSiteId: null },
  { id: "site-db", coolifyServiceUuid: DB_UUID, name: "Demo DB", organizationId: "org-1", parentSiteId: "site-app" }
];
const byUuid = new Map(sites.map((s) => [s.coolifyServiceUuid as string, s]));

function run(lines: string[], states = new Map<string, CounterState>(), withDisk = false) {
  const out = parseCollectorOutput(["V\t1", ...lines].join("\n"));
  const result = computeRun({ output: out, states, sitesByUuid: byUuid, withDisk });
  if (!result) throw new Error("no run");
  return { out, result, states: new Map(result.nextStates.map((s) => [s.key, s])) };
}

function sumCpu(result: ReturnType<typeof computeRun>, subjectKey?: string) {
  return (result?.increments ?? [])
    .filter((i) => !subjectKey || i.subjectKey === subjectKey)
    .reduce((a, i) => a + i.cpuCoreSeconds, 0);
}

describe("parseCollectorOutput", () => {
  it("reads every record type", () => {
    const out = parseCollectorOutput([
      "V\t1",
      H(T0),
      C({ id: "id-app", name: `${APP_UUID}-123456789012`, cpu: 10, mem: 100, traefik: "true" }),
      `M\tid-app\t/var/lib/docker/volumes/x/_data`,
      `S\t4096\t/var/lib/docker/volumes/x/_data`
    ].join("\n"));
    expect(out.version).toBe(1);
    expect(out.passes).toHaveLength(1);
    expect(out.passes[0].host?.ncpu).toBe(8);
    expect(out.passes[0].containers[0]).toMatchObject({ id: "id-app", publicFacing: true, cpuUsec: 10 });
    expect(out.mounts).toEqual([{ containerId: "id-app", source: "/var/lib/docker/volumes/x/_data" }]);
    expect(out.sizes.get("/var/lib/docker/volumes/x/_data")).toBe(4096);
    expect(out.rejected).toEqual([]);
  });

  it("turns '-' into null instead of zero", () => {
    const out = parseCollectorOutput(C({ id: "x", name: "coolify-proxy", cpu: "-", mem: "-", rx: "-", tx: "-" }));
    const c = out.passes[0].containers[0];
    expect([c.cpuUsec, c.memCurrent, c.netRx, c.netTx]).toEqual([null, null, null, null]);
  });

  it("rejects truncated lines rather than misreading shifted columns", () => {
    const out = parseCollectorOutput("C\t123\tid-only\n" + "H\t1\n" + "garbage");
    expect(out.passes[0].containers).toHaveLength(0);
    expect(out.rejected).toHaveLength(3);
  });

  it("splits live mode into two passes", () => {
    const out = parseCollectorOutput(["V\t1", "P\t1", H(T0), "P\t2", H(T0 + 2)].join("\n"));
    expect(out.passes.map((p) => p.host?.ts)).toEqual([T0, T0 + 2]);
  });
});

describe("workingSetBytes", () => {
  it("excludes reclaimable page cache, as docker stats does", () => {
    expect(workingSetBytes({ memCurrent: 1000, inactiveFile: 300 })).toBe(700);
    expect(workingSetBytes({ memCurrent: 100, inactiveFile: 500 })).toBe(0);
    expect(workingSetBytes({ memCurrent: null, inactiveFile: 5 })).toBe(0);
  });
});

describe("attributeContainer", () => {
  it("matches an application container named <uuid>-<timestamp>", () => {
    expect(attributeContainer({ name: `${APP_UUID}-092248860915`, project: null, resource: null }, byUuid).siteId).toBe("site-app");
  });

  it("matches each part of a compose service named <part>-<uuid>", () => {
    expect(attributeContainer({ name: `wordpress-${WP_UUID}`, project: null, resource: null }, byUuid).siteId).toBe("site-wp");
    expect(attributeContainer({ name: `mariadb-${WP_UUID}`, project: null, resource: null }, byUuid).siteId).toBe("site-wp");
  });

  it("matches a bare database container", () => {
    expect(attributeContainer({ name: DB_UUID, project: null, resource: null }, byUuid).siteId).toBe("site-db");
  });

  it("keeps Coolify resources with no Jongo app visible as unmapped", () => {
    const s = attributeContainer({ name: `app-${ORPHAN_UUID}`, project: "some-project", resource: "some-app" }, byUuid);
    expect(s).toEqual({ subjectKey: `unmapped:${ORPHAN_UUID}`, siteId: null, label: "some-project / some-app" });
  });

  it("groups platform containers as infrastructure", () => {
    expect(attributeContainer({ name: "coolify-proxy", project: null, resource: null }, byUuid).subjectKey).toBe("infra:coolify-proxy");
  });

  it("only treats 24-character tokens as ids", () => {
    expect(uuidTokens(`x-${APP_UUID}-092248860915-short`)).toEqual([APP_UUID]);
  });
});

describe("containerDelta", () => {
  const prev: CounterState = { key: "c:x", collectedAt: T0, startedAt: STARTED, cpuUsec: 1_000, netRx: 500, netTx: 800 };

  it("is the plain difference between readings", () => {
    expect(containerDelta(prev, { ts: T0 + 300, startedAt: STARTED, cpuUsec: 4_000, netRx: 700, netTx: 900 }, T0))
      .toEqual({ cpuUsec: 3_000, netRx: 200, netTx: 100, fromTs: T0, toTs: T0 + 300 });
  });

  it("does not mistake the same start time in two precisions for a restart", () => {
    // Stored state comes back from Postgres with milliseconds; Docker reports
    // nanoseconds. Equal instants — so this is a normal delta, not a restart
    // that would re-bill the container's entire lifetime.
    const stored: CounterState = { ...prev, startedAt: "2026-09-01T00:00:00.123Z" };
    const d = containerDelta(stored, { ts: T0 + 300, startedAt: "2026-09-01T00:00:00.123456789Z", cpuUsec: 4_000, netRx: 700, netTx: 900 }, T0);
    expect(d?.cpuUsec).toBe(3_000);
  });

  it("counts everything since a restart when startedAt changes", () => {
    const d = containerDelta(prev, { ts: T0 + 300, startedAt: "2026-09-02T00:00:00Z", cpuUsec: 50, netRx: 5, netTx: 7 }, T0);
    expect(d?.cpuUsec).toBe(50);
    expect(d?.netTx).toBe(7);
  });

  it("treats a counter going backwards as a restart, never as negative usage", () => {
    const d = containerDelta(prev, { ts: T0 + 300, startedAt: STARTED, cpuUsec: 10, netRx: 600, netTx: 900 }, T0);
    expect(d?.cpuUsec).toBe(10);
    expect(d!.cpuUsec).toBeGreaterThanOrEqual(0);
  });

  it("skips a reading older than the stored one (two collectors racing)", () => {
    expect(containerDelta(prev, { ts: T0 - 1, startedAt: STARTED, cpuUsec: 9e9, netRx: 0, netTx: 0 }, T0)).toBeNull();
  });

  it("counts a new container that started after the last run in full", () => {
    const started = new Date((T0 + 60) * 1000).toISOString();
    expect(containerDelta(undefined, { ts: T0 + 300, startedAt: started, cpuUsec: 777, netRx: 1, netTx: 2 }, T0))
      .toMatchObject({ cpuUsec: 777, fromTs: T0 + 60 });
  });

  it("baselines a container it has simply never seen, rather than guessing", () => {
    expect(containerDelta(undefined, { ts: T0 + 300, startedAt: STARTED, cpuUsec: 9e9, netRx: 9e9, netTx: 9e9 }, T0))
      .toMatchObject({ cpuUsec: 0, netRx: 0, netTx: 0 });
    expect(containerDelta(undefined, { ts: T0, startedAt: STARTED, cpuUsec: 9e9, netRx: 0, netTx: 0 }, null)?.cpuUsec).toBe(0);
  });
});

describe("spreadAcrossHours", () => {
  it("keeps a short interval in one hour", () => {
    expect(spreadAcrossHours(T0 + 100, T0 + 400, 30)).toEqual([{ hourStart: T0, amount: 30 }]);
  });

  it("splits by overlap and conserves the total", () => {
    const parts = spreadAcrossHours(T0 + 1800, T0 + 3 * 3600 + 1800, 300);
    expect(parts.map((p) => p.hourStart)).toEqual([T0, T0 + 3600, T0 + 7200, T0 + 10800]);
    expect(parts.map((p) => p.amount)).toEqual([50, 100, 100, 50]);
    expect(parts.reduce((a, p) => a + p.amount, 0)).toBe(300);
  });
});

describe("computeRun", () => {
  const first = [
    H(T0),
    C({ id: "app-1", name: `${APP_UUID}-111111111111`, cpu: 1_000_000, mem: 500, inactive: 100, rx: 1_000, tx: 2_000, traefik: "true" }),
    C({ id: "db-1", name: DB_UUID, cpu: 5_000_000, mem: 300, rx: 9_000, tx: 9_000 }),
    C({ id: "proxy", name: "coolify-proxy", cpu: 2_000_000, mem: 50, tx: 50_000, traefik: "true" })
  ];

  it("records no CPU or traffic on the very first run — only a baseline", () => {
    const { result } = run(first);
    expect(sumCpu(result)).toBe(0);
    expect(result.increments.every((i) => i.egressBytes === 0)).toBe(true);
    // Memory is a gauge, so it IS recorded straight away.
    expect(result.increments.find((i) => i.subjectKey === "site-app")?.memSumBytes).toBe(400);
  });

  it("turns the second run into exact CPU seconds and egress", () => {
    const { states } = run(first);
    const { result } = run([
      H(T0 + 300, 1_000_000_000 + 600_000_000),
      C({ ts: T0 + 300, id: "app-1", name: `${APP_UUID}-111111111111`, cpu: 1_000_000 + 30_000_000, mem: 600, inactive: 100, rx: 1_500, tx: 7_000, traefik: "true" }),
      C({ ts: T0 + 300, id: "db-1", name: DB_UUID, cpu: 5_000_000 + 3_000_000, mem: 300, rx: 12_000, tx: 12_000 }),
      C({ ts: T0 + 300, id: "proxy", name: "coolify-proxy", cpu: 2_000_000, mem: 50, tx: 90_000, traefik: "true" })
    ], states);

    expect(sumCpu(result, "site-app")).toBeCloseTo(30);
    expect(sumCpu(result, "site-db")).toBeCloseTo(3);
    const app = result.increments.find((i) => i.subjectKey === "site-app")!;
    expect(app.egressBytes).toBe(5_000);
    // The database is not public-facing: its traffic to the app is not egress.
    expect(result.increments.find((i) => i.subjectKey === "site-db")!.egressBytes).toBe(0);
    expect(result.hostIncrements[0].cpuBusySeconds).toBeCloseTo(600);
  });

  it("records how much of each hour was actually measured", () => {
    const { states } = run([H(T0 + 3300)]);
    const { result } = run([H(T0 + 3900)], states);
    // 300s before the hour boundary, 300s after — not two full hours.
    expect(result.hostIncrements.map((h) => [h.hourStart, h.coveredSeconds]).sort()).toEqual([[T0, 300], [T0 + 3600, 300]]);
  });

  it("sums an app's containers for its memory sample and peak", () => {
    const { result } = run([
      H(T0),
      C({ id: "wp", name: `wordpress-${WP_UUID}`, cpu: 0, mem: 700 }),
      C({ id: "maria", name: `mariadb-${WP_UUID}`, cpu: 0, mem: 300 })
    ]);
    const wp = result.increments.find((i) => i.subjectKey === "site-wp")!;
    expect(wp).toMatchObject({ memSumBytes: 1000, memSamples: 1, memPeakBytes: 1000, containers: 2 });
  });

  it("counts a volume once even when two containers mount it", () => {
    const { result } = run([
      H(T0),
      C({ id: "wp", name: `wordpress-${WP_UUID}`, cpu: 0, mem: 1 }),
      C({ id: "maria", name: `mariadb-${WP_UUID}`, cpu: 0, mem: 1 }),
      "M\twp\t/data/coolify/services/x/uploads",
      "M\tmaria\t/data/coolify/services/x/uploads",
      "M\tmaria\t/var/lib/docker/volumes/db/_data",
      "S\t1000\t/data/coolify/services/x/uploads",
      "S\t250\t/var/lib/docker/volumes/db/_data"
    ], new Map(), true);
    expect(result.increments.find((i) => i.subjectKey === "site-wp")!.diskBytes).toBe(1250);
  });

  it("ignores disk sizes unless asked", () => {
    const { result } = run([H(T0), C({ id: "wp", name: `wordpress-${WP_UUID}`, cpu: 0, mem: 1 }), "M\twp\t/a", "S\t9\t/a"]);
    expect(result.increments[0].diskBytes).toBeNull();
  });

  it("drops a delta that spans a multi-day outage instead of inventing its shape", () => {
    const states = new Map<string, CounterState>([
      [hostStateKey("host-1"), { key: hostStateKey("host-1"), collectedAt: T0, startedAt: null, cpuUsec: 0, netRx: 0, netTx: 0 }],
      [containerStateKey("app-1"), { key: containerStateKey("app-1"), collectedAt: T0, startedAt: STARTED, cpuUsec: 0, netRx: 0, netTx: 0 }]
    ]);
    const later = T0 + MAX_SPREAD_SECONDS + 3600;
    const { result } = run([H(later), C({ ts: later, id: "app-1", name: `${APP_UUID}-1`, cpu: 9e12, mem: 1 })], states);
    expect(sumCpu(result)).toBe(0);
    expect(result.droppedGaps).toBe(1);
    // …but the counter state still advances, so the next run is normal again.
    expect(result.nextStates.find((s) => s.key === containerStateKey("app-1"))?.cpuUsec).toBe(9e12);
  });
});

describe("computeLive", () => {
  it("reports cores in use and egress rate between two passes", () => {
    const out = parseCollectorOutput([
      "V\t1", "P\t1", H(T0),
      C({ ts: T0, id: "app-1", name: `${APP_UUID}-1`, cpu: 0, mem: 200, tx: 0, traefik: "true" }),
      "P\t2", H(T0 + 2),
      C({ ts: T0 + 2, id: "app-1", name: `${APP_UUID}-1`, cpu: 3_000_000, mem: 250, tx: 4_000, traefik: "true" })
    ].join("\n"));
    const live = computeLive(out, byUuid)!;
    const app = live.subjects.find((s) => s.siteId === "site-app")!;
    expect(app.cpuCores).toBeCloseTo(1.5);
    expect(app.egressBytesPerSec).toBe(2_000);
    expect(app.memoryBytes).toBe(250);
  });
});
