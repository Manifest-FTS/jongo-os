import { meterState } from "@/lib/usage-format";

/**
 * A stat tile that becomes a meter once a plan limit exists.
 *
 * "25 GB / 250 GB" with a same-ramp track: the unfilled track is a light step of
 * the fill's own green, so how much is left reads across the whole bar. Near and
 * over the limit the fill changes AND a text label says so — colour is never the
 * only signal. With no limit it stays a plain stat tile rather than drawing a
 * bar against a cap that does not exist.
 *
 * SVG for the fill so the width is an attribute, not an inline style.
 */

const FILL = { ok: "#4f8a2f", warn: "#b77900", over: "#c23b3b" } as const;
const TRACK = "#e3efd9";

export default function UsageMeter({
  label,
  value,
  valueText,
  detail,
  limit,
  limitText
}: {
  label: string;
  value: number;
  valueText: string;
  detail?: string;
  limit?: number | null;
  limitText?: string;
}) {
  const { fraction, tone } = meterState(value, limit);

  return (
    <article className="card metric-card">
      <p className="metric-label m-0">{label}</p>
      <p className="mt-2 mb-0 text-[1.6rem] font-bold leading-tight text-metric">
        {valueText}
        {fraction !== null && limitText ? (
          <span className="text-[1rem] font-semibold text-muted"> / {limitText}</span>
        ) : null}
      </p>

      {fraction !== null ? (
        <>
          <svg viewBox="0 0 100 8" preserveAspectRatio="none" className="block w-full h-2 mt-3" aria-hidden>
            <rect x={0} y={0} width={100} height={8} rx={4} fill={TRACK} />
            <rect x={0} y={0} width={Math.min(100, fraction * 100)} height={8} rx={4} fill={FILL[tone]} />
          </svg>
          <p className="mt-1.5 mb-0 text-[0.8rem] text-muted">
            {Math.round(fraction * 100)}% used
            {tone === "warn" ? " · nearing the plan limit" : tone === "over" ? " · over the plan limit" : ""}
          </p>
        </>
      ) : null}

      {detail ? <p className="mt-1.5 mb-0 text-[0.82rem] text-muted">{detail}</p> : null}
    </article>
  );
}
