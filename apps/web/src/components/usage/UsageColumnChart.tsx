"use client";

import { useMemo, useState } from "react";
import { formatBytes, formatVcpuHours } from "@/lib/usage-format";

/**
 * A single-series daily column chart.
 *
 * Per the charting rules this codebase follows: one series means no legend (the
 * title names it); columns are at most 24px with a 4px rounded top and a square
 * baseline; hairline recessive gridlines; a per-column hover/focus tooltip where
 * the value leads; and a table view so no value is hover-only.
 *
 * Drawn entirely in SVG — attributes, not inline CSS — so the dynamic geometry
 * needs no style props. The series colour (#4f8a2f) is a darker step of the
 * Jongo green: the brand green itself is 2.45:1 on white and fails the 3:1
 * contrast floor for marks, this step clears it.
 */

export type ChartFormat = "bytes" | "vcpu-hours";

const W = 640;
const PLOT_H = 150;
const AXIS_H = 26;
const LEFT = 58;
const RIGHT = 8;
const TOP = 12;
const H = TOP + PLOT_H + AXIS_H;

const SERIES = "#4f8a2f";
const SERIES_ACTIVE = "#3b6f22";
const GRID = "#e4e7ec";
const INK = "#101828";
const MUTED = "#667085";

function fmt(value: number, format: ChartFormat): string {
  return format === "bytes" ? formatBytes(value) : formatVcpuHours(value);
}

/** 1, 2, 2.5, 5 × 10^n — clean tick values. */
function niceMax(max: number): number {
  if (max <= 0) return 1;
  const exp = Math.floor(Math.log10(max));
  const base = 10 ** exp;
  for (const step of [1, 2, 2.5, 5, 10]) if (step * base >= max) return step * base;
  return 10 * base;
}

function dayLabel(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** Column path: square at the baseline, 4px radius on the data end. */
function columnPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h);
  const bottom = y + h;
  return `M${x},${bottom} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${bottom} Z`;
}

