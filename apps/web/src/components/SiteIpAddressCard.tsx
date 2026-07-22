"use client";

import { useState } from "react";
import { CopyIcon } from "@/components/JongoIcons";
import { COPY_MESSAGES } from "@/lib/ui/copy-messages";
import { showErrorToast, showSuccessToast } from "@/lib/ui/toast";

type Props = {
  ipAddress: string | null;
  countryName: string;
};

function UnitedStatesFlagMark() {
  return (
    <svg viewBox="0 0 28 20" width="28" height="20" aria-hidden="true">
      <rect width="28" height="20" rx="2" fill="#d58d96" />
      <rect y="2" width="28" height="2" fill="#ffffff" />
      <rect y="6" width="28" height="2" fill="#ffffff" />
      <rect y="10" width="28" height="2" fill="#ffffff" />
      <rect y="14" width="28" height="2" fill="#ffffff" />
      <rect y="18" width="28" height="2" fill="#ffffff" />
      <rect width="12" height="10" rx="1" fill="#7e8eb8" />
      <circle cx="2" cy="2" r="0.55" fill="#ffffff" />
      <circle cx="4.8" cy="2" r="0.55" fill="#ffffff" />
      <circle cx="7.6" cy="2" r="0.55" fill="#ffffff" />
      <circle cx="10.4" cy="2" r="0.55" fill="#ffffff" />
      <circle cx="3.4" cy="4" r="0.55" fill="#ffffff" />
      <circle cx="6.2" cy="4" r="0.55" fill="#ffffff" />
      <circle cx="9" cy="4" r="0.55" fill="#ffffff" />
      <circle cx="2" cy="6" r="0.55" fill="#ffffff" />
      <circle cx="4.8" cy="6" r="0.55" fill="#ffffff" />
      <circle cx="7.6" cy="6" r="0.55" fill="#ffffff" />
      <circle cx="10.4" cy="6" r="0.55" fill="#ffffff" />
      <circle cx="3.4" cy="8" r="0.55" fill="#ffffff" />
      <circle cx="6.2" cy="8" r="0.55" fill="#ffffff" />
      <circle cx="9" cy="8" r="0.55" fill="#ffffff" />
    </svg>
  );
}

export default function SiteIpAddressCard({ ipAddress, countryName }: Props) {
  const [tooltipOpen, setTooltipOpen] = useState(false);

  async function copyIpAddress() {
    if (!ipAddress) {
      return;
    }

    try {
      await navigator.clipboard.writeText(ipAddress);
      showSuccessToast(COPY_MESSAGES.clipboardSuccess);
    } catch {
      showErrorToast(COPY_MESSAGES.clipboardError);
    }
  }

  return (
    <article className="card">
      <h3 className="card-title">IP Address</h3>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.7rem", marginTop: "0.5rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", minWidth: 0 }}>
          <span
            style={{ position: "relative", display: "inline-flex" }}
            onMouseEnter={() => setTooltipOpen(true)}
            onMouseLeave={() => setTooltipOpen(false)}
            onFocus={() => setTooltipOpen(true)}
            onBlur={() => setTooltipOpen(false)}
          >
            <span
              aria-label={`Country: ${countryName}`}
              style={{
                display: "inline-flex",
                borderRadius: "4px",
                border: "1px solid #d3d7db",
                overflow: "hidden"
              }}
            >
              <UnitedStatesFlagMark />
            </span>
            <span
              role="tooltip"
              aria-hidden={!tooltipOpen}
              style={{
                position: "absolute",
                left: "50%",
                bottom: "calc(100% + 8px)",
                transform: `translateX(-50%) translateY(${tooltipOpen ? "0" : "4px"})`,
                opacity: tooltipOpen ? 1 : 0,
                pointerEvents: "none",
                background: "#1f2a2a",
                color: "#f8fbfb",
                border: "1px solid #334141",
                borderRadius: "8px",
                padding: "0.3rem 0.45rem",
                fontSize: "0.72rem",
                whiteSpace: "nowrap",
                transition: "opacity 140ms ease-in-out, transform 140ms ease-in-out",
                boxShadow: "0 8px 20px rgba(0, 0, 0, 0.18)",
                zIndex: 20
              }}
            >
              {countryName}
            </span>
          </span>
          <p style={{ margin: 0, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {ipAddress ?? "Unavailable"}
          </p>
        </div>

        <button
          type="button"
          className="btn"
          onClick={copyIpAddress}
          disabled={!ipAddress}
          title="Copy IP address"
          aria-label="Copy IP address"
          style={{ padding: "0.3rem 0.5rem" }}
        >
          <CopyIcon className="btn-icon" />
        </button>
      </div>
    </article>
  );
}
