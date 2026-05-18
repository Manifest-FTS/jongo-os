import type { ResourceType } from "@/lib/resource-types";

const RESOURCE_TYPE_CONFIG: Record<ResourceType, { icon: string; label: string; bg: string; fg: string }> = {
  WordPress: {
    icon: "W",
    label: "WordPress",
    bg: "#21759b",
    fg: "#ffffff"
  },
  "Web App": {
    icon: "⬡",
    label: "Web App",
    bg: "#6d28d9",
    fg: "#ffffff"
  },
  Database: {
    icon: "DB",
    label: "Database",
    bg: "#b45309",
    fg: "#ffffff"
  },
  Service: {
    icon: "⚙",
    label: "Service",
    bg: "#374151",
    fg: "#ffffff"
  },
  "Mobile App": {
    icon: "📱",
    label: "Mobile",
    bg: "#065f46",
    fg: "#ffffff"
  },
  "Unknown/Other": {
    icon: "?",
    label: "Unknown",
    bg: "#6b7280",
    fg: "#ffffff"
  }
};

export default function ResourceTypePill({
  type,
  size = "sm"
}: {
  type: ResourceType;
  size?: "sm" | "xs";
}) {
  const config = RESOURCE_TYPE_CONFIG[type] ?? RESOURCE_TYPE_CONFIG["Unknown/Other"];

  const paddingInline = size === "xs" ? "0.35rem" : "0.5rem";
  const paddingBlock = size === "xs" ? "0.15rem" : "0.25rem";
  const fontSize = size === "xs" ? "0.65rem" : "0.7rem";
  const iconSize = size === "xs" ? "0.65rem" : "0.7rem";

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.25rem",
        background: config.bg,
        color: config.fg,
        paddingInline,
        paddingBlock,
        borderRadius: "0.3rem",
        fontSize,
        fontWeight: 700,
        letterSpacing: "0.01em",
        userSelect: "none",
        whiteSpace: "nowrap"
      }}
      title={`Resource type: ${config.label}`}
    >
      <span
        style={{
          fontSize: iconSize,
          lineHeight: 1,
          fontFamily: type === "WordPress" ? "Georgia, serif" : "inherit"
        }}
        aria-hidden="true"
      >
        {config.icon}
      </span>
      {size !== "xs" && (
        <span>{config.label}</span>
      )}
    </span>
  );
}