export default function UsageColumnChart({
  title,
  subtitle,
  format,
  points,
  days
}: {
  title: string;
  subtitle?: string;
  format: ChartFormat;
  /** Days that have data. Missing days render as empty slots, not zeros. */
  points: Array<{ day: string; value: number }>;
  days: number;
}) {
  const [active, setActive] = useState<number | null>(null);

  const series = useMemo(() => {
    // One slot per day of the window, ending today (UTC), so the x-axis is the
    // window itself and a gap in collection reads as a gap.
    const byDay = new Map(points.map((p) => [p.day, p.value]));
    const out: Array<{ day: string; value: number | null }> = [];
    const today = new Date();
    for (let i = days - 1; i >= 0; i -= 1) {
      const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
      const key = d.toISOString().slice(0, 10);
      out.push({ day: key, value: byDay.has(key) ? (byDay.get(key) as number) : null });
    }
    return out;
  }, [points, days]);

  const hasData = series.some((s) => s.value !== null && s.value > 0);
  const max = niceMax(Math.max(0, ...series.map((s) => s.value ?? 0)));
  const plotW = W - LEFT - RIGHT;
  const slot = plotW / series.length;
  const barW = Math.max(1, Math.min(24, slot - 2));
  const y = (v: number) => TOP + PLOT_H - (v / max) * PLOT_H;
  const ticks = [0, max / 2, max];
  const labelIdx = [0, Math.floor((series.length - 1) / 2), series.length - 1];

  const activePoint = active !== null ? series[active] : null;
  const tooltip = (() => {
    if (!activePoint) return null;
    const value = activePoint.value === null ? "No data" : fmt(activePoint.value, format);
    const date = dayLabel(activePoint.day);
    const width = Math.max(value.length, date.length) * 7.2 + 20;
    const cx = LEFT + slot * (active as number) + slot / 2;
    const x = Math.min(Math.max(cx - width / 2, LEFT), W - RIGHT - width);
    return { value, date, width, x };
  })();

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowRight") setActive((a) => Math.min(series.length - 1, (a ?? -1) + 1));
    else if (event.key === "ArrowLeft") setActive((a) => Math.max(0, (a ?? series.length) - 1));
    else if (event.key === "Escape") setActive(null);
    else return;
    event.preventDefault();
  };

  return (
    <article className="card">
      <h3 className="card-title m-0">{title}</h3>
      {subtitle ? <p className="card-muted mt-1 mb-0 text-[0.85rem]">{subtitle}</p> : null}

      {!hasData ? (
        <p className="card-muted mt-4 mb-1 text-[0.9rem]">No usage recorded in this window yet.</p>
      ) : (
        <div
          className="mt-3 outline-none focus-visible:ring-2 focus-visible:ring-[#4f8a2f] rounded-lg"
          tabIndex={0}
          onKeyDown={onKeyDown}
          onBlur={() => setActive(null)}
          aria-label={`${title}. Use left and right arrow keys to read each day.`}
        >
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto block" role="img" aria-label={title}>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={LEFT} x2={W - RIGHT} y1={y(t)} y2={y(t)} stroke={GRID} strokeWidth={1} />
                <text x={LEFT - 8} y={y(t) + 4} textAnchor="end" fontSize={11} fill={MUTED} className="tabular-nums">
                  {fmt(t, format)}
                </text>
              </g>
            ))}

            {series.map((s, i) => {
              const x = LEFT + slot * i + (slot - barW) / 2;
              const isActive = active === i;
              return (
                <g key={s.day}>
                  {s.value !== null && s.value > 0 ? (
                    <path
                      d={columnPath(x, y(s.value), barW, TOP + PLOT_H - y(s.value))}
                      fill={isActive ? SERIES_ACTIVE : SERIES}
                    />
                  ) : null}
                  {/* The hit target is the whole slot, not the painted column. */}
                  <rect
                    x={LEFT + slot * i}
                    y={TOP}
                    width={slot}
                    height={PLOT_H}
                    fill="transparent"
                    onPointerEnter={() => setActive(i)}
                    onPointerLeave={() => setActive((a) => (a === i ? null : a))}
                  />
                </g>
              );
            })}

            {labelIdx.map((i) => (
              <text
                key={`x-${i}`}
                x={LEFT + slot * i + slot / 2}
                y={TOP + PLOT_H + 18}
                textAnchor={i === 0 ? "start" : i === series.length - 1 ? "end" : "middle"}
                fontSize={11}
                fill={MUTED}
              >
                {dayLabel(series[i].day)}
              </text>
            ))}

            {tooltip ? (
              <g pointerEvents="none">
                <rect x={tooltip.x} y={TOP} width={tooltip.width} height={40} rx={6} fill="#ffffff" stroke="#d0d5dd" />
                <text x={tooltip.x + 10} y={TOP + 17} fontSize={12.5} fontWeight={600} fill={INK}>{tooltip.value}</text>
                <text x={tooltip.x + 10} y={TOP + 32} fontSize={11} fill={MUTED}>{tooltip.date}</text>
              </g>
            ) : null}
          </svg>
        </div>
      )}

      {hasData ? (
        <details className="mt-2">
          <summary className="cursor-pointer text-[0.82rem] text-muted">View as table</summary>
          <div className="mt-2 max-h-56 overflow-y-auto">
            <table className="w-full text-[0.82rem] tabular-nums">
              <thead>
                <tr className="text-left text-muted">
                  <th className="font-semibold py-1 pr-3">Day</th>
                  <th className="font-semibold py-1 text-right">{title}</th>
                </tr>
              </thead>
              <tbody>
                {series.filter((s) => s.value !== null).map((s) => (
                  <tr key={s.day} className="border-0 border-t border-solid border-border">
                    <td className="py-1 pr-3">{dayLabel(s.day)}</td>
                    <td className="py-1 text-right">{fmt(s.value as number, format)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}
    </article>
  );
}
