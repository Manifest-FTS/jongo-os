"use client";

import React, { useState, useMemo } from "react";
import "./style-guide.css";
import {
  HOSTING_TIERS,
  SLA_TIERS,
  ALL_PLANS,
  PRICING_MATRIX_ROWS,
  PRICING_FAQ,
  type TierPlan
} from "@/lib/public-plans";
import { formatBytes, formatVcpuHours, formatCores, formatRate } from "@/lib/usage-format";

type ColorSwatch = {
  name: string;
  hex: string;
  token: string;
  usage: string;
  category: "Core Forest" | "Accents" | "Surfaces & Neutrals";
  darkText?: boolean;
};

const COLOR_SWATCHES: ColorSwatch[] = [
  // Core Forest
  {
    name: "Jongo Forest Primary",
    hex: "#1E332A",
    token: "--jongo-forest / #1e332a",
    usage: "Sidebar canvas, primary headers, operator console background",
    category: "Core Forest"
  },
  {
    name: "Midnight Forest",
    hex: "#14231C",
    token: "--jongo-forest-dark / #14231c",
    usage: "Deep background, terminal canvas, high-contrast badges",
    category: "Core Forest"
  },
  {
    name: "Forest Border",
    hex: "#244235",
    token: "--jongo-forest-border / #244235",
    usage: "Dividers, sidebar borders, console container outlines",
    category: "Core Forest"
  },
  {
    name: "Forest Hover",
    hex: "#2B4A3C",
    token: "--jongo-forest-hover / #2b4a3c",
    usage: "Sidebar link hover states, dark card hover overlays",
    category: "Core Forest"
  },

  // Accents
  {
    name: "Mint / Apple Green",
    hex: "#9EC877",
    token: "--accent / #9ec877",
    usage: "Primary CTA buttons, active environment pills, healthy badges",
    category: "Accents",
    darkText: true
  },
  {
    name: "Forest Active Green",
    hex: "#7FB45C",
    token: "--accent-strong / #7fb45c",
    usage: "Focused states, progress bars, active icons, brand accents",
    category: "Accents"
  },
  {
    name: "Privacy Emerald",
    hex: "#10B981",
    token: "--privacy-green / #10b981",
    usage: "Live status pulse, verified TLS badges, successful deploy dots",
    category: "Accents"
  },
  {
    name: "Sun Gold / Amber",
    hex: "#D4AF37",
    token: "--gold / #d4af37",
    usage: "Staging badge accents, warning alerts, micro-SLA highlights",
    category: "Accents"
  },
  {
    name: "Amber Gold",
    hex: "#FFC548",
    token: "--amber / #ffc548",
    usage: "In-progress deployments, secondary brand leaf, pending badges",
    category: "Accents",
    darkText: true
  },
  {
    name: "Pulse Magenta",
    hex: "#FF2FB0",
    token: "--magenta / #ff2fb0",
    usage: "Production deploy alerts, critical action triggers, brand flair",
    category: "Accents"
  },
  {
    name: "Coral Leaf",
    hex: "#E27479",
    token: "--coral / #e27479",
    usage: "Brand logomark base leaf, destructive warning accents",
    category: "Accents"
  },
  {
    name: "Telemetry Cyan",
    hex: "#3AF0FF",
    token: "--cyan / #3af0ff",
    usage: "Terminal logs, SSH hostnames, Docker container IDs, port badges",
    category: "Accents",
    darkText: true
  },

  // Neutrals
  {
    name: "App Canvas",
    hex: "#F4F5F5",
    token: "--bg / #f4f5f5",
    usage: "App background, main viewport backdrop",
    category: "Surfaces & Neutrals",
    darkText: true
  },
  {
    name: "Surface White",
    hex: "#FFFFFF",
    token: "--surface / #ffffff",
    usage: "Card surfaces, modals, popovers, dropdown menus",
    category: "Surfaces & Neutrals",
    darkText: true
  },
  {
    name: "Surface Subtle",
    hex: "#F8F9F9",
    token: "--surface-alt / #f8f9f9",
    usage: "Table row striping, disabled controls, specimen boxes",
    category: "Surfaces & Neutrals",
    darkText: true
  },
  {
    name: "Deep Slate Text",
    hex: "#152222",
    token: "--text / #152222",
    usage: "Headings, high-contrast labels, primary typography",
    category: "Surfaces & Neutrals"
  },
  {
    name: "Muted Text",
    hex: "#6C7778",
    token: "--muted / #6c7778",
    usage: "Timestamps, secondary descriptions, placeholder text",
    category: "Surfaces & Neutrals"
  },
  {
    name: "Hairline Border",
    hex: "#DDE1E1",
    token: "--border / #dde1e1",
    usage: "Card outlines, section dividers, input borders",
    category: "Surfaces & Neutrals",
    darkText: true
  }
];

const BRAND_DOWNLOADS = [
  {
    name: "Jongo Full Logo (Color SVG)",
    file: "/assets/brand/jongo-logo-color.svg",
    format: "SVG · Vector",
    desc: "Primary color logotype + leaf mark for light and white backgrounds"
  },
  {
    name: "Jongo Full Logo (Dark BG SVG)",
    file: "/assets/brand/jongo-logo-darkbg.svg",
    format: "SVG · Vector",
    desc: "Color logotype optimized for forest green and dark canvases"
  },
  {
    name: "Jongo Full Logo (White SVG)",
    file: "/assets/brand/jongo-logo-white.svg",
    format: "SVG · Vector",
    desc: "Monochrome pure white lockup for dark backgrounds and print"
  },
  {
    name: "Jongo Logomark (Color SVG)",
    file: "/assets/brand/jongo-logomark-color.svg",
    format: "SVG · Vector",
    desc: "Isolated 5-pill geometric leaf brand mark in multi-color"
  },
  {
    name: "Jongo Logomark (White SVG)",
    file: "/assets/brand/jongo-logomark-white.svg",
    format: "SVG · Vector",
    desc: "Isolated 5-pill geometric leaf brand mark in pure white"
  },
  {
    name: "Jongo Design Tokens (JSON)",
    file: "/assets/brand/jongo-tokens.json",
    format: "JSON · Schema v1.0",
    desc: "Color tokens, typography scales, border radii, and shadows"
  },
  {
    name: "Jongo CSS Variables (CSS)",
    file: "/assets/brand/jongo-palette.css",
    format: "CSS · :root variables",
    desc: "Copy-and-paste CSS custom properties for web applications"
  },
  {
    name: "Primary Web Logo (PNG)",
    file: "/assets/images/jongo-logo-color.png",
    format: "PNG · Raster",
    desc: "Transparent high-resolution PNG for email, docs, and raster uses"
  },
  {
    name: "Josefin Sans License",
    file: "/assets/fonts/OFL-Josefin-Sans.txt",
    format: "TXT · SIL OFL 1.1",
    desc: "Open Font License agreement for display typography"
  },
  {
    name: "Inter Font License",
    file: "/assets/fonts/OFL-Inter.txt",
    format: "TXT · SIL OFL 1.1",
    desc: "Open Font License agreement for UI & body typography"
  }
];

// Mock daily usage points for live visualization demo (30 days)
const MOCK_USAGE_DAYS = [
  { day: "2026-08-15", bytes: 14200000000, coreSeconds: 18400 },
  { day: "2026-08-16", bytes: 12100000000, coreSeconds: 15200 },
  { day: "2026-08-17", bytes: 18400000000, coreSeconds: 22100 },
  { day: "2026-08-18", bytes: 24500000000, coreSeconds: 31000 },
  { day: "2026-08-19", bytes: 21800000000, coreSeconds: 27800 },
  { day: "2026-08-20", bytes: 19500000000, coreSeconds: 24500 },
  { day: "2026-08-21", bytes: 16200000000, coreSeconds: 19800 },
  { day: "2026-08-22", bytes: 13500000000, coreSeconds: 16400 },
  { day: "2026-08-23", bytes: 11800000000, coreSeconds: 14200 },
  { day: "2026-08-24", bytes: 26400000000, coreSeconds: 34200 },
  { day: "2026-08-25", bytes: 29800000000, coreSeconds: 39500 },
  { day: "2026-08-26", bytes: 33400000000, coreSeconds: 44100 },
  { day: "2026-08-27", bytes: 31200000000, coreSeconds: 41000 },
  { day: "2026-08-28", bytes: 28500000000, coreSeconds: 36800 },
  { day: "2026-08-29", bytes: 22100000000, coreSeconds: 28400 },
  { day: "2026-08-30", bytes: 18900000000, coreSeconds: 23500 },
  { day: "2026-08-31", bytes: 34200000000, coreSeconds: 46200 },
  { day: "2026-09-01", bytes: 38100000000, coreSeconds: 51200 },
  { day: "2026-09-02", bytes: 36400000000, coreSeconds: 48900 },
  { day: "2026-09-03", bytes: 41200000000, coreSeconds: 54300 },
  { day: "2026-09-04", bytes: 39500000000, coreSeconds: 52100 },
  { day: "2026-09-05", bytes: 27400000000, coreSeconds: 35600 },
  { day: "2026-09-06", bytes: 24100000000, coreSeconds: 31200 },
  { day: "2026-09-07", bytes: 43500000000, coreSeconds: 58400 },
  { day: "2026-09-08", bytes: 46800000000, coreSeconds: 62100 },
  { day: "2026-09-09", bytes: 44200000000, coreSeconds: 59300 },
  { day: "2026-09-10", bytes: 48900000000, coreSeconds: 65400 },
  { day: "2026-09-11", bytes: 51200000000, coreSeconds: 69200 },
  { day: "2026-09-12", bytes: 47600000000, coreSeconds: 63800 },
  { day: "2026-09-13", bytes: 53400000000, coreSeconds: 71500 }
];

