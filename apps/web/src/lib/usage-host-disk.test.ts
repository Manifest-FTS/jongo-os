import { describe, expect, it } from "vitest";
import { computeRun, parseCollectorOutput } from "./usage-parse";
import { diskUsedFraction, formatDiskPercent } from "./usage-format";

const GB = 1_000_000_000;

describe("server disk, measured like df and Coolify's alert", () => {
  it("uses used / (used + available), not used / size", () => {
    // df on the reported server: 164G used, 52G avail, 226G size -> "76%".
    // used / size would say 73%; the gap is the root-reserved blocks.
    const fraction = diskUsedFraction(164 * GB, 52 * GB, 226 * GB);
    expect(formatDiskPercent(fraction)).toBe("76%");
    expect(formatDiskPercent(164 / 226)).toBe("73%");
  });

  it("falls back to used / size when available space was not reported", () => {
    expect(diskUsedFraction(50, null, 200)).toBe(0.25);
    expect(diskUsedFraction(0, null, 0)).toBe(0);
  });

  it("rounds up like df, and never shows more than 100%", () => {
    expect(formatDiskPercent(0.921)).toBe("93%");
    expect(formatDiskPercent(0.93)).toBe("93%");
    expect(formatDiskPercent(1.2)).toBe("100%");
    expect(formatDiskPercent(0)).toBe("0%");
  });
});

describe("collector host record: available disk", () => {
  const line = (extra: string) => `H\t3600\thost-a\t8\t1000\t500\t1\t2\t3\t226\t164${extra}\n`;

  it("reads df avail when reported", () => {
    const out = parseCollectorOutput(line("\t52"));
    expect(out.rejected).toEqual([]);
    expect(out.passes[0].host).toMatchObject({ diskSize: 226, diskUsed: 164, diskAvail: 52 });
  });

  it("accepts records from collectors that predate it", () => {
    const out = parseCollectorOutput(line(""));
    expect(out.rejected).toEqual([]);
    expect(out.passes[0].host?.diskAvail).toBeNull();
  });

  it("carries it into the hourly host totals", () => {
    const run = computeRun({
      output: parseCollectorOutput(line("\t52")),
      states: new Map(),
      sitesByUuid: new Map(),
      withDisk: false
    });
    expect(run?.hostIncrements[0]).toMatchObject({ diskUsedBytes: 164, diskAvailBytes: 52 });
  });
});
