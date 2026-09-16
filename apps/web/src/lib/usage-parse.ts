/**
 * Turning collector output into usage — the part that has to be right.
 *
 * Pure: no database, no SSH, no clock. scripts/usage-collect.sh prints kernel
 * counters; this parses them, decides which app each container belongs to, and
 * turns successive readings into hourly increments. The store (usage-store.ts)
 * only writes what this returns, so everything that can be wrong about a number
 * is testable here.
 *
 * ## Counters, not percentages
 *
 * CPU (`usage_usec`) and network bytes are cumulative since the container
 * started. The usage between two readings is simply the difference, however far
 * apart they are — so a reading every five minutes is exact, not an estimate.
 * The hazards are all about the counter restarting:
 *
 *   - `docker restart` keeps the container id but creates a new cgroup and
 *     network namespace, so every counter drops back to zero. Detected by a new
 *     `startedAt` or a counter going backwards; the whole new value is usage
 *     since the restart.
 *   - A redeploy creates a NEW container id. If it started after our last run,
 *     all of its counters are usage within the interval. If we have simply never
 *     seen it (first ever run), we cannot know how much predates us, so it is
 *     taken as a baseline and contributes nothing until the next reading.
 *   - Two collectors can race (two app replicas both run the scheduler). A
 *     reading older than the stored state is skipped rather than subtracted.
 *
 * Memory is a gauge: each run records the app's working set at that moment, and
 * the hourly bucket keeps a sum, a count and a peak.
 */

export const USAGE_FORMAT_VERSION = 1;

/** Readings older than this gap are re-baselined instead of spread. */
export const MAX_SPREAD_SECONDS = 72 * 3600;

export type HostReading = {
  ts: number;
  host: string;
  ncpu: number | null;
  memTotal: number | null;
  memAvailable: number | null;
  cpuBusyUsec: number | null;
  netRx: number | null;
  netTx: number | null;
  diskSize: number | null;
  diskUsed: number | null;
  /** Free bytes for non-root users (df "avail"). Null from collectors that predate it. */
  diskAvail: number | null;
};

export type ContainerReading = {
  ts: number;
  id: string;
  name: string;
  startedAt: string | null;
  netMode: string | null;
  memLimit: number | null;
  nanoCpus: number | null;
  coolifyType: string | null;
  project: string | null;
  resource: string | null;
  environment: string | null;
  /** Routed by Traefik, so its transmit bytes leave the server. */
  publicFacing: boolean;
  cpuUsec: number | null;
  memCurrent: number | null;
  inactiveFile: number | null;
  netRx: number | null;
  netTx: number | null;
};

export type CollectorPass = { host: HostReading | null; containers: ContainerReading[] };

export type CollectorOutput = {
  version: number | null;
  passes: CollectorPass[];
  /** Container -> persistent paths it mounts (disk mode). */
  mounts: Array<{ containerId: string; source: string }>;
  /** Path -> bytes on disk (disk mode). */
  sizes: Map<string, number>;
  /** Lines that did not parse — surfaced, never silently dropped. */
  rejected: string[];
};