export default function StyleGuidePage() {
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<string>("brand");
  const [customText, setCustomText] = useState<string>("Self-Hosted Operations for Coolify");
  const [iconSearch, setIconSearch] = useState<string>("");
  const [promoteConfirmPhrase, setPromoteConfirmPhrase] = useState<string>("");
  const [promoteStatus, setPromoteStatus] = useState<"idle" | "promoting" | "success">("idle");
  const [stagingEnabled, setStagingEnabled] = useState<boolean>(true);
  const [backupScheduleEnabled, setBackupScheduleEnabled] = useState<boolean>(true);

  // Pricing & Subscription state
  const [isAnnual, setIsAnnual] = useState<boolean>(true);
  const [selectedPlanId, setSelectedPlanId] = useState<string>("pro");
  const [devHoursUsed, setDevHoursUsed] = useState<number>(1.25);
  const [extraBandwidthGb, setExtraBandwidthGb] = useState<number>(0);
  const [extraStorageGb, setExtraStorageGb] = useState<number>(0);
  const [extraDevHours, setExtraDevHours] = useState<number>(0);

  // Usage visualization state
  const [chartMetric, setChartMetric] = useState<"bytes" | "vcpu">("bytes");
  const [chartHoverIndex, setChartHoverIndex] = useState<number | null>(null);
  const [usageWindowDays, setUsageWindowDays] = useState<number>(30);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage(null);
    }, 2400);
  };

  const copyToClipboard = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast(`Copied ${label} to clipboard!`);
    } catch {
      showToast(`Failed to copy to clipboard`);
    }
  };

  const simulatePromote = () => {
    if (promoteConfirmPhrase.toLowerCase() !== "promote-to-production") {
      showToast("Please type exact confirmation phrase 'promote-to-production'");
      return;
    }
    setPromoteStatus("promoting");
    setTimeout(() => {
      setPromoteStatus("success");
      showToast("Deployment triggered with idempotency key: jongo_chk_88291a");
      setTimeout(() => {
        setPromoteStatus("idle");
        setPromoteConfirmPhrase("");
      }, 3500);
    }, 1800);
  };

  // Icon Library
  const ICONS = [
    {
      id: "server",
      name: "Server",
      svg: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="3" width="20" height="7" rx="2" />
          <rect x="2" y="14" width="20" height="7" rx="2" />
          <line x1="6" y1="6.5" x2="6.01" y2="6.5" />
          <line x1="6" y1="17.5" x2="6.01" y2="17.5" />
          <line x1="10" y1="6.5" x2="16" y2="6.5" />
          <line x1="10" y1="17.5" x2="16" y2="17.5" />
        </svg>
      )
    },
    {
      id: "database",
      name: "Database Stack",
      svg: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
          <ellipse cx="12" cy="5" rx="9" ry="3" />
          <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
          <path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3" />
        </svg>
      )
    },
    {
      id: "layers",
      name: "Layers / Stack",
      svg: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
          <polygon points="12 2 2 7 12 12 22 7 12 2" />
          <polyline points="2 17 12 22 22 17" />
          <polyline points="2 12 12 17 22 12" />
        </svg>
      )
    },
    {
      id: "rocket",
      name: "Rocket / Deploy",
      svg: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
          <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
          <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
          <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
          <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
        </svg>
      )
    },
    {
      id: "globe",
      name: "Globe / Domain",
      svg: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <line x1="2" y1="12" x2="22" y2="12" />
          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10z" />
        </svg>
      )
    },
    {
      id: "shield",
      name: "Shield / SSL",
      svg: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          <polyline points="9 12 11 14 15 10" />
        </svg>
      )
    },
    {
      id: "terminal",
      name: "Terminal / CLI",
      svg: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
          <polyline points="4 17 10 11 4 5" />
          <line x1="12" y1="19" x2="20" y2="19" />
        </svg>
      )
    },
    {
      id: "refresh",
      name: "Refresh / Sync",
      svg: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
          <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
        </svg>
      )
    },
    {
      id: "wordpress",
      name: "WordPress Mark",
      svg: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <path d="M6.8 8.2c.6 0 1 .4 1.1.9l1.6 6 1.9-6.7c.1-.4.5-.7.9-.7s.8.3.9.7l1.9 6.7 1.5-5.8c.2-.8.8-1.1 1.4-1.1" />
        </svg>
      )
    },
    {
      id: "react",
      name: "React / Next.js",
      svg: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
          <ellipse cx="12" cy="12" rx="10" ry="4.2" transform="rotate(30 12 12)" />
          <ellipse cx="12" cy="12" rx="10" ry="4.2" transform="rotate(90 12 12)" />
          <ellipse cx="12" cy="12" rx="10" ry="4.2" transform="rotate(150 12 12)" />
          <circle cx="12" cy="12" r="1.5" fill="currentColor" />
        </svg>
      )
    },
    {
      id: "backup",
      name: "Backup / Archive",
      svg: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
          <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
          <polyline points="17 21 17 13 7 13 7 21" />
          <polyline points="7 3 7 8 15 8" />
        </svg>
      )
    },
    {
      id: "check",
      name: "Checkmark / Pass",
      svg: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      )
    },
    {
      id: "copy",
      name: "Copy to Clipboard",
      svg: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )
    },
    {
      id: "download",
      name: "Download File",
      svg: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
      )
    },
    {
      id: "bell",
      name: "Bell / Notifications",
      svg: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
      )
    },
    {
      id: "users",
      name: "Users / Team",
      svg: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      )
    },
    {
      id: "settings",
      name: "Settings / Config",
      svg: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      )
    },
    {
      id: "trash",
      name: "Teardown / Delete",
      svg: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
          <polyline points="3 6 5 6 21 6" />
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        </svg>
      )
    }
  ];

  const filteredIcons = useMemo(() => {
    if (!iconSearch.trim()) return ICONS;
    return ICONS.filter((i) => i.name.toLowerCase().includes(iconSearch.toLowerCase()));
  }, [iconSearch]);

  // Selected plan lookup
  const currentPlan = ALL_PLANS.find((p) => p.id === selectedPlanId) || ALL_PLANS[1];

  // Calculate simulated overages
  const estimatedOverageTotal = useMemo(() => {
    const bwRate = currentPlan.id === "enterprise-sla" ? 0.03 : 0.05;
    const stRate = currentPlan.id === "enterprise-sla" ? 0.15 : 0.20;
    const devRate = currentPlan.id === "starter" ? 120 : currentPlan.id === "pro" ? 100 : 90;
    return extraBandwidthGb * bwRate + extraStorageGb * stRate + extraDevHours * devRate;
  }, [extraBandwidthGb, extraStorageGb, extraDevHours, currentPlan]);

  // Chart rendering geometry
  const chartPoints = MOCK_USAGE_DAYS.slice(30 - usageWindowDays);
  const maxChartValue = Math.max(
    ...chartPoints.map((p) => (chartMetric === "bytes" ? p.bytes : p.coreSeconds / 3600))
  );

  return (
    <div className="sg-root">
      {/* Toast */}
      {toastMessage && (
        <div
          style={{
            position: "fixed",
            bottom: "1.5rem",
            right: "1.5rem",
            zIndex: 9999,
            background: "#14231c",
            color: "#9ec877",
            border: "1px solid #7fb45c",
            borderRadius: "10px",
            padding: "0.75rem 1.25rem",
            boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
            fontSize: "0.88rem",
            fontWeight: 600
          }}
        >
          {toastMessage}
        </div>
      )}

      {/* GROUPED NEREUS-STYLE STICKY TOPBAR */}
      <div className="sg-nav">
        <div className="sg-nav-inner">
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
            <a href="#top" className="sg-nav-brand">
              <img src="/assets/brand/jongo-logo-darkbg.svg" alt="Jongo Logo" width={115} height={32} />
            </a>
            <span style={{ height: "20px", width: "1px", background: "#244235" }} />
            <span style={{ fontSize: "0.82rem", fontWeight: 700, color: "#9ec877", letterSpacing: "0.02em" }}>
              Brand &amp; Operations Manual
            </span>
          </div>

          {/* Grouped Pill Nav */}
          <div className="sg-nav-grouped">
            {/* Group A: Brand & Identity */}
            <div className="sg-nav-cluster">
              <span className="sg-nav-cluster-label">Brand</span>
              <a href="#brand" className={`sg-nav-pill ${activeTab === "brand" ? "active" : ""}`} onClick={() => setActiveTab("brand")}>
                01·Logo
              </a>
              <a href="#colors" className={`sg-nav-pill ${activeTab === "colors" ? "active" : ""}`} onClick={() => setActiveTab("colors")}>
                02·Palette
              </a>
              <a href="#typography" className={`sg-nav-pill ${activeTab === "typography" ? "active" : ""}`} onClick={() => setActiveTab("typography")}>
                03·Type
              </a>
            </div>

            {/* Group B: UI & Telemetry */}
            <div className="sg-nav-cluster">
              <span className="sg-nav-cluster-label">UI &amp; Ops</span>
              <a href="#components" className={`sg-nav-pill ${activeTab === "components" ? "active" : ""}`} onClick={() => setActiveTab("components")}>
                04·Kit
              </a>
              <a href="#usage" className={`sg-nav-pill ${activeTab === "usage" ? "active" : ""}`} onClick={() => setActiveTab("usage")}>
                05·Usage
              </a>
              <a href="#operations" className={`sg-nav-pill ${activeTab === "operations" ? "active" : ""}`} onClick={() => setActiveTab("operations")}>
                08·Promote
              </a>
              <a href="#icons" className={`sg-nav-pill ${activeTab === "icons" ? "active" : ""}`} onClick={() => setActiveTab("icons")}>
                09·Icons
              </a>
            </div>

            {/* Group C: Commercial */}
            <div className="sg-nav-cluster">
              <span className="sg-nav-cluster-label">Commercial</span>
              <a href="#pricing" className={`sg-nav-pill ${activeTab === "pricing" ? "active" : ""}`} onClick={() => setActiveTab("pricing")}>
                06·Pricing
              </a>
              <a href="#subscriptions" className={`sg-nav-pill ${activeTab === "subscriptions" ? "active" : ""}`} onClick={() => setActiveTab("subscriptions")}>
                07·Sub
              </a>
              <a href="#downloads" className={`sg-nav-pill ${activeTab === "downloads" ? "active" : ""}`} onClick={() => setActiveTab("downloads")}>
                10·Assets
              </a>
            </div>
          </div>

          <div className="sg-nav-actions">
            <button
              type="button"
              onClick={() => window.print()}
              className="sg-btn sg-btn-secondary sg-btn-sm no-print"
              style={{ fontSize: "0.78rem" }}
            >
              Print Manual ↗
            </button>
            <a href="/pricing" className="sg-btn sg-btn-primary sg-btn-sm">
              Pricing →
            </a>
          </div>
        </div>
      </div>

      {/* Main Container */}
      <div className="sg-container" id="top">
        {/* Hero */}
        <header className="sg-hero">
          <div className="sg-eyebrow">
            <span className="sg-eyebrow-dot" />
            Jongo Design System & Brand Guidelines
          </div>
          <h1 className="sg-hero-title">
            The Operator-Grade System for <span>Modern Deployments</span>
          </h1>
          <p className="sg-hero-lede">
            Jongo is the self-hosted operations layer for Coolify, Next.js, WordPress, databases, and managed domains. 
            This brand manual establishes our visual identity, human-readable domain standards (<code style={{ background: "#eef1f1", padding: "0.2rem 0.4rem", borderRadius: "6px" }}>[slug].mfts.link</code>), 
            transparent pricing matrix, usage telemetry data visualizations, and production-tested UI components.
          </p>

          <div className="sg-hero-stats">
            <div className="sg-stat-card">
              <span className="sg-stat-val">Starter · $45</span>
              <span className="sg-stat-lbl">2GB RAM / 250GB Egress</span>
            </div>
            <div className="sg-stat-card">
              <span className="sg-stat-val">Pro · $75</span>
              <span className="sg-stat-lbl">4GB / 3 Dev Hrs Qtr</span>
            </div>
            <div className="sg-stat-card">
              <span className="sg-stat-val">Core · $149</span>
              <span className="sg-stat-lbl">8GB / 12h Next-Day SLA</span>
            </div>
            <div className="sg-stat-card">
              <span className="sg-stat-val">Enterprise · $349</span>
              <span className="sg-stat-lbl">16GB / 4h 24/7 SLA</span>
            </div>
          </div>
        </header>

        {/* SECTION 1: LOGO SYSTEM */}
        <section className="sg-section" id="brand">
          <div className="sg-section-header">
            <div className="sg-eyebrow">01 · Visual Mark System</div>
            <h2 className="sg-section-title">Logo & Brand Lockups</h2>
            <p className="sg-section-desc">
              The Jongo mark features our signature stacked 5-pill geometric leaf design paired with modern geometric lettering. 
              Always use transparent SVG formats for crisp vector rendering at any display resolution.
            </p>
          </div>

          <div className="sg-logo-grid">
            <div className="sg-logo-card">
              <div className="sg-logo-stage light">
                <img src="/assets/brand/jongo-logo-color.svg" alt="Jongo Color Logo" width={220} height={60} />
              </div>
              <div className="sg-logo-info">
                <div>
                  <h3 className="sg-logo-title">Primary Full Logo · Color</h3>
                  <p className="sg-logo-meta">Recommended for light canvases, white cards, navigation, and documentation</p>
                </div>
                <div className="sg-logo-actions">
                  <a href="/assets/brand/jongo-logo-color.svg" download="jongo-logo-color.svg" className="sg-btn sg-btn-secondary sg-btn-sm">
                    Download SVG
                  </a>
                  <button onClick={() => copyToClipboard('<img src="/assets/brand/jongo-logo-color.svg" alt="Jongo" width="180" height="50" />', "Color Logo HTML")} className="sg-btn sg-btn-ghost sg-btn-sm">
                    Copy Tag
                  </button>
                </div>
              </div>
            </div>

            <div className="sg-logo-card">
              <div className="sg-logo-stage dark">
                <img src="/assets/brand/jongo-logo-darkbg.svg" alt="Jongo Dark BG Logo" width={220} height={60} />
              </div>
              <div className="sg-logo-info">
                <div>
                  <h3 className="sg-logo-title">Primary Full Logo · Dark BG</h3>
                  <p className="sg-logo-meta">Optimized for Forest Green headers, midnight terminal views, and dark mode</p>
                </div>
                <div className="sg-logo-actions">
                  <a href="/assets/brand/jongo-logo-darkbg.svg" download="jongo-logo-darkbg.svg" className="sg-btn sg-btn-secondary sg-btn-sm">
                    Download SVG
                  </a>
                  <button onClick={() => copyToClipboard('<img src="/assets/brand/jongo-logo-darkbg.svg" alt="Jongo" width="180" height="50" />', "Dark Logo HTML")} className="sg-btn sg-btn-ghost sg-btn-sm">
                    Copy Tag
                  </button>
                </div>
              </div>
            </div>

            <div className="sg-logo-card">
              <div className="sg-logo-stage midnight">
                <img src="/assets/brand/jongo-logo-white.svg" alt="Jongo White Logo" width={220} height={60} />
              </div>
              <div className="sg-logo-info">
                <div>
                  <h3 className="sg-logo-title">Monochrome White Lockup</h3>
                  <p className="sg-logo-meta">For single-color print, high-contrast dark badges, and embroidery</p>
                </div>
                <div className="sg-logo-actions">
                  <a href="/assets/brand/jongo-logo-white.svg" download="jongo-logo-white.svg" className="sg-btn sg-btn-secondary sg-btn-sm">
                    Download SVG
                  </a>
                  <button onClick={() => copyToClipboard('<img src="/assets/brand/jongo-logo-white.svg" alt="Jongo" width="180" height="50" />', "White Logo HTML")} className="sg-btn sg-btn-ghost sg-btn-sm">
                    Copy Tag
                  </button>
                </div>
              </div>
            </div>

            <div className="sg-logo-card">
              <div className="sg-logo-stage light">
                <img src="/assets/brand/jongo-logomark-color.svg" alt="Jongo Logomark Color" width={72} height={72} />
              </div>
              <div className="sg-logo-info">
                <div>
                  <h3 className="sg-logo-title">Standalone Logomark · Color</h3>
                  <p className="sg-logo-meta">For app icons, favicons, mobile nav, user avatars, and status badges</p>
                </div>
                <div className="sg-logo-actions">
                  <a href="/assets/brand/jongo-logomark-color.svg" download="jongo-logomark-color.svg" className="sg-btn sg-btn-secondary sg-btn-sm">
                    Download SVG
                  </a>
                  <button onClick={() => copyToClipboard('<img src="/assets/brand/jongo-logomark-color.svg" alt="Jongo Mark" width="48" height="48" />', "Logomark Tag")} className="sg-btn sg-btn-ghost sg-btn-sm">
                    Copy Tag
                  </button>
                </div>
              </div>
            </div>

            <div className="sg-logo-card">
              <div className="sg-logo-stage dark">
                <img src="/assets/brand/jongo-logomark-white.svg" alt="Jongo Logomark White" width={72} height={72} />
              </div>
              <div className="sg-logo-info">
                <div>
                  <h3 className="sg-logo-title">Standalone Logomark · White</h3>
                  <p className="sg-logo-meta">Crisp white geometric leaf for dark sidebar accents and micro-badges</p>
                </div>
                <div className="sg-logo-actions">
                  <a href="/assets/brand/jongo-logomark-white.svg" download="jongo-logomark-white.svg" className="sg-btn sg-btn-secondary sg-btn-sm">
                    Download SVG
                  </a>
                  <button onClick={() => copyToClipboard('<img src="/assets/brand/jongo-logomark-white.svg" alt="Jongo Mark" width="48" height="48" />', "White Mark Tag")} className="sg-btn sg-btn-ghost sg-btn-sm">
                    Copy Tag
                  </button>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* SECTION 2: COLOR PALETTE */}
        <section className="sg-section" id="colors">
          <div className="sg-section-header">
            <div className="sg-eyebrow">02 · Chromatic Architecture</div>
            <h2 className="sg-section-title">Color Palette & Tokens</h2>
            <p className="sg-section-desc">
              Forest Green grounds the operational interface with an engineering feel. Mint and Apple Green guide primary actions. 
              Sun Gold signals staging environments, and Telemetry Cyan highlights terminal outputs and Docker metrics.
            </p>
          </div>

          {(["Core Forest", "Accents", "Surfaces & Neutrals"] as const).map((cat) => (
            <div key={cat} style={{ marginBottom: "2rem" }}>
              <h3 style={{ fontSize: "1.1rem", fontWeight: 700, color: "#1e332a", marginBottom: "1rem" }}>{cat}</h3>
              <div className="sg-color-grid">
                {COLOR_SWATCHES.filter((s) => s.category === cat).map((swatch) => (
                  <button
                    key={swatch.name}
                    className="sg-swatch"
                    onClick={() => copyToClipboard(swatch.hex, swatch.name)}
                    aria-label={`Copy ${swatch.name} hex code`}
                  >
                    <div className="sg-swatch-color" style={{ backgroundColor: swatch.hex }}>
                      <span className="sg-swatch-copy-hint">Click to Copy</span>
                    </div>
                    <div className="sg-swatch-body">
                      <span className="sg-swatch-name">{swatch.name}</span>
                      <span className="sg-swatch-hex">{swatch.hex}</span>
                      <span className="sg-swatch-token">{swatch.token}</span>
                      <span className="sg-swatch-usage">{swatch.usage}</span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </section>

        {/* SECTION 3: TYPOGRAPHY */}
        <section className="sg-section" id="typography">
          <div className="sg-section-header">
            <div className="sg-eyebrow">03 · Typography System</div>
            <h2 className="sg-section-title">Display, Interface & Monospace</h2>
            <p className="sg-section-desc">
              Josefin Sans gives Jongo headlines and brand touchpoints a distinct geometric character. 
              Inter provides ultra-legible, ergonomic interface readability for data tables and forms. 
              Monospace anchors all domains, URLs, Docker IDs, and terminal output.
            </p>
          </div>

          <div className="sg-type-scale">
            <div className="sg-type-row">
              <div className="sg-type-label">
                Hero Display
                <span>40px / 700 · Josefin Sans</span>
              </div>
              <div style={{ fontFamily: "Josefin Sans, sans-serif", fontSize: "2.5rem", fontWeight: 700, color: "#14231c", lineHeight: 1.1 }}>
                {customText}
              </div>
            </div>

            <div className="sg-type-row">
              <div className="sg-type-label">
                Section Heading (H1)
                <span>28px / 700 · Josefin Sans</span>
              </div>
              <div style={{ fontFamily: "Josefin Sans, sans-serif", fontSize: "1.75rem", fontWeight: 700, color: "#14231c" }}>
                Production to Staging Automated Promotion
              </div>
            </div>

            <div className="sg-type-row">
              <div className="sg-type-label">
                Card Title (H2)
                <span>20px / 600 · Josefin Sans</span>
              </div>
              <div style={{ fontFamily: "Josefin Sans, sans-serif", fontSize: "1.25rem", fontWeight: 600, color: "#14231c" }}>
                Managed WordPress with MariaDB 11 & Redis
              </div>
            </div>

            <div className="sg-type-row">
              <div className="sg-type-label">
                Body Large
                <span>16px / 500 · Inter</span>
              </div>
              <div style={{ fontFamily: "Inter, sans-serif", fontSize: "1rem", color: "#4b5556", lineHeight: 1.6 }}>
                Primary domain defaults to human-readable <code style={{ fontFamily: "monospace", color: "#1e332a", fontWeight: 600 }}>[project-name].mfts.link</code> format rather than random hash strings.
              </div>
            </div>

            <div className="sg-type-row">
              <div className="sg-type-label">
                Interface Label
                <span>13px / 600 · Inter</span>
              </div>
              <div style={{ fontFamily: "Inter, sans-serif", fontSize: "0.82rem", fontWeight: 600, color: "#6c7778", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                RESTIC SNAPSHOT ID · 26H RPO FRESHNESS WINDOW
              </div>
            </div>

            <div className="sg-type-row">
              <div className="sg-type-label">
                Telemetry & Code
                <span>13px / 500 · Monospace</span>
              </div>
              <div style={{ fontFamily: "ui-monospace, Consolas, monospace", fontSize: "0.85rem", color: "#1e332a", background: "#f8f9f9", padding: "0.5rem 0.75rem", borderRadius: "6px" }}>
                curl -I https://staging-demo-app.mfts.link/api/health
              </div>
            </div>
          </div>

          <div className="sg-component-card">
            <div className="sg-component-header">
              <h3 className="sg-component-title">Interactive Font Specimen Tester</h3>
              <span className="sg-component-badge">Live Preview</span>
            </div>
            <div>
              <label style={{ display: "block", fontSize: "0.82rem", fontWeight: 600, color: "#6c7778", marginBottom: "0.4rem" }}>
                Type Custom Text to Preview:
              </label>
              <input
                type="text"
                value={customText}
                onChange={(e) => setCustomText(e.target.value)}
                style={{
                  width: "100%",
                  padding: "0.65rem 0.85rem",
                  borderRadius: "8px",
                  border: "1px solid #dde1e1",
                  fontSize: "0.95rem",
                  fontFamily: "inherit"
                }}
              />
            </div>
          </div>
        </section>

        {/* SECTION 4: CORE UI COMPONENTS */}
        <section className="sg-section" id="components">
          <div className="sg-section-header">
            <div className="sg-eyebrow">04 · Component Kit</div>
            <h2 className="sg-section-title">Buttons, Badges & Form Controls</h2>
            <p className="sg-section-desc">
              All UI components are engineered with clear pass/fail states, idempotency feedback, and high-contrast accessibility.
            </p>
          </div>

          <div className="sg-component-card">
            <div className="sg-component-header">
              <h3 className="sg-component-title">Action Triggers & Buttons</h3>
              <span className="sg-component-badge">Interactive</span>
            </div>
            <div className="sg-specimen-box">
              <button className="sg-btn sg-btn-primary" onClick={() => showToast("Primary Action Triggered")}>
                Deploy to Staging →
              </button>
              <button className="sg-btn sg-btn-forest" onClick={() => showToast("Promote Triggered")}>
                Promote to Production
              </button>
              <button className="sg-btn sg-btn-secondary" onClick={() => showToast("Backup Triggered")}>
                Trigger Manual Backup
              </button>
              <button className="sg-btn sg-btn-danger" onClick={() => showToast("Teardown Initiated")}>
                Teardown Staging
              </button>
              <button className="sg-btn sg-btn-ghost" onClick={() => showToast("View Logs")}>
                View Audit Logs
              </button>
            </div>
          </div>

          <div className="sg-component-card">
            <div className="sg-component-header">
              <h3 className="sg-component-title">Status Indicators & Badges</h3>
              <span className="sg-component-badge">Visual Feedback</span>
            </div>
            <div className="sg-specimen-box">
              <span className="sg-badge sg-badge-success">
                <span className="sg-badge-dot" /> Production · 200 OK
              </span>
              <span className="sg-badge sg-badge-warning">
                <span className="sg-badge-dot" /> Staging Environment
              </span>
              <span className="sg-badge sg-badge-info">
                <span className="sg-badge-dot" /> Deploying (attempt #1402)
              </span>
              <span className="sg-badge sg-badge-danger">
                <span className="sg-badge-dot" /> Healthcheck Degraded
              </span>
              <span className="sg-badge sg-badge-forest">
                <span className="sg-badge-dot" /> Offsite Backup Verified
              </span>
            </div>
          </div>

          <div className="sg-component-card">
            <div className="sg-component-header">
              <h3 className="sg-component-title">Human-Readable Domain Formatting</h3>
              <span className="sg-component-badge">Platform Standard</span>
            </div>
            <div className="sg-specimen-box" style={{ flexDirection: "column", alignItems: "flex-start", gap: "0.75rem" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", background: "#ffffff", padding: "0.6rem 1rem", borderRadius: "10px", border: "1px solid #dde1e1", width: "100%" }}>
                <span style={{ fontSize: "0.75rem", fontWeight: 700, color: "#10b981", background: "#ecfdf5", padding: "0.2rem 0.5rem", borderRadius: "6px" }}>PROD</span>
                <code style={{ fontSize: "0.9rem", color: "#14231c", fontWeight: 600, flex: 1 }}>client-portal.mfts.link</code>
                <button onClick={() => copyToClipboard("https://client-portal.mfts.link", "Production URL")} className="sg-btn sg-btn-ghost sg-btn-sm">
                  Copy URL
                </button>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", background: "#ffffff", padding: "0.6rem 1rem", borderRadius: "10px", border: "1px solid #dde1e1", width: "100%" }}>
                <span style={{ fontSize: "0.75rem", fontWeight: 700, color: "#d4af37", background: "#fffbeb", padding: "0.2rem 0.5rem", borderRadius: "6px" }}>STAGING</span>
                <code style={{ fontSize: "0.9rem", color: "#14231c", fontWeight: 600, flex: 1 }}>staging-client-portal.mfts.link</code>
                <button onClick={() => copyToClipboard("https://staging-client-portal.mfts.link", "Staging URL")} className="sg-btn sg-btn-ghost sg-btn-sm">
                  Copy URL
                </button>
              </div>
            </div>
          </div>
        </section>

        {/* SECTION 5: USAGE STATS & DATA VISUALIZATIONS */}
        <section className="sg-section" id="usage">
          <div className="sg-section-header">
            <div className="sg-eyebrow">05 · Telemetry & Metrics</div>
            <h2 className="sg-section-title">Usage Statistics & Data Visualizations</h2>
            <p className="sg-section-desc">
              Data visualizations follow a strict single-series, accessible, and tactile geometry. 
              Hover or click columns to inspect daily egress traffic, compute vCPU-hours, and active container loads.
            </p>
          </div>

          {/* Interactive Usage Column Chart */}
          <div className="sg-chart-container mb-6">
            <div className="sg-chart-toolbar">
              <div>
                <h3 style={{ fontSize: "1.15rem", fontWeight: 700, color: "#14231c", margin: 0 }}>
                  Daily {chartMetric === "bytes" ? "Egress Bandwidth" : "vCPU Compute Hours"}
                </h3>
                <p style={{ fontSize: "0.82rem", color: "#6c7778", margin: "0.2rem 0 0" }}>
                  Trailing {usageWindowDays} days · Hover columns for daily value inspections
                </p>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                {/* Metric toggle */}
                <div className="sg-billing-switcher" style={{ padding: "0.2rem" }}>
                  <button
                    className={`sg-billing-btn ${chartMetric === "bytes" ? "active" : ""}`}
                    onClick={() => setChartMetric("bytes")}
                    style={{ padding: "0.35rem 0.75rem", fontSize: "0.8rem" }}
                  >
                    Bandwidth (GB)
                  </button>
                  <button
                    className={`sg-billing-btn ${chartMetric === "vcpu" ? "active" : ""}`}
                    onClick={() => setChartMetric("vcpu")}
                    style={{ padding: "0.35rem 0.75rem", fontSize: "0.8rem" }}
                  >
                    Compute (vCPU-h)
                  </button>
                </div>

                {/* Window range */}
                <select
                  value={usageWindowDays}
                  onChange={(e) => setUsageWindowDays(Number(e.target.value))}
                  style={{
                    padding: "0.4rem 0.75rem",
                    borderRadius: "8px",
                    border: "1px solid #dde1e1",
                    fontSize: "0.82rem",
                    fontWeight: 600,
                    color: "#14231c",
                    background: "#ffffff"
                  }}
                >
                  <option value={14}>Last 14 days</option>
                  <option value={30}>Last 30 days</option>
                </select>
              </div>
            </div>

            {/* SVG Chart */}
            <div style={{ width: "100%", overflowX: "auto" }}>
              <svg viewBox="0 0 720 180" style={{ width: "100%", height: "auto", minWidth: "540px", display: "block" }}>
                {/* Horizontal Grid lines */}
                <line x1={60} x2={710} y1={20} y2={20} stroke="#e4e7ec" strokeWidth={1} strokeDasharray="3 3" />
                <line x1={60} x2={710} y1={80} y2={80} stroke="#e4e7ec" strokeWidth={1} strokeDasharray="3 3" />
                <line x1={60} x2={710} y1={140} y2={140} stroke="#e4e7ec" strokeWidth={1} />

                {/* Y Axis labels */}
                <text x={52} y={24} textAnchor="end" fontSize={10} fill="#667085" fontFamily="monospace">
                  {chartMetric === "bytes" ? formatBytes(maxChartValue) : `${maxChartValue.toFixed(1)} vCPU-h`}
                </text>
                <text x={52} y={84} textAnchor="end" fontSize={10} fill="#667085" fontFamily="monospace">
                  {chartMetric === "bytes" ? formatBytes(maxChartValue / 2) : `${(maxChartValue / 2).toFixed(1)} vCPU-h`}
                </text>
                <text x={52} y={144} textAnchor="end" fontSize={10} fill="#667085" fontFamily="monospace">
                  0
                </text>

                {/* Columns */}
                {chartPoints.map((pt, idx) => {
                  const val = chartMetric === "bytes" ? pt.bytes : pt.coreSeconds / 3600;
                  const colWidth = (640 / chartPoints.length) - 4;
                  const colHeight = (val / maxChartValue) * 120;
                  const x = 65 + idx * (640 / chartPoints.length);
                  const y = 140 - colHeight;
                  const isHovered = chartHoverIndex === idx;

                  return (
                    <g key={pt.day} onMouseEnter={() => setChartHoverIndex(idx)} onMouseLeave={() => setChartHoverIndex(null)}>
                      <rect
                        x={x}
                        y={y}
                        width={Math.max(4, colWidth)}
                        height={Math.max(2, colHeight)}
                        rx={3}
                        fill={isHovered ? "#3b6f22" : "#4f8a2f"}
                        style={{ cursor: "pointer", transition: "fill 0.15s ease" }}
                      />
                      {/* Transparent hit area */}
                      <rect x={x - 2} y={10} width={colWidth + 4} height={140} fill="transparent" style={{ cursor: "pointer" }} />
                    </g>
                  );
                })}

                {/* Tooltip */}
                {chartHoverIndex !== null && chartPoints[chartHoverIndex] && (
                  <g pointerEvents="none">
                    {(() => {
                      const pt = chartPoints[chartHoverIndex];
                      const valText = chartMetric === "bytes" ? formatBytes(pt.bytes) : `${(pt.coreSeconds / 3600).toFixed(2)} vCPU-h`;
                      const xPos = Math.min(Math.max(65 + chartHoverIndex * (640 / chartPoints.length) - 40, 65), 580);
                      return (
                        <>
                          <rect x={xPos} y={15} width={115} height={42} rx={6} fill="#14231c" stroke="#244235" />
                          <text x={xPos + 8} y={32} fontSize={11.5} fontWeight={700} fill="#9ec877">
                            {valText}
                          </text>
                          <text x={xPos + 8} y={47} fontSize={9.5} fill="#9cb5aa" fontFamily="monospace">
                            {pt.day}
                          </text>
                        </>
                      );
                    })()}
                  </g>
                )}
              </svg>
            </div>
          </div>

          {/* Quota & Resource Meters */}
          <div className="sg-quota-grid mb-6">
            <div className="sg-quota-card">
              <div className="sg-quota-header">
                <span>Egress Bandwidth</span>
                <span style={{ color: "#4f8a2f" }}>OK</span>
              </div>
              <div className="sg-quota-val">184.2 GB <small style={{ fontSize: "0.85rem", color: "#6c7778" }}>/ 250 GB</small></div>
              <div className="sg-quota-bar-track">
                <div className="sg-quota-bar-fill ok" style={{ width: "73.6%" }} />
              </div>
              <span style={{ fontSize: "0.75rem", color: "#6c7778" }}>74% of 250 GB Starter quota used</span>
            </div>

            <div className="sg-quota-card">
              <div className="sg-quota-header">
                <span>SSD Storage</span>
                <span style={{ color: "#d4af37" }}>WARN</span>
              </div>
              <div className="sg-quota-val">21.8 GB <small style={{ fontSize: "0.85rem", color: "#6c7778" }}>/ 25 GB</small></div>
              <div className="sg-quota-bar-track">
                <div className="sg-quota-bar-fill warn" style={{ width: "87.2%" }} />
              </div>
              <span style={{ fontSize: "0.75rem", color: "#d4af37", fontWeight: 600 }}>87% used · nearing plan threshold</span>
            </div>

            <div className="sg-quota-card">
              <div className="sg-quota-header">
                <span>Memory Allocation</span>
                <span style={{ color: "#4f8a2f" }}>OK</span>
              </div>
              <div className="sg-quota-val">1.42 GB <small style={{ fontSize: "0.85rem", color: "#6c7778" }}>/ 2.0 GB</small></div>
              <div className="sg-quota-bar-track">
                <div className="sg-quota-bar-fill ok" style={{ width: "71%" }} />
              </div>
              <span style={{ fontSize: "0.75rem", color: "#6c7778" }}>71% active container consumption</span>
            </div>

            <div className="sg-quota-card">
              <div className="sg-quota-header">
                <span>Compute vCPU</span>
                <span style={{ color: "#4f8a2f" }}>OK</span>
              </div>
              <div className="sg-quota-val">0.34 cores <small style={{ fontSize: "0.85rem", color: "#6c7778" }}>/ 1 vCPU</small></div>
              <div className="sg-quota-bar-track">
                <div className="sg-quota-bar-fill ok" style={{ width: "34%" }} />
              </div>
              <span style={{ fontSize: "0.75rem", color: "#6c7778" }}>Avg busy cores across trailing window</span>
            </div>
          </div>
        </section>

        {/* SECTION 6: PRICING PLANS & ESCALATION MATRIX */}
        <section className="sg-section" id="pricing">
          <div className="sg-section-header">
            <div className="sg-eyebrow">06 · Transparent Commercial Stack</div>
            <h2 className="sg-section-title">Transparent Pricing Matrix</h2>
            <p className="sg-section-desc">
              Two transparent cloud hosting tiers and two high-assurance managed SLA tiers. All plans include 
              unlimited projects, automated staging, wildcard SSL, daily offsite backups, and zero per-seat fees.
            </p>

            {/* Monthly / Yearly Toggle */}
            <div style={{ marginTop: "1.5rem", display: "flex", alignItems: "center", gap: "1rem" }}>
              <div className="sg-billing-switcher">
                <button
                  className={`sg-billing-btn ${!isAnnual ? "active" : ""}`}
                  onClick={() => setIsAnnual(false)}
                >
                  Monthly Billing
                </button>
                <button
                  className={`sg-billing-btn ${isAnnual ? "active" : ""}`}
                  onClick={() => setIsAnnual(true)}
                >
                  Yearly Billing
                </button>
              </div>
              {isAnnual && (
                <span className="sg-discount-tag">
                  🎉 Save 2 Months (~20% off annual plans)
                </span>
              )}
            </div>
          </div>

          {/* Hosting Tiers Subheading */}
          <div style={{ marginBottom: "1.5rem" }}>
            <span style={{ fontSize: "0.8rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "#4f8a2f", background: "#ecfdf5", padding: "0.25rem 0.65rem", borderRadius: "9999px", border: "1px solid #a7f3d0" }}>
              Two Cloud Hosting Tiers
            </span>
          </div>

          <div className="sg-pricing-grid" style={{ marginBottom: "3rem" }}>
            {HOSTING_TIERS.map((tier) => (
              <div key={tier.id} className={`sg-plan-card ${tier.featured ? "featured" : ""}`}>
                {tier.badge && <span className="sg-plan-badge">{tier.badge}</span>}
                <div>
                  <div className="sg-plan-category">{tier.categoryLabel}</div>
                  <h3 className="sg-plan-name">{tier.name}</h3>
                  <p className="sg-plan-blurb">{tier.blurb}</p>

                  <div className="sg-plan-price-box">
                    <span className="sg-plan-price">
                      ${isAnnual ? Math.round(tier.annualPrice / 12) : tier.monthlyPrice}
                    </span>
                    <span className="sg-plan-period"> / month</span>
                    {isAnnual ? (
                      <div className="sg-plan-annual-sub">Billed annually at ${tier.annualPrice}/yr</div>
                    ) : (
                      <div style={{ fontSize: "0.78rem", color: "#6c7778", marginTop: "0.2rem" }}>Billed monthly, no lock-in</div>
                    )}
                  </div>

                  <div className="sg-plan-compute-box">
                    <strong style={{ color: "#1e332a", display: "block", marginBottom: "0.25rem" }}>Compute & Bandwidth:</strong>
                    • {tier.compute.ram} · {tier.compute.vcpu}
                    <br />
                    • {tier.compute.bandwidth}
                    <br />
                    • {tier.compute.storage}
                    <div style={{ marginTop: "0.5rem", paddingTop: "0.4rem", borderTop: "1px solid #dde1e1" }}>
                      <strong>Support:</strong> {tier.supportSla}
                      <br />
                      <strong>Dev Time:</strong> {tier.devHours}
                    </div>
                  </div>

                  <ul className="sg-plan-features-list">
                    {tier.features.map((feat) => (
                      <li key={feat} className="sg-plan-feature-item">
                        <span className="sg-plan-feature-icon">✓</span>
                        <span>{feat}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                <div>
                  <button
                    onClick={() => {
                      setSelectedPlanId(tier.id);
                      showToast(`Selected ${tier.name}`);
                    }}
                    className={`sg-btn ${tier.featured ? "sg-btn-primary" : "sg-btn-forest"}`}
                    style={{ width: "100%", justifyContent: "center" }}
                  >
                    {selectedPlanId === tier.id ? "✓ Current Selection" : `Choose ${tier.name}`}
                  </button>

                  <div className="sg-plan-overage-footer">
                    Overages: {tier.overageRates.bandwidth} egress · {tier.overageRates.storage} storage · {tier.overageRates.adHocDev} dev
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* SLA Tiers Subheading */}
          <div style={{ marginBottom: "1.5rem" }}>
            <span style={{ fontSize: "0.8rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "#d4af37", background: "#fffbeb", padding: "0.25rem 0.65rem", borderRadius: "9999px", border: "1px solid #fde68a" }}>
              Two Managed SLA & Enterprise Tiers
            </span>
          </div>

          <div className="sg-pricing-grid" style={{ marginBottom: "3.5rem" }}>
            {SLA_TIERS.map((tier) => (
              <div key={tier.id} className={`sg-plan-card ${tier.featured ? "featured" : ""}`}>
                {tier.badge && <span className="sg-plan-badge" style={{ background: "#1e332a" }}>{tier.badge}</span>}
                <div>
                  <div className="sg-plan-category" style={{ color: "#d4af37" }}>{tier.categoryLabel}</div>
                  <h3 className="sg-plan-name">{tier.name}</h3>
                  <p className="sg-plan-blurb">{tier.blurb}</p>

                  <div className="sg-plan-price-box">
                    <span className="sg-plan-price">
                      ${isAnnual ? Math.round(tier.annualPrice / 12) : tier.monthlyPrice}
                    </span>
                    <span className="sg-plan-period"> / month</span>
                    {isAnnual ? (
                      <div className="sg-plan-annual-sub">Billed annually at ${tier.annualPrice}/yr</div>
                    ) : (
                      <div style={{ fontSize: "0.78rem", color: "#6c7778", marginTop: "0.2rem" }}>Billed monthly, no lock-in</div>
                    )}
                  </div>

                  <div className="sg-plan-compute-box">
                    <strong style={{ color: "#1e332a", display: "block", marginBottom: "0.25rem" }}>Compute & Bandwidth:</strong>
                    • {tier.compute.ram} · {tier.compute.vcpu}
                    <br />
                    • {tier.compute.bandwidth}
                    <br />
                    • {tier.compute.storage}
                    <div style={{ marginTop: "0.5rem", paddingTop: "0.4rem", borderTop: "1px solid #dde1e1" }}>
                      <strong>Support SLA:</strong> {tier.supportSla}
                      <br />
                      <strong>Included Dev:</strong> {tier.devHours}
                      {tier.uptimeGuarantee && (
                        <>
                          <br />
                          <strong>Uptime:</strong> {tier.uptimeGuarantee}
                        </>
                      )}
                    </div>
                  </div>

                  <ul className="sg-plan-features-list">
                    {tier.features.map((feat) => (
                      <li key={feat} className="sg-plan-feature-item">
                        <span className="sg-plan-feature-icon">✓</span>
                        <span>{feat}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                <div>
                  <button
                    onClick={() => {
                      setSelectedPlanId(tier.id);
                      showToast(`Selected ${tier.name}`);
                    }}
                    className={`sg-btn ${tier.featured ? "sg-btn-primary" : "sg-btn-forest"}`}
                    style={{ width: "100%", justifyContent: "center" }}
                  >
                    {selectedPlanId === tier.id ? "✓ Current Selection" : `Choose ${tier.name}`}
                  </button>

                  <div className="sg-plan-overage-footer">
                    Overages: {tier.overageRates.bandwidth} egress · {tier.overageRates.storage} storage · {tier.overageRates.adHocDev} dev
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* SECTION 5.3: JONGO USAGE & ESCALATION MATRIX TABLE */}
          <div>
            <h3 style={{ fontSize: "1.4rem", fontWeight: 700, color: "#14231c", marginBottom: "0.5rem" }}>
              Jongo Usage & Escalation Matrix
            </h3>
            <p style={{ fontSize: "0.9rem", color: "#6c7778", marginBottom: "1.25rem" }}>
              How system usage, allocations, developer time, SLAs, and overage rates apply across all four plans:
            </p>

            <div className="sg-matrix-wrapper">
              <table className="sg-matrix-table">
                <thead>
                  <tr>
                    <th className="sg-matrix-th" style={{ width: "24%" }}>Metric / Service</th>
                    <th className="sg-matrix-th" style={{ width: "19%" }}>Starter Cloud</th>
                    <th className="sg-matrix-th sg-matrix-col-featured" style={{ width: "19%" }}>Pro Cloud</th>
                    <th className="sg-matrix-th" style={{ width: "19%" }}>Core SLA</th>
                    <th className="sg-matrix-th" style={{ width: "19%" }}>Enterprise SLA</th>
                  </tr>
                </thead>
                <tbody>
                  {PRICING_MATRIX_ROWS.map((row) => (
                    <tr key={row.metric} style={{ background: row.highlight ? "#fcfdfb" : "transparent" }}>
                      <td>
                        <span className="sg-matrix-row-title">{row.metric}</span>
                        <span className="sg-matrix-category-tag">{row.category}</span>
                      </td>
                      <td>{row.starter}</td>
                      <td className="sg-matrix-col-featured">{row.pro}</td>
                      <td>{row.coreSla}</td>
                      <td>{row.enterpriseSla}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        {/* SECTION 7: SUBSCRIPTION ELEMENTS UI/UX */}
        <section className="sg-section" id="subscriptions">
          <div className="sg-section-header">
            <div className="sg-eyebrow">07 · Subscription UX</div>
            <h2 className="sg-section-title">Subscription Management & Dev Hours</h2>
            <p className="sg-section-desc">
              Dedicated components for client subscription visibility, included developer time tracking, and transparent overage estimation.
            </p>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: "1.5rem", marginBottom: "2rem" }}>
            {/* Active Subscription Status Card */}
            <div className="sg-component-card">
              <div className="sg-component-header">
                <div>
                  <span style={{ fontSize: "0.75rem", fontWeight: 700, color: "#10b981", textTransform: "uppercase" }}>Active Subscription</span>
                  <h3 className="sg-component-title" style={{ marginTop: "0.2rem" }}>{currentPlan.name}</h3>
                </div>
                <span className="sg-badge sg-badge-success">
                  <span className="sg-badge-dot" /> Auto-Renew Active
                </span>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem", fontSize: "0.85rem" }}>
                <div>
                  <span style={{ color: "#6c7778", display: "block" }}>Billing Cadence</span>
                  <strong style={{ color: "#14231c" }}>{isAnnual ? `Annual ($${currentPlan.annualPrice}/yr)` : `Monthly ($${currentPlan.monthlyPrice}/mo)`}</strong>
                </div>
                <div>
                  <span style={{ color: "#6c7778", display: "block" }}>Next Invoice Date</span>
                  <strong style={{ color: "#14231c" }}>Oct 1, 2026</strong>
                </div>
                <div>
                  <span style={{ color: "#6c7778", display: "block" }}>Payment Method</span>
                  <strong style={{ color: "#14231c" }}>Visa •••• 4242</strong>
                </div>
                <div>
                  <span style={{ color: "#6c7778", display: "block" }}>SLA Response Window</span>
                  <strong style={{ color: "#4f8a2f" }}>{currentPlan.supportSla}</strong>
                </div>
              </div>

              <div style={{ display: "flex", gap: "0.75rem", marginTop: "0.5rem" }}>
                <button className="sg-btn sg-btn-secondary sg-btn-sm" onClick={() => showToast("Downloading itemized invoice PDF...")}>
                  Download Invoice PDF
                </button>
                <button className="sg-btn sg-btn-ghost sg-btn-sm" onClick={() => showToast("Opening plan upgrade drawer...")}>
                  Change Tier →
                </button>
              </div>
            </div>

            {/* Dev Hours Allocation Gauge */}
            <div className="sg-dev-gauge-card">
              <div className="sg-dev-gauge-header">
                <div>
                  <span style={{ fontSize: "0.72rem", fontWeight: 700, color: "#9ec877", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                    Included Dev Hours Tracker
                  </span>
                  <h3 className="sg-dev-gauge-title">
                    {devHoursUsed} of 3.0 Hours Used
                  </h3>
                </div>
                <span className="sg-badge sg-badge-forest">Q3 2026</span>
              </div>

              <div className="sg-dev-gauge-bar-track">
                <div className="sg-dev-gauge-bar-fill" style={{ width: `${(devHoursUsed / 3) * 100}%` }} />
              </div>

              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.8rem", color: "#9cb5aa" }}>
                <span>{(3 - devHoursUsed).toFixed(2)} hours remaining</span>
                <span>Resets in 17 days (Oct 1)</span>
              </div>

              <div style={{ background: "rgba(255,255,255,0.06)", padding: "0.75rem", borderRadius: "8px", fontSize: "0.78rem", color: "#e6f3ed", lineHeight: 1.4 }}>
                <strong>Usage Policy:</strong> Light maintenance, DNS updates, plugin patching, or performance tuning. Use-it-or-lose-it quarterly cycle.
              </div>

              <button
                className="sg-btn sg-btn-primary sg-btn-sm"
                onClick={() => {
                  setDevHoursUsed((prev) => Math.min(3, prev + 0.5));
                  showToast("Simulated 0.5 hr task logged!");
                }}
                style={{ width: "100%", justifyContent: "center" }}
              >
                + Request Developer Task (0.5 hr)
              </button>
            </div>
          </div>

          {/* Interactive Overage & Escalation Calculator */}
          <div className="sg-component-card">
            <div className="sg-component-header">
              <div>
                <h3 className="sg-component-title">Predictable Overage Cost Estimator</h3>
                <p style={{ fontSize: "0.82rem", color: "#6c7778", margin: "0.2rem 0 0" }}>
                  Zero punitive surprise penalties. Slide to preview estimated cost for burst traffic, storage expansion, or extra dev hours on {currentPlan.name}.
                </p>
              </div>
              <span className="sg-component-badge">Interactive Estimator</span>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "1.5rem" }}>
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.4rem", fontSize: "0.85rem" }}>
                  <span style={{ fontWeight: 600, color: "#14231c" }}>Extra Egress Bandwidth</span>
                  <span style={{ fontFamily: "monospace", fontWeight: 700 }}>{extraBandwidthGb} GB (+${(extraBandwidthGb * (currentPlan.id === "enterprise-sla" ? 0.03 : 0.05)).toFixed(2)})</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={2000}
                  step={50}
                  value={extraBandwidthGb}
                  onChange={(e) => setExtraBandwidthGb(Number(e.target.value))}
                  style={{ width: "100%" }}
                />
                <small style={{ color: "#6c7778", fontSize: "0.75rem" }}>Rate: {currentPlan.overageRates.bandwidth}</small>
              </div>

              <div>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.4rem", fontSize: "0.85rem" }}>
                  <span style={{ fontWeight: 600, color: "#14231c" }}>Extra SSD Storage</span>
                  <span style={{ fontFamily: "monospace", fontWeight: 700 }}>{extraStorageGb} GB (+${(extraStorageGb * (currentPlan.id === "enterprise-sla" ? 0.15 : 0.20)).toFixed(2)})</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={500}
                  step={10}
                  value={extraStorageGb}
                  onChange={(e) => setExtraStorageGb(Number(e.target.value))}
                  style={{ width: "100%" }}
                />
                <small style={{ color: "#6c7778", fontSize: "0.75rem" }}>Rate: {currentPlan.overageRates.storage}</small>
              </div>

              <div>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.4rem", fontSize: "0.85rem" }}>
                  <span style={{ fontWeight: 600, color: "#14231c" }}>Ad-Hoc Dev Hours</span>
                  <span style={{ fontFamily: "monospace", fontWeight: 700 }}>{extraDevHours} hrs (+${(extraDevHours * (currentPlan.id === "starter" ? 120 : currentPlan.id === "pro" ? 100 : 90)).toFixed(2)})</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={20}
                  step={1}
                  value={extraDevHours}
                  onChange={(e) => setExtraDevHours(Number(e.target.value))}
                  style={{ width: "100%" }}
                />
                <small style={{ color: "#6c7778", fontSize: "0.75rem" }}>Rate: {currentPlan.overageRates.adHocDev}</small>
              </div>
            </div>

            <div style={{ background: "#f8f9f9", border: "1px solid #dde1e1", borderRadius: "10px", padding: "1rem", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "1rem" }}>
              <div>
                <span style={{ fontSize: "0.78rem", fontWeight: 700, color: "#6c7778", textTransform: "uppercase" }}>Estimated Total Additions</span>
                <div style={{ fontSize: "1.5rem", fontWeight: 700, color: "#1e332a" }}>+${estimatedOverageTotal.toFixed(2)} / month</div>
              </div>
              <button className="sg-btn sg-btn-secondary sg-btn-sm" onClick={() => {
                setExtraBandwidthGb(0);
                setExtraStorageGb(0);
                setExtraDevHours(0);
                showToast("Reset estimator values");
              }}>
                Reset Estimator
              </button>
            </div>
          </div>
        </section>

        {/* SECTION 8: OPERATIONS SIMULATION */}
        <section className="sg-section" id="operations">
          <div className="sg-section-header">
            <div className="sg-eyebrow">08 · Operational Patterns</div>
            <h2 className="sg-section-title">Promotion, Telemetry & Backup Workflows</h2>
            <p className="sg-section-desc">
              Jongo replaces manual SSH deployments with auditable workflows. Below are the production patterns for staging promotion, terminal telemetry, and backup verification.
            </p>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))", gap: "1.5rem" }}>
            <div className="sg-component-card">
              <div className="sg-component-header">
                <h3 className="sg-component-title">Promote Staging to Production</h3>
                <span className="sg-badge sg-badge-warning">Preflight: Passed</span>
              </div>
              <p style={{ fontSize: "0.85rem", color: "#4b5556", margin: 0, lineHeight: 1.5 }}>
                Promoting triggers an idempotent Coolify release of staging artifacts to production. Type confirmation phrase to execute:
              </p>
              <div>
                <label style={{ display: "block", fontSize: "0.78rem", fontWeight: 700, color: "#6c7778", marginBottom: "0.35rem", textTransform: "uppercase" }}>
                  Confirmation Phrase: <code style={{ color: "#e27479" }}>promote-to-production</code>
                </label>
                <input
                  type="text"
                  placeholder="promote-to-production"
                  value={promoteConfirmPhrase}
                  onChange={(e) => setPromoteConfirmPhrase(e.target.value)}
                  style={{
                    width: "100%",
                    padding: "0.6rem 0.8rem",
                    borderRadius: "8px",
                    border: "1px solid #dde1e1",
                    fontSize: "0.88rem",
                    fontFamily: "monospace"
                  }}
                />
              </div>
              <button
                className="sg-btn sg-btn-forest"
                onClick={simulatePromote}
                disabled={promoteStatus === "promoting"}
                style={{ width: "100%" }}
              >
                {promoteStatus === "promoting" ? "Triggering Deployment..." : promoteStatus === "success" ? "✓ Deployment Active!" : "Execute Promotion →"}
              </button>
            </div>

            <div className="sg-terminal">
              <div className="sg-terminal-bar">
                <div className="sg-terminal-dots">
                  <span className="sg-terminal-dot r" />
                  <span className="sg-terminal-dot y" />
                  <span className="sg-terminal-dot g" />
                </div>
                <span className="sg-terminal-title">jongo-ops · restic-b2-verify</span>
                <button
                  onClick={() => copyToClipboard("npm run ops:verify-backup -- --restore-test", "CLI Verification command")}
                  style={{ background: "transparent", border: "none", color: "#9ec877", cursor: "pointer", fontSize: "0.75rem", fontWeight: 600 }}
                >
                  Copy CMD
                </button>
              </div>
              <div className="sg-terminal-body">
                <div className="sg-t-muted"># Checking Backblaze B2 offsite snapshot freshness...</div>
                <div><span className="sg-t-cyan">→</span> B2_REPO: <span className="sg-t-green">s3:s3.us-east-005.backblazeb2.com/jongo-backups</span></div>
                <div><span className="sg-t-cyan">→</span> SNAPSHOT_ID: <span className="sg-t-gold">b2a991f8 (2.4 hours old)</span></div>
                <div><span className="sg-t-cyan">→</span> DATABASE: <span className="sg-t-green">jongo-os-prod (PostgreSQL 16) · OK</span></div>
                <div><span className="sg-t-cyan">→</span> RESTORE_DR_PROBE: <span className="sg-t-green">passed (row counts match live)</span></div>
                <div><span className="sg-t-green">✔ Status: HEALTHY · RPO 2.4h &lt; 26h threshold</span></div>
              </div>
            </div>
          </div>
        </section>

        {/* SECTION 9: ICON LIBRARY */}
        <section className="sg-section" id="icons">
          <div className="sg-section-header">
            <div className="sg-eyebrow">09 · Icon Library</div>
            <h2 className="sg-section-title">Operational SVG Iconography</h2>
            <p className="sg-section-desc">
              Pixel-aligned 24×24 SVG icons designed for high-density dashboards, container cards, and deployment telemetry. Click any icon to copy its JSX component tag.
            </p>
          </div>

          <div style={{ marginBottom: "1.5rem" }}>
            <input
              type="text"
              placeholder="Search icons (e.g., server, database, deploy, shield)..."
              value={iconSearch}
              onChange={(e) => setIconSearch(e.target.value)}
              style={{
                width: "100%",
                maxWidth: "400px",
                padding: "0.6rem 0.9rem",
                borderRadius: "8px",
                border: "1px solid #dde1e1",
                fontSize: "0.9rem"
              }}
            />
          </div>

          <div className="sg-icon-grid">
            {filteredIcons.map((icon) => (
              <div
                key={icon.id}
                className="sg-icon-tile"
                onClick={() => copyToClipboard(`<${icon.name.replace(/[^a-zA-Z]/g, "")}Icon />`, `${icon.name} Icon`)}
                title={`Click to copy <${icon.name}Icon />`}
              >
                {icon.svg}
                <span className="sg-icon-name">{icon.name}</span>
              </div>
            ))}
          </div>
        </section>

        {/* SECTION 10: DOWNLOADS HUB */}
        <section className="sg-section" id="downloads">
          <div className="sg-section-header">
            <div className="sg-eyebrow">10 · Asset Hub</div>
            <h2 className="sg-section-title">Brand Downloads & Token Packages</h2>
            <p className="sg-section-desc">
              Download official vector assets, logo packages, design tokens, and font licensing for use in external tooling, presentations, and product development.
            </p>
          </div>

          <div className="sg-download-grid">
            {BRAND_DOWNLOADS.map((item) => (
              <a key={item.file} href={item.file} download className="sg-download-card">
                <div className="sg-download-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" width={22} height={22}>
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                </div>
                <div className="sg-download-content">
                  <h3 className="sg-download-title">{item.name}</h3>
                  <p className="sg-download-meta">{item.format} · {item.desc}</p>
                </div>
              </a>
            ))}
          </div>
        </section>

        {/* FOOTER */}
        <footer className="sg-footer">
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
            <img src="/assets/brand/jongo-logomark-color.svg" alt="Jongo" width={32} height={32} />
            <div>
              <strong style={{ display: "block", fontSize: "0.95rem", color: "#14231c" }}>Jongo Platform Brand System</strong>
              <small style={{ color: "#6c7778" }}>© {new Date().getFullYear()} Manifest FTS. All rights reserved.</small>
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
            <a href="#top" className="sg-btn sg-btn-secondary sg-btn-sm">
              ↑ Back to Top
            </a>
            <a href="/pricing" className="sg-btn sg-btn-primary sg-btn-sm">
              View Transparent Pricing →
            </a>
            <a href="/" className="sg-btn sg-btn-forest sg-btn-sm">
              Launch Jongo Dashboard →
            </a>
          </div>
        </footer>
      </div>
    </div>
  );
}
