/**
 * The loading state for a route that has not finished rendering.
 *
 * Every page here is a server component that talks to Coolify and Postgres
 * before it can render, so navigation regularly takes a second or more. With no
 * loading state the previous page simply sat there — indistinguishable from a
 * click that did not register, which is why people click twice and end up
 * firing an action they only meant to trigger once.
 *
 * Deliberately not a full-page takeover: rendered inside the platform layout,
 * so the shell and navigation stay put and only the content region swaps. The
 * page feels like it is loading rather than like it has been thrown away.
 */
export default function Loader({
  label = "Loading",
  /** Roughly how tall the content area is, so the shell does not jump. */
  minHeight = "40vh"
}: {
  label?: string;
  minHeight?: string;
}) {
  return (
    <div
      className="loader"
      style={{ minHeight }}
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <span className="loader__spinner" aria-hidden="true" />
      {/* Visible to screen readers; the spinner alone announces nothing. */}
      <span className="loader__label">{label}…</span>
    </div>
  );
}
