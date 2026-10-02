import { ImageResponse } from "next/og";
import { SITE_TAGLINE } from "@/lib/seo";
import { ALL_PLANS } from "@/lib/public-plans";

/**
 * The share image for every public page (link previews in Slack, X, LinkedIn,
 * iMessage, and AI answer cards). Drawn in code so it always matches the
 * current tagline and prices; no image file to keep in sync.
 */

export const alt = "Jongo: managed hosting and domains";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  const fromPrice = Math.min(...ALL_PLANS.map((plan) => plan.monthlyPrice));
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "72px 80px",
          background: "linear-gradient(135deg, #f9faf9 0%, #eef4ea 55%, #f8e9ef 100%)",
          color: "#152222",
          fontFamily: "sans-serif"
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ width: 54, height: 12, borderRadius: 6, background: "#9ec877" }} />
            <div style={{ width: 54, height: 12, borderRadius: 6, background: "#e8bb55" }} />
            <div style={{ width: 54, height: 12, borderRadius: 6, background: "#e07a7a" }} />
          </div>
          <div style={{ fontSize: 46, fontWeight: 800, letterSpacing: -1 }}>Jongo</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
          <div style={{ fontSize: 66, fontWeight: 800, lineHeight: 1.08, letterSpacing: -1.5 }}>Find your domain. We&apos;ll host it too.</div>
          <div style={{ fontSize: 32, color: "#4b5a5a" }}>{SITE_TAGLINE}</div>
        </div>
        <div style={{ display: "flex", gap: 14, fontSize: 26, color: "#2f5d3a", fontWeight: 700 }}>
          <div style={{ display: "flex", padding: "10px 20px", borderRadius: 999, background: "#e3efd9" }}>Plans from ${fromPrice}/mo</div>
          <div style={{ display: "flex", padding: "10px 20px", borderRadius: 999, background: "#e3efd9" }}>Nightly offsite backups</div>
          <div style={{ display: "flex", padding: "10px 20px", borderRadius: 999, background: "#e3efd9" }}>Free migration</div>
        </div>
      </div>
    ),
    size
  );
}
