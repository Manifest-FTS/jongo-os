import { Josefin_Sans } from "next/font/google";

const wordmark = Josefin_Sans({
  subsets: ["latin"], weight: "600", display: "swap", variable: "--font-jongo-wordmark"
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