import React from "react";
import localFont from "next/font/local";

const wordmark = localFont({
  src: "../../fonts/josefin-sans-latin.woff2", weight: "100 700", display: "swap", variable: "--font-jongo-wordmark"
});

/** Original Jongo artwork, never the Manifest M or a recolored wordmark. */
export default function JongoBrandLockup() {
  return (
    <span className={`jongo-brand-lockup ${wordmark.variable}`} role="img" aria-label="Jongo">
      <img src="/assets/brand/jongo-logomark-color.svg" width={34} height={34} alt="" aria-hidden="true" />
      <span className="jongo-brand-wordmark" aria-hidden="true">Jongo</span>
    </span>
  );
}