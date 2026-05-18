import type { ResourceType } from "@/lib/resource-types";
import {
  DatabaseStackIcon,
  GlobeIcon,
  LayersStackIcon,
  SmartphoneIcon,
  WordPressMarkIcon
} from "@/components/JongoIcons";
import type { ComponentType, SVGProps } from "react";

type SvgIcon = ComponentType<SVGProps<SVGSVGElement>>;

const RESOURCE_TYPE_CONFIG: Record<ResourceType, { icon: SvgIcon; label: string; bg: string; fg: string; border: string }> = {
  WordPress: {
    icon: WordPressMarkIcon,
    label: "WordPress",
    bg: "#0b3d56",
    fg: "#f0fbff",
    border: "#21759b"
  },
  "Web App": {
    icon: GlobeIcon,
    label: "Web App",
    bg: "#0f3a74",
    fg: "#edf4ff",
    border: "#2f5fa3"
  },
  Database: {
    icon: DatabaseStackIcon,
    label: "Database",
    bg: "#5c2f0a",
    fg: "#fff4e6",
    border: "#b45309"
  },
  Service: {
    icon: LayersStackIcon,
    label: "Service",
    bg: "#3a3f49",
    fg: "#f5f7fb",
    border: "#6b7280"
  },
  "Mobile App": {
    icon: SmartphoneIcon,
    label: "Mobile",
    bg: "#064e3b",
    fg: "#ecfdf5",
    border: "#0f766e"
  },
  "Unknown/Other": {
    icon: LayersStackIcon,
    label: "Unknown",
    bg: "#4b5563",
    fg: "#f9fafb",
    border: "#9ca3af"
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
  const iconSize = size === "xs" ? 11 : 14;
  const Icon = config.icon;

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.3rem",
        background: config.bg,
        color: config.fg,
        paddingInline,
        paddingBlock,
        borderRadius: "999px",
        border: `1px solid ${config.border}`,
        fontSize,
        fontWeight: 650,
        letterSpacing: "0.01em",
        userSelect: "none",
        whiteSpace: "nowrap"
      }}
      title={`Resource type: ${config.label}`}
    >
      <Icon
        style={{
          width: iconSize,
          height: iconSize,
          flexShrink: 0
        }}
        aria-hidden="true"
      />
      {size !== "xs" && (
        <span>{config.label}</span>
      )}
    </span>
  );
}
