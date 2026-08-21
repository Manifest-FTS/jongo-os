import type { Config } from "tailwindcss";

/**
 * Tailwind, added alongside the existing hand-written CSS rather than replacing
 * it.
 *
 * PREFLIGHT IS OFF, deliberately. Preflight is Tailwind's reset: it strips the
 * browser defaults from headings, lists, links and form controls. This app's
 * globals.css already styles `*`, `body`, `h1`–`h3` and `a` directly, so
 * enabling it would restyle every existing page the moment Tailwind was
 * installed — a 2,800-line stylesheet's worth of regressions in exchange for a
 * reset nothing here is asking for.
 *
 * With it off, Tailwind only ADDS utility classes. Existing markup renders
 * exactly as before, and new markup can use utilities immediately. If the old
 * CSS is ever retired, turn preflight back on in the same commit that removes
 * the element-level rules from globals.css — not before.
 */
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  corePlugins: {
    preflight: false
  },
  theme: {
    extend: {
      // Mapped to the CSS custom properties globals.css already defines, so a
      // utility and a hand-written rule cannot drift to different greens.
      colors: {
        bg: "var(--bg)",
        surface: "var(--surface)",
        "surface-alt": "var(--surface-alt)",
        text: "var(--text)",
        muted: "var(--muted)",
        accent: "var(--accent)",
        "accent-strong": "var(--accent-strong)",
        border: "var(--border)"
      },
      boxShadow: {
        card: "var(--shadow)"
      }
    }
  },
  plugins: []
};

export default config;
