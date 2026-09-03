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
 *
 * ## The one trap preflight-off creates: `border` alone is invisible
 *
 * Preflight is what normally sets `border-style: solid` on every element, so
 * that Tailwind's `border` utility (which only sets border-WIDTH) produces a
 * visible line. Without preflight there is no `border-style: solid` anywhere in
 * the generated stylesheet, and `class="border border-border"` renders nothing
 * at all — width and colour are set, style stays `none`.
 *
 * So every border in this codebase must be written `border border-solid`.
 * That is why lib/public-ui.ts spells it out in each shared class string.
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
        border: "var(--border)",
        "border-strong": "var(--border-strong)",

        // The app shell's sidebar, lifted from .app-nav / .app-nav-item in
        // globals.css. Here so the public hero's dashboard preview and the real
        // sidebar cannot drift apart.
        sidebar: {
          DEFAULT: "#1e332a",
          border: "#244235",
          item: "#9cb5aa",
          "item-active": "#14231c",
          "active-border": "#f2c1d1",
          label: "#f6fbf8"
        },

        // Status chips, from .status-chip.* in globals.css.
        healthy: { bg: "#eef8e6", border: "#c7dfb3", text: "#3b6020" },
        warn: { bg: "#fff8e8", border: "#f0dcae", text: "#7a5a00" },
        danger: { bg: "#fff1f2", border: "#f3c7cb", text: "#8d2631" },

        // Public marketing surface.
        ink: "#101828",
        metric: "#14313b",
        "leaf-deep": "#16231f",
        "leaf-ink": "#28412f"
      },

      // Brand gradients live here rather than as arbitrary values scattered
      // through the markup: they appear on every public page, and a
      // `bg-[linear-gradient(180deg,#a8d287_0%,#8dc267_100%)]` repeated eleven
      // times is the duplication this config exists to prevent.
      backgroundImage: {
        "btn-primary": "linear-gradient(180deg, #a8d287 0%, #8dc267 100%)",
        "card-sheen": "linear-gradient(180deg, #ffffff 0%, #fbfcfc 100%)",
        "card-healthy": "linear-gradient(180deg, #f7fcf3 0%, #ffffff 100%)",
        "nav-active": "linear-gradient(145deg, #ffeac4 0%, #ffd6e4 100%)",
        "public-page":
          "radial-gradient(circle at 12% 18%, rgba(212, 175, 55, 0.20), transparent 36%), " +
          "radial-gradient(circle at 88% 10%, rgba(255, 47, 176, 0.12), transparent 38%), " +
          "linear-gradient(180deg, #f9faf9 0%, #eef1f1 100%)"
      },

      boxShadow: {
        card: "var(--shadow)",
        // The effective values from the LATER :root block in globals.css — the
        // one that wins.
        "card-sm": "0 1px 2px rgba(16, 24, 40, 0.06), 0 1px 3px rgba(16, 24, 40, 0.04)",
        "card-lg": "0 4px 8px rgba(16, 24, 40, 0.04), 0 12px 28px rgba(16, 24, 40, 0.08)",
        sidebar: "0 12px 28px rgba(14, 24, 20, 0.3)",
        "nav-active": "0 8px 16px rgba(0, 0, 0, 0.22)",
        featured: "0 18px 38px rgba(21, 34, 34, 0.12)"
      },

      borderRadius: {
        card: "14px"
      }
    }
  },
  plugins: []
};

export default config;
