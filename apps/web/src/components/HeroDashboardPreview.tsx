/**
 * A miniature of the real Jongo dashboard, for the public hero.
 *
 * ## Every value here traces back to globals.css, not to eyeballing
 *
 * The point of this panel is that someone who signs up recognises the thing
 * they saw on the homepage. That only works if it is the same design, so the
 * colours come from the `sidebar-*`, `healthy-*` and `metric` entries in
 * tailwind.config.ts, which were in turn lifted from the stylesheet the app
 * actually renders with:
 *
 *   sidebar        .app-nav          #1e332a, border #244235, shadow-sidebar
 *   nav item       .app-nav-item     #9cb5aa, radius 10px, min-height 42px
 *   active item    .is-active        bg-nav-active, border #f2c1d1, #14231c
 *   nav label      .app-nav-label    0.88rem / 600
 *   card           .card             radius 14px, 1px border, shadow-card-sm
 *   metric value   .metric-value     2rem / 700 / #14313b
 *   metric label   .metric-label     0.8rem / 700 / 0.08em / uppercase
 *   healthy chip   .status-chip      #eef8e6, border #c7dfb3, text #3b6020
 *
 * The type sizes are scaled down from those, since this is a thumbnail of a
 * full-width app; the colours and geometry are not scaled at all.
 *
 * NOTE for whoever changes the design system next: globals.css has TWO :root
 * blocks and two `.card` rules, and the LATER ones win (--border is #e4e7ec,
 * not the #dde1e1 in the first block). The Tailwind theme mirrors the effective
 * ones. If the palette moves, move it in tailwind.config.ts and both the app
 * and this preview follow.
 *
 * Presentational only — `aria-hidden`, no links, no interactivity. A screen
 * reader gets the hero's real copy instead of a fake UI.
 */

import { cx } from "@/lib/public-ui";

/** Local card: the tighter shadow, since these are thumbnails inside a panel. */
const miniCard = "bg-surface border border-solid border-border rounded-card shadow-card-sm";

const navItem =
  "flex items-center gap-[0.62rem] border border-solid border-transparent rounded-[10px] " +
  "min-h-[34px] px-[0.6rem] py-[0.42rem] text-[0.78rem] font-semibold text-sidebar-item";

const navItemActive =
  "flex items-center gap-[0.62rem] border border-solid border-sidebar-active-border rounded-[10px] " +
  "min-h-[34px] px-[0.6rem] py-[0.42rem] text-[0.78rem] font-semibold " +
  "text-sidebar-item-active bg-nav-active shadow-nav-active";

/** The sidebar glyphs, at the app's own 2px stroke weight. */
function Glyph({ d }: { d: string }) {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
      aria-hidden
    >
      <path d={d} />
    </svg>
  );
}

const NAV = [
  { label: "Dashboard", d: "M4 13h6V4H4v9Zm10 7h6v-9h-6v9ZM4 20h6v-4H4v4ZM14 8h6V4h-6v4Z", active: true },
  { label: "Apps", d: "M4 6h16M4 12h16M4 18h10" },
  { label: "Domains", d: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 0c2.5 2.4 2.5 15.6 0 18m-9-9h18" },
  { label: "Backups", d: "M4.5 6c0 1.4 3.4 2.5 7.5 2.5S19.5 7.4 19.5 6 16.1 3.5 12 3.5 4.5 4.6 4.5 6Zm0 0v12c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5V6" },
  { label: "Clients", d: "M16 19v-1.5a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4V19M9.5 9.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm11.5 9.5v-1.5a4 4 0 0 0-3-3.9" }
];

const ROWS = [
  { name: "northfield.co.uk", stack: "WordPress", detail: "2h ago" },
  { name: "app.harlow.io", stack: "Next.js", detail: "18m ago" },
  { name: "shop.brightside.com", stack: "Nuxt", detail: "4h ago" }
];

const METRICS = [
  { value: "12", label: "Apps" },
  { value: "5", label: "Clients" },
  { value: "2h", label: "Last backup" }
];

export default function HeroDashboardPreview() {
  return (
    <div
      aria-hidden
      className="grid grid-cols-[130px_minmax(0,1fr)] gap-[0.6rem] p-[0.7rem] rounded-[18px] border border-solid border-border bg-bg shadow-card-lg overflow-hidden"
    >
      {/* sidebar — .app-nav */}
      <div className="flex flex-col gap-1 px-[0.55rem] pt-[0.6rem] pb-[0.75rem] bg-sidebar border border-solid border-sidebar-border rounded-card shadow-sidebar">
        <div className="flex items-center gap-[0.4rem] px-[0.45rem] pt-[0.15rem] pb-[0.6rem]">
          <span className="w-[1.15rem] h-[1.15rem] rounded-md bg-nav-active shrink-0" />
          <span className="text-[0.82rem] font-bold text-sidebar-label tracking-[0.01em]">Jongo</span>
        </div>
        {NAV.map((item) => (
          <div key={item.label} className={item.active ? navItemActive : navItem}>
            <Glyph d={item.d} />
            <span>{item.label}</span>
          </div>
        ))}
      </div>

      {/* main column */}
      <div className="grid gap-[0.6rem] min-w-0">
        {/* topbar — .app-topbar pill */}
        <div className={cx(miniCard, "flex items-center justify-between gap-2 h-[34px] px-[0.7rem] rounded-full")}>
          <span className="text-[0.72rem] font-semibold text-ink">Dashboard</span>
          <span className="inline-flex items-center gap-[0.3rem] px-2 py-[0.2rem] rounded-full text-[0.66rem] font-semibold bg-healthy-bg border border-solid border-healthy-border text-healthy-text">
            <span className="w-[5px] h-[5px] rounded-full bg-healthy-text" />
            All healthy
          </span>
        </div>

        {/* metric strip — .metric-strip / .metric-card */}
        <div className="grid grid-cols-3 gap-2">
          {METRICS.map((metric) => (
            <div key={metric.label} className={cx(miniCard, "px-[0.55rem] py-[0.6rem]")}>
              <p className="m-0 text-[1.4rem] font-bold leading-none text-metric">{metric.value}</p>
              <p className="mt-[0.3rem] mb-0 text-[0.62rem] font-bold tracking-[0.08em] uppercase text-muted">
                {metric.label}
              </p>
            </div>
          ))}
        </div>

        {/* app list */}
        <div className={cx(miniCard, "p-[0.7rem]")}>
          <p className="mt-0 mb-2 text-[0.74rem] font-semibold text-ink">Your apps</p>
          <div className="grid gap-[0.35rem]">
            {ROWS.map((row) => (
              <div
                key={row.name}
                className="flex items-center justify-between gap-2 px-2 py-[0.42rem] border border-solid border-border rounded-[10px]"
              >
                <span className="min-w-0 grid">
                  <span className="text-[0.72rem] font-semibold text-ink overflow-hidden text-ellipsis whitespace-nowrap">
                    {row.name}
                  </span>
                  <span className="text-[0.62rem] text-muted">{row.stack}</span>
                </span>
                <span className="flex items-center gap-[0.4rem] shrink-0">
                  <span className="text-[0.62rem] text-muted">{row.detail}</span>
                  <span className="w-1.5 h-1.5 rounded-full bg-accent-strong" />
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
