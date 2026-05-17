/**
 * PendingBadge — subtle inline indicator for sections that show placeholder/static content.
 * Renders a small labeled chip with a native browser tooltip explaining the pending state.
 * Server-component compatible (no "use client" needed).
 */

type Props = {
  /** Custom tooltip text. Defaults to a generic placeholder explanation. */
  reason?: string;
};

export default function PendingBadge({ reason }: Props) {
  const tooltip =
    reason ??
    "This section will connect to live data in a future update. Content shown is a placeholder.";

  return (
    <span
      title={tooltip}
      aria-label={`Pending: ${tooltip}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.22rem",
        fontSize: "0.68rem",
        fontWeight: 600,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        color: "var(--muted)",
        background: "color-mix(in srgb, var(--surface-alt, #f4f4f4) 80%, transparent)",
        border: "1px solid var(--border, #e2e2e2)",
        borderRadius: "4px",
        padding: "0.1rem 0.38rem",
        cursor: "help",
        verticalAlign: "middle",
        lineHeight: 1.4,
        userSelect: "none",
        flexShrink: 0
      }}
    >
      <span
        aria-hidden="true"
        style={{
          display: "inline-block",
          width: "6px",
          height: "6px",
          borderRadius: "50%",
          border: "1.5px solid currentColor",
          opacity: 0.7
        }}
      />
      pending
    </span>
  );
}
