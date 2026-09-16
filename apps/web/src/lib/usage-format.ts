/**
 * Units for the usage pages, in one place so every card, chart and table
 * agrees. Pure.
 *
 * Bytes use DECIMAL units (1 GB = 10^9 bytes). That is what hosting providers
 * bill traffic in and what Vercel's usage page shows, so a figure here can be
 * compared with an invoice without a 7% discrepancy nobody can explain.
 */

export const USAGE_WINDOWS = [30, 60, 90] as const;
export type UsageWindow = (typeof USAGE_WINDOWS)[number];

export function parseWindow(value: unknown): UsageWindow {
  const n = Number(Array.isArray(value) ? value[0] : value);
  return (USAGE_WINDOWS as readonly number[]).includes(n) ? (n as UsageWindow) : 30;
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "—";
  if (bytes < 1) return "0 B";
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < BYTE_UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const digits = unit === 0 ? 0 : value < 10 ? 2 : value < 100 ? 1 : 0;
  return `${value.toFixed(digits)} ${BYTE_UNITS[unit]}`;
}

export function formatRate(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

/** CPU time as vCPU-hours — the "compute" figure a usage-priced plan meters. */
export function vcpuHours(coreSeconds: number): number {
  return coreSeconds / 3600;
}

export function formatVcpuHours(coreSeconds: number): string {
  const h = vcpuHours(coreSeconds);
  if (!Number.isFinite(h) || h <= 0) return "0 vCPU-h";
  return `${h < 10 ? h.toFixed(2) : h < 100 ? h.toFixed(1) : Math.round(h).toLocaleString("en-US")} vCPU-h`;
}

/** Average cores busy over the hours that have data. */
export function averageCores(coreSeconds: number, hours: number): number {
  return hours > 0 ? coreSeconds / (hours * 3600) : 0;
}

export function formatCores(cores: number): string {
  if (!Number.isFinite(cores) || cores <= 0) return "0 cores";
  if (cores < 0.01) return "<0.01 cores";
  return `${cores < 10 ? cores.toFixed(2) : cores.toFixed(1)} ${cores === 1 ? "core" : "cores"}`;
}

export function formatPercent(fraction: number): string {
  if (!Number.isFinite(fraction) || fraction <= 0) return "0%";
  const pct = fraction * 100;
  if (pct < 0.1) return "<0.1%";
  return `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`;
}

/**
 * Share of the disk in use, computed the way `df` and Coolify's disk alert do:
 * used / (used + available). Blocks the filesystem reserves for root count as
 * neither, so this reads a few points above used / size, which is why the Usage
 * page used to say 89% while Coolify alerted at 93%. Falls back to used / size
 * for readings that did not report available space.
 */
export function diskUsedFraction(usedBytes: number, availBytes: number | null | undefined, totalBytes: number): number {
  if (availBytes !== null && availBytes !== undefined && usedBytes + availBytes > 0) {
    return usedBytes / (usedBytes + availBytes);
  }
  return totalBytes > 0 ? usedBytes / totalBytes : 0;
}

/** Disk percentage rounded up, as df prints it, so the page and the alert agree. */
export function formatDiskPercent(fraction: number): string {
  if (!Number.isFinite(fraction) || fraction <= 0) return "0%";
  return `${Math.min(100, Math.ceil(fraction * 100 - 1e-9))}%`;
}

export function formatUsd(amount: number): string {
  return `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export type MeterTone = "ok" | "warn" | "over";

/**
 * Where a value sits against a plan limit. Warning from 80%, so a client sees
 * the overage coming instead of hearing about it on the invoice.
 */
export function meterState(value: number, limit: number | null | undefined): { fraction: number | null; tone: MeterTone } {
  if (!limit || limit <= 0 || !Number.isFinite(value)) return { fraction: null, tone: "ok" };
  const fraction = value / limit;
  return { fraction, tone: fraction >= 1 ? "over" : fraction >= 0.8 ? "warn" : "ok" };
}

/**
 * "3 of 30 days": how much of the window actually has data behind it. Takes
 * measured hours, which can be fractional in the first hour of collection.
 */
export function describeCoverage(hoursCovered: number, days: number): string {
  if (!Number.isFinite(hoursCovered) || hoursCovered <= 0) return "No data yet";
  const covered = hoursCovered / 24;
  if (covered >= days - 0.05) return `Full ${days} days of data`;
  if (hoursCovered < 1) {
    const minutes = Math.max(1, Math.round(hoursCovered * 60));
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"} of data so far (window is ${days} days)`;
  }
  if (hoursCovered < 24) {
    const h = hoursCovered < 10 ? Math.round(hoursCovered * 10) / 10 : Math.round(hoursCovered);
    return `${h} ${h === 1 ? "hour" : "hours"} of data so far (window is ${days} days)`;
  }
  return `${covered.toFixed(covered < 10 ? 1 : 0)} of ${days} days have data`;
}
