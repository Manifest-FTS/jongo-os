import { describe, expect, it } from "vitest";
import {
  averageCores, describeCoverage, formatBytes, formatCores, formatPercent, formatVcpuHours, meterState, parseWindow
} from "./usage-format";

describe("usage-format", () => {
  it("uses decimal byte units, as providers bill traffic", () => {
    expect(formatBytes(1_000_000_000)).toBe("1.00 GB");
    expect(formatBytes(73_440_000_000)).toBe("73.4 GB");
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(null)).toBe("—");
  });

  it("reports CPU as vCPU-hours and average cores", () => {
    expect(formatVcpuHours(3600)).toBe("1.00 vCPU-h");
    expect(formatVcpuHours(360_000)).toBe("100 vCPU-h");
    expect(averageCores(7200, 2)).toBe(1);
    expect(formatCores(0.004)).toBe("<0.01 cores");
    expect(formatCores(1)).toBe("1.00 core");
  });

  it("formats small shares without rounding them to zero", () => {
    expect(formatPercent(0.0004)).toBe("<0.1%");
    expect(formatPercent(0.123)).toBe("12%");
  });

  it("only accepts the offered windows", () => {
    expect(parseWindow("60")).toBe(60);
    expect(parseWindow("45")).toBe(30);
    expect(parseWindow(undefined)).toBe(30);
    expect(parseWindow(["90"])).toBe(90);
  });

  it("warns from 80% and flags going over", () => {
    expect(meterState(25, 250)).toEqual({ fraction: 0.1, tone: "ok" });
    expect(meterState(200, 250).tone).toBe("warn");
    expect(meterState(260, 250).tone).toBe("over");
    // No limit set: no fraction, never a warning about a cap that does not exist.
    expect(meterState(5, null)).toEqual({ fraction: null, tone: "ok" });
  });

  it("is honest about how much of the window has data", () => {
    expect(describeCoverage(5, 30)).toBe("5 hours of data so far (window is 30 days)");
    expect(describeCoverage(1, 30)).toBe("1 hour of data so far (window is 30 days)");
    // The first minutes of collection must not read as a whole hour.
    expect(describeCoverage(0.05, 30)).toBe("3 minutes of data so far (window is 30 days)");
    expect(describeCoverage(2.25, 30)).toBe("2.3 hours of data so far (window is 30 days)");
    expect(describeCoverage(0, 30)).toBe("No data yet");
    expect(describeCoverage(72, 30)).toBe("3.0 of 30 days have data");
    expect(describeCoverage(720, 30)).toBe("Full 30 days of data");
  });
});
