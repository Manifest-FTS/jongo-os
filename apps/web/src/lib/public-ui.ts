/**
 * Tailwind class strings shared by the public marketing pages.
 *
 * These were four separate copies of the same `PRIMARY` / `SECONDARY` / `CARD`
 * inline-style objects — one each in hosting, pricing, domains and
 * domains/transfer — which is how a button ends up a slightly different green
 * on one page. One definition, imported everywhere.
 *
 * ## Why every border says `border border-solid`
 *
 * Tailwind's preflight is disabled (see tailwind.config.ts), and preflight is
 * what normally sets `border-style: solid` globally. Without it, `border` sets
 * only the WIDTH and the style stays `none`, so a `border border-border` renders
 * an invisible line — no error, no warning, just a card with no edge. Spelling
 * out `border-solid` is the whole fix; do not "tidy" it away.
 *
 * Compose with `cx`, which is just a filtered join — the point is that a caller
 * can add `px-6 py-3` to a button without redefining the button.
 */

/** Joins class names, dropping falsey ones so conditionals read cleanly. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** The three-gradient wash behind every public page. */
export const publicPage = "bg-public-page min-h-screen";

/** The standard raised panel. Matches `.card` geometry: 14px, 1px border, --shadow. */
export const card = "bg-card-sheen border border-solid border-border rounded-card shadow-card";

/** Same panel, tinted for a positive/highlighted state. */
export const cardHealthy =
  "bg-card-healthy border border-solid border-healthy-border rounded-card shadow-card";

/** Base geometry for both buttons — callers add their own padding and size. */
const buttonBase =
  "inline-flex items-center justify-center rounded-lg font-semibold leading-none no-underline";

export const btnPrimary = cx(buttonBase, "bg-btn-primary text-leaf-deep border border-solid border-transparent");

export const btnSecondary = cx(buttonBase, "bg-[#f5f8f4] text-leaf-ink border border-solid border-border");

/** The common button sizes, so padding is not re-invented per call site. */
export const btnLg = "px-[22px] py-[13px] text-[15.5px]";
export const btnMd = "px-5 py-3 text-[15px]";
export const btnSm = "px-4 py-[9.5px] text-[14.5px]";

/** A pill that states a price, a fact or a tag. */
export const pill =
  "inline-flex items-baseline gap-1.5 px-3 py-[7px] rounded-full border border-solid border-border bg-surface text-[13.5px]";

/** The amber "this is test mode / heads up" note. */
export const noticeWarn =
  "border border-solid border-warn-border bg-warn-bg text-warn-text rounded-lg";

/** A bordered row inside a card — domain rows, fact rows, list items. */
export const insetRow = "border border-solid border-border rounded-[10px]";