function num(value: string | undefined): number | null {
  if (value === undefined || value === "-" || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function str(value: string | undefined): string | null {
  if (value === undefined || value === "-" || value === "") return null;
  return value;
}

export function parseCollectorOutput(raw: string): CollectorOutput {
  const out: CollectorOutput = { version: null, passes: [], mounts: [], sizes: new Map(), rejected: [] };
  let current: CollectorPass = { host: null, containers: [] };
  out.passes.push(current);

  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    const f = line.split("\t");
    switch (f[0]) {
      case "V":
        out.version = num(f[1]);
        break;
      case "P":
        // A new pass. The first "P" replaces the implicit empty pass.
        if (current.host || current.containers.length) {
          current = { host: null, containers: [] };
          out.passes.push(current);
        }
        break;
      case "H": {
        if (f.length < 11) { out.rejected.push(line); break; }
        const ts = num(f[1]);
        if (ts === null || !f[2]) { out.rejected.push(line); break; }
        current.host = {
          ts, host: f[2], ncpu: num(f[3]), memTotal: num(f[4]), memAvailable: num(f[5]),
          cpuBusyUsec: num(f[6]), netRx: num(f[7]), netTx: num(f[8]), diskSize: num(f[9]), diskUsed: num(f[10]),
          diskAvail: num(f[11])
        };
        break;
      }
      case "C": {
        if (f.length < 18) { out.rejected.push(line); break; }
        const ts = num(f[1]);
        if (ts === null || !f[2]) { out.rejected.push(line); break; }
        current.containers.push({
          ts, id: f[2], name: f[3] === "-" ? f[2].slice(0, 12) : f[3], startedAt: str(f[4]), netMode: str(f[5]),
          memLimit: num(f[6]), nanoCpus: num(f[7]), coolifyType: str(f[8]), project: str(f[9]),
          resource: str(f[10]), environment: str(f[11]), publicFacing: f[12] === "true",
          cpuUsec: num(f[13]), memCurrent: num(f[14]), inactiveFile: num(f[15]), netRx: num(f[16]), netTx: num(f[17])
        });
        break;
      }
      case "M":
        if (f[1] && f[2]) out.mounts.push({ containerId: f[1], source: f[2] });
        else out.rejected.push(line);
        break;
      case "S": {
        const bytes = num(f[1]);
        if (bytes !== null && f[2]) out.sizes.set(f[2], bytes);
        else out.rejected.push(line);
        break;
      }
      default:
        out.rejected.push(line);
    }
  }

  if (out.passes.length > 1 && !out.passes[0].host && out.passes[0].containers.length === 0) out.passes.shift();
  return out;
}

/**
 * Memory the container actually holds: current minus reclaimable page cache.
 * This is the figure `docker stats` reports. Raw `memory.current` counts file
 * cache the kernel will drop under pressure, and would make a WordPress site
 * that has read its uploads once look like it needs gigabytes.
 */
export function workingSetBytes(c: Pick<ContainerReading, "memCurrent" | "inactiveFile">): number {
  if (c.memCurrent === null) return 0;
  return Math.max(0, c.memCurrent - (c.inactiveFile ?? 0));
}

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

export type SiteRef = {
  id: string;
  coolifyServiceUuid: string | null;
  name: string;
  organizationId: string;
  parentSiteId: string | null;
};

export type Subject = { subjectKey: string; siteId: string | null; label: string };

const COOLIFY_UUID = /^[a-z0-9]{24}$/;

/** 24-character Coolify ids embedded in a container name, in order. */
export function uuidTokens(name: string): string[] {
  return name.toLowerCase().split(/[-_.]/).filter((token) => COOLIFY_UUID.test(token));
}

/**
 * Which app a container belongs to.
 *
 * Coolify names containers after the resource: `<uuid>-<timestamp>` for an
 * application, `<service>-<uuid>` for each part of a compose service, `<uuid>`
 * for a database. The same dash-delimited token match scripts/site-backup.mjs
 * uses to find an app's containers, so backups and usage never disagree about
 * which containers are whose.
 *
 * Anything that matches no Jongo app is still counted — as platform overhead
 * ("infra:") or as a Coolify resource with no Jongo app ("unmapped:"). Those are
 * exactly the rows a cost audit needs: capacity nobody is being billed for.
 */
export function attributeContainer(c: Pick<ContainerReading, "name" | "resource" | "project">, sitesByUuid: Map<string, SiteRef>): Subject {
  const tokens = uuidTokens(c.name);
  for (const token of tokens) {
    const site = sitesByUuid.get(token);
    if (site) return { subjectKey: site.id, siteId: site.id, label: site.name };
  }
  if (tokens.length > 0) {
    const label = [c.project, c.resource].filter(Boolean).join(" / ") || c.name;
    return { subjectKey: `unmapped:${tokens[0]}`, siteId: null, label };
  }
  // coolify-proxy, coolify-sentinel, jongo-parking… strip a trailing numeric suffix.
  const group = c.name.replace(/[-_]\d+$/, "") || c.name;
  return { subjectKey: `infra:${group}`, siteId: null, label: group };
}

// ---------------------------------------------------------------------------
// Deltas
// ---------------------------------------------------------------------------

export type CounterState = {
  key: string;
  /** Epoch seconds of the reading this state holds. */
  collectedAt: number;
  startedAt: string | null;
  cpuUsec: number;
  netRx: number;
  netTx: number;
};

export type CounterDelta = { cpuUsec: number; netRx: number; netTx: number; fromTs: number; toTs: number };

function toEpoch(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

/**
 * Usage since the previous reading of the same container, or null when this
 * reading must be skipped entirely (it is older than what is already stored).
 */
export function containerDelta(
  prev: CounterState | undefined,
  cur: Pick<ContainerReading, "ts" | "startedAt" | "cpuUsec" | "netRx" | "netTx">,
  lastRunTs: number | null
): CounterDelta | null {
  const cpu = cur.cpuUsec ?? 0;
  const rx = cur.netRx ?? 0;
  const tx = cur.netTx ?? 0;
  const started = toEpoch(cur.startedAt);

  if (prev) {
    if (cur.ts <= prev.collectedAt) return null;
    // Compare start times as instants, never as strings: Docker reports
    // nanoseconds ("…00.123456789Z") and Postgres returns milliseconds
    // ("…00.123Z"). A string comparison sees every reading as a restart and
    // bills the container's whole lifetime again on every run.
    const prevStarted = toEpoch(prev.startedAt);
    const startChanged = started !== null && prevStarted !== null && Math.abs(started - prevStarted) > 1;
    const restarted = startChanged || cpu < prev.cpuUsec || rx < prev.netRx || tx < prev.netTx;
    if (restarted) {
      const fromTs = Math.max(prev.collectedAt, started ?? prev.collectedAt);
      return { cpuUsec: cpu, netRx: rx, netTx: tx, fromTs: Math.min(fromTs, cur.ts), toTs: cur.ts };
    }
    return { cpuUsec: cpu - prev.cpuUsec, netRx: rx - prev.netRx, netTx: tx - prev.netTx, fromTs: prev.collectedAt, toTs: cur.ts };
  }

  // Never seen. Only count it if it provably started since our last run.
  if (lastRunTs !== null && started !== null && started > lastRunTs && started <= cur.ts) {
    return { cpuUsec: cpu, netRx: rx, netTx: tx, fromTs: started, toTs: cur.ts };
  }
  return { cpuUsec: 0, netRx: 0, netTx: 0, fromTs: cur.ts, toTs: cur.ts };
}

export function hourStartOf(ts: number): number {
  return Math.floor(ts / 3600) * 3600;
}

/**
 * Split an amount across the hour buckets an interval spans, by overlap.
 *
 * Normally the interval is five minutes inside one hour. After an outage it may
 * span several, and putting a day of CPU into the hour the collector came back
 * would draw a spike that never happened. Past MAX_SPREAD_SECONDS the shape is
 * too uncertain to draw at all, and the caller drops the delta.
 */
export function spreadAcrossHours(fromTs: number, toTs: number, amount: number): Array<{ hourStart: number; amount: number }> {
  if (amount === 0) return [];
  if (toTs <= fromTs) return [{ hourStart: hourStartOf(toTs), amount }];
  const total = toTs - fromTs;
  const parts: Array<{ hourStart: number; amount: number }> = [];
  let cursor = fromTs;
  while (cursor < toTs) {
    const hour = hourStartOf(cursor);
    const end = Math.min(hour + 3600, toTs);
    parts.push({ hourStart: hour, amount: (amount * (end - cursor)) / total });
    cursor = end;
  }
  return parts;
}

// ---------------------------------------------------------------------------
// One run -> hourly increments
// ---------------------------------------------------------------------------

export type HourlyIncrement = {
  hourStart: number;
  subjectKey: string;
  siteId: string | null;
  label: string;
  cpuCoreSeconds: number;
  memSumBytes: number;
  memSamples: number;
  memPeakBytes: number;
  netRxBytes: number;
  netTxBytes: number;
  egressBytes: number;
  containers: number;
  diskBytes: number | null;
};

export type HostIncrement = {
  hourStart: number;
  /**
   * Seconds of this hour that readings actually span. The denominator for any
   * average: the first hour of collection, and the hour in progress, are only
   * partly measured, and dividing their CPU by a full hour understates load.
   */
  coveredSeconds: number;
  cpuCores: number;
  cpuBusySeconds: number;
  memTotalBytes: number;
  memUsedBytes: number;
  netRxBytes: number;
  netTxBytes: number;
  diskTotalBytes: number;
  diskUsedBytes: number;
  /** Free bytes (df "avail") at this reading; null when the collector did not report it. */
  diskAvailBytes: number | null;
};

export type RunResult = {
  host: string;
  sampleTs: number;
  increments: HourlyIncrement[];
  hostIncrements: HostIncrement[];
  nextStates: CounterState[];
  skippedStale: number;
  droppedGaps: number;
  containerCount: number;
};

export function hostStateKey(host: string): string {
  return `h:${host}`;
}

export function containerStateKey(id: string): string {
  return `c:${id}`;
}

export function computeRun(input: {
  output: CollectorOutput;
  states: Map<string, CounterState>;
  sitesByUuid: Map<string, SiteRef>;
  /** Include disk sizes from the output (disk mode). */
  withDisk: boolean;
}): RunResult | null {
  const pass = input.output.passes[input.output.passes.length - 1];
  if (!pass?.host) return null;
  const host = pass.host.host;
  const sampleTs = pass.host.ts;
  const sampleHour = hourStartOf(sampleTs);
  const hostState = input.states.get(hostStateKey(host));
  const lastRunTs = hostState?.collectedAt ?? null;

  const buckets = new Map<string, HourlyIncrement>();
  const bucket = (hourStart: number, subject: Subject): HourlyIncrement => {
    const key = `${hourStart}|${subject.subjectKey}`;
    let b = buckets.get(key);
    if (!b) {
      b = {
        hourStart, subjectKey: subject.subjectKey, siteId: subject.siteId, label: subject.label,
        cpuCoreSeconds: 0, memSumBytes: 0, memSamples: 0, memPeakBytes: 0,
        netRxBytes: 0, netTxBytes: 0, egressBytes: 0, containers: 0, diskBytes: null
      };
      buckets.set(key, b);
    }
    return b;
  };

  const nextStates: CounterState[] = [];
  const memBySubject = new Map<string, { subject: Subject; bytes: number; containers: number }>();
  const subjectByContainer = new Map<string, Subject>();
  let skippedStale = 0;
  let droppedGaps = 0;

  for (const c of pass.containers) {
    const subject = attributeContainer(c, input.sitesByUuid);
    subjectByContainer.set(c.id, subject);

    const agg = memBySubject.get(subject.subjectKey) ?? { subject, bytes: 0, containers: 0 };
    agg.bytes += workingSetBytes(c);
    agg.containers += 1;
    memBySubject.set(subject.subjectKey, agg);

    const key = containerStateKey(c.id);
    const delta = containerDelta(input.states.get(key), c, lastRunTs);
    if (!delta) { skippedStale += 1; continue; }

    nextStates.push({
      key, collectedAt: c.ts, startedAt: c.startedAt,
      cpuUsec: c.cpuUsec ?? 0, netRx: c.netRx ?? 0, netTx: c.netTx ?? 0
    });

    if (delta.toTs - delta.fromTs > MAX_SPREAD_SECONDS) { droppedGaps += 1; continue; }

    for (const part of spreadAcrossHours(delta.fromTs, delta.toTs, delta.cpuUsec / 1e6)) {
      bucket(part.hourStart, subject).cpuCoreSeconds += part.amount;
    }
    for (const part of spreadAcrossHours(delta.fromTs, delta.toTs, delta.netRx)) {
      bucket(part.hourStart, subject).netRxBytes += part.amount;
    }
    for (const part of spreadAcrossHours(delta.fromTs, delta.toTs, delta.netTx)) {
      const b = bucket(part.hourStart, subject);
      b.netTxBytes += part.amount;
      if (c.publicFacing) b.egressBytes += part.amount;
    }
  }

  // Memory: one sample per subject per run, in the hour the run happened.
  for (const { subject, bytes, containers } of memBySubject.values()) {
    const b = bucket(sampleHour, subject);
    b.memSumBytes += bytes;
    b.memSamples += 1;
    b.memPeakBytes = Math.max(b.memPeakBytes, bytes);
    b.containers = Math.max(b.containers, containers);
  }

  // Disk: each persistent path counted once, for the app whose container mounts it.
  if (input.withDisk && input.output.sizes.size > 0) {
    const claimed = new Set<string>();
    const diskBySubject = new Map<string, { subject: Subject; bytes: number }>();
    for (const m of input.output.mounts) {
      const subject = subjectByContainer.get(m.containerId);
      const bytes = input.output.sizes.get(m.source);
      if (!subject || bytes === undefined || claimed.has(m.source)) continue;
      claimed.add(m.source);
      const agg = diskBySubject.get(subject.subjectKey) ?? { subject, bytes: 0 };
      agg.bytes += bytes;
      diskBySubject.set(subject.subjectKey, agg);
    }
    for (const { subject, bytes } of diskBySubject.values()) {
      bucket(sampleHour, subject).diskBytes = bytes;
    }
  }

  // Host totals.
  const hostIncrements: HostIncrement[] = [];
  const h = pass.host;
  const base = {
    cpuCores: h.ncpu ?? 0,
    memTotalBytes: h.memTotal ?? 0,
    diskTotalBytes: h.diskSize ?? 0,
    diskUsedBytes: h.diskUsed ?? 0,
    diskAvailBytes: h.diskAvail
  };
  const memUsed = h.memTotal !== null && h.memAvailable !== null ? Math.max(0, h.memTotal - h.memAvailable) : 0;
  const byHour = new Map<number, HostIncrement>();
  const hostBucket = (hourStart: number): HostIncrement => {
    let b = byHour.get(hourStart);
    if (!b) {
      b = { hourStart, ...base, coveredSeconds: 0, cpuBusySeconds: 0, memUsedBytes: 0, netRxBytes: 0, netTxBytes: 0 };
      byHour.set(hourStart, b);
    }
    return b;
  };
  hostBucket(sampleHour).memUsedBytes = memUsed;

  const hostCur = { ts: h.ts, startedAt: null, cpuUsec: h.cpuBusyUsec, netRx: h.netRx, netTx: h.netTx };
  const hostDelta = hostState ? containerDelta(hostState, hostCur, lastRunTs) : null;
  if (hostDelta && hostDelta.toTs - hostDelta.fromTs <= MAX_SPREAD_SECONDS) {
    for (const part of spreadAcrossHours(hostDelta.fromTs, hostDelta.toTs, hostDelta.cpuUsec / 1e6)) hostBucket(part.hourStart).cpuBusySeconds += part.amount;
    for (const part of spreadAcrossHours(hostDelta.fromTs, hostDelta.toTs, hostDelta.netRx)) hostBucket(part.hourStart).netRxBytes += part.amount;
    for (const part of spreadAcrossHours(hostDelta.fromTs, hostDelta.toTs, hostDelta.netTx)) hostBucket(part.hourStart).netTxBytes += part.amount;
    // Spreading the interval's own length gives each hour its overlap in seconds.
    for (const part of spreadAcrossHours(hostDelta.fromTs, hostDelta.toTs, hostDelta.toTs - hostDelta.fromTs)) hostBucket(part.hourStart).coveredSeconds += part.amount;
  }
  if (!hostState || h.ts > hostState.collectedAt) {
    nextStates.push({
      key: hostStateKey(host), collectedAt: h.ts, startedAt: null,
      cpuUsec: h.cpuBusyUsec ?? 0, netRx: h.netRx ?? 0, netTx: h.netTx ?? 0
    });
  }
  hostIncrements.push(...byHour.values());

  return {
    host, sampleTs,
    increments: [...buckets.values()],
    hostIncrements,
    nextStates,
    skippedStale,
    droppedGaps,
    containerCount: pass.containers.length
  };
}

// ---------------------------------------------------------------------------
// Live snapshot (two passes a few seconds apart)
// ---------------------------------------------------------------------------

export type LiveSubject = Subject & {
  cpuCores: number;
  memoryBytes: number;
  memoryLimitBytes: number | null;
  rxBytesPerSec: number;
  txBytesPerSec: number;
  egressBytesPerSec: number;
  containers: number;
};

export type LiveSnapshot = {
  host: string;
  takenAt: number;
  cpuCores: number;
  memTotalBytes: number;
  subjects: LiveSubject[];
};

export function computeLive(output: CollectorOutput, sitesByUuid: Map<string, SiteRef>): LiveSnapshot | null {
  if (output.passes.length < 2) return null;
  const [a, b] = output.passes.slice(-2);
  if (!b.host) return null;
  const before = new Map(a.containers.map((c) => [c.id, c]));
  const subjects = new Map<string, LiveSubject>();

  for (const c of b.containers) {
    const subject = attributeContainer(c, sitesByUuid);
    const s = subjects.get(subject.subjectKey) ?? {
      ...subject, cpuCores: 0, memoryBytes: 0, memoryLimitBytes: null,
      rxBytesPerSec: 0, txBytesPerSec: 0, egressBytesPerSec: 0, containers: 0
    };
    s.memoryBytes += workingSetBytes(c);
    s.containers += 1;
    if (c.memLimit && c.memLimit > 0) s.memoryLimitBytes = (s.memoryLimitBytes ?? 0) + c.memLimit;
    const prev = before.get(c.id);
    const dt = prev ? c.ts - prev.ts : 0;
    if (prev && dt > 0 && prev.startedAt === c.startedAt) {
      const cpu = (c.cpuUsec ?? 0) - (prev.cpuUsec ?? 0);
      const rx = (c.netRx ?? 0) - (prev.netRx ?? 0);
      const tx = (c.netTx ?? 0) - (prev.netTx ?? 0);
      if (cpu >= 0) s.cpuCores += cpu / 1e6 / dt;
      if (rx >= 0) s.rxBytesPerSec += rx / dt;
      if (tx >= 0) {
        s.txBytesPerSec += tx / dt;
        if (c.publicFacing) s.egressBytesPerSec += tx / dt;
      }
    }
    subjects.set(subject.subjectKey, s);
  }

  return {
    host: b.host.host,
    takenAt: b.host.ts,
    cpuCores: b.host.ncpu ?? 0,
    memTotalBytes: b.host.memTotal ?? 0,
    subjects: [...subjects.values()]
  };
}
