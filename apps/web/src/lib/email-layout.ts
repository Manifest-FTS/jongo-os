/**
 * The HTML shell for Jongo's transactional email.
 *
 * Email is not the web. The constraints that shaped this:
 *
 * - Layout is tables with `role="presentation"`. Outlook renders via Word and
 *   ignores most modern CSS, so flex/grid silently collapse to a single column.
 * - Critical styling is INLINE. Gmail strips <head><style> when a message is
 *   forwarded or clipped, so anything that must survive lives on the element.
 *   The <style> block is progressive enhancement only — dark mode and the
 *   mobile stack — never the difference between readable and broken.
 * - Every colour is a flat value with a `bgcolor` attribute behind it. Gradients
 *   are decorative and degrade to that solid fallback in Outlook.
 * - No remote images. Most clients block them by default, so an icon that
 *   carries meaning would simply not arrive; tone is carried by colour and text.
 * - A preheader is included and visually hidden. Without it the inbox preview
 *   shows whatever text comes first, which is what makes an otherwise decent
 *   email look like a system dump.
 *
 * Callers always supply a plain-text alternative too — it is the accessible
 * fallback and it materially affects deliverability.
 */

export type EmailTone = "success" | "danger" | "warning" | "info";

export type EmailDetailRow = { label: string; value: string };

export type TransactionalEmailContent = {
  /** Inbox preview line. Keep under ~90 chars; it is truncated, not wrapped. */
  preheader: string;
  badge?: { tone: EmailTone; label: string };
  title: string;
  intro?: string;
  /** Rendered as a bordered key/value panel. */
  rows?: EmailDetailRow[];
  /** A tinted box for the one thing the reader must not miss. */
  callout?: { tone: EmailTone; title?: string; body: string };
  cta?: { label: string; url: string };
  /** Small print under the divider — why they received this. */
  footnote?: string;
};

const BRAND = {
  page: "#f3f8ef",
  card: "#ffffff",
  cardBorder: "#d8e3d4",
  headerTint: "#eef8e6",
  eyebrow: "#4b6352",
  heading: "#102a1d",
  body: "#425466",
  muted: "#7b8794",
  divider: "#e6ede4",
  panel: "#f8fbf6",
  ctaBg: "#1f6f4a",
  ctaText: "#ffffff"
} as const;

const TONES: Record<EmailTone, { bg: string; text: string; border: string }> = {
  success: { bg: "#eaf6e6", text: "#1f6f4a", border: "#cbe7c0" },
  danger: { bg: "#fdecec", text: "#b3261e", border: "#f6cdcb" },
  warning: { bg: "#fff6e5", text: "#8a5a00", border: "#f0dcb0" },
  info: { bg: "#eaf1fb", text: "#1f4f8f", border: "#cbdcf5" }
};

const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`;

export function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Only http(s) links become anchors. A `javascript:` or `data:` URL in a CTA
 * would be an injection dressed as a button, and the values here can originate
 * from configuration rather than from us.
 */
function safeHref(url: string): string | null {
  const trimmed = String(url ?? "").trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

function renderBadge(badge: { tone: EmailTone; label: string }): string {
  const tone = TONES[badge.tone];
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 14px;"><tr><td bgcolor="${tone.bg}" style="background:${tone.bg};border:1px solid ${tone.border};border-radius:999px;padding:5px 12px;font-family:${FONT};font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${tone.text};">${escapeHtml(badge.label)}</td></tr></table>`;
}

function renderRows(rows: EmailDetailRow[]): string {
  const cells = rows
    .map((row, index) => {
      const borderTop = index === 0 ? "none" : `1px solid ${BRAND.divider}`;
      return [
        `<tr>`,
        `<td class="jg-row-label" style="border-top:${borderTop};padding:10px 14px;font-family:${FONT};font-size:12px;line-height:1.4;color:${BRAND.muted};white-space:nowrap;vertical-align:top;">${escapeHtml(row.label)}</td>`,
        `<td class="jg-row-value" style="border-top:${borderTop};padding:10px 14px;font-family:${FONT};font-size:13px;line-height:1.5;color:${BRAND.heading};font-weight:600;vertical-align:top;">${escapeHtml(row.value)}</td>`,
        `</tr>`
      ].join("");
    })
    .join("");

  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="${BRAND.panel}" class="jg-panel" style="width:100%;background:${BRAND.panel};border:1px solid ${BRAND.divider};border-radius:12px;border-collapse:separate;margin:0 0 18px;">${cells}</table>`;
}

function renderCallout(callout: { tone: EmailTone; title?: string; body: string }): string {
  const tone = TONES[callout.tone];
  const title = callout.title
    ? `<div style="font-family:${FONT};font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:${tone.text};margin:0 0 5px;">${escapeHtml(callout.title)}</div>`
    : "";
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="${tone.bg}" style="width:100%;background:${tone.bg};border:1px solid ${tone.border};border-left:4px solid ${tone.text};border-radius:10px;margin:0 0 18px;"><tr><td style="padding:13px 15px;">${title}<div style="font-family:${FONT};font-size:13px;line-height:1.55;color:${BRAND.heading};">${escapeHtml(callout.body)}</div></td></tr></table>`;
}

function renderCta(cta: { label: string; url: string }): string {
  const href = safeHref(cta.url);
  if (!href) return "";
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 6px;"><tr><td bgcolor="${BRAND.ctaBg}" style="background:${BRAND.ctaBg};border-radius:10px;"><a href="${escapeHtml(href)}" style="display:inline-block;padding:12px 22px;font-family:${FONT};font-size:14px;font-weight:700;line-height:1;color:${BRAND.ctaText};text-decoration:none;border-radius:10px;">${escapeHtml(cta.label)}</a></td></tr></table>`;
}

export function renderTransactionalEmail(content: TransactionalEmailContent): string {
  const ctaHref = content.cta ? safeHref(content.cta.url) : null;

  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(content.title)}</title>
<style>
  /* Enhancement only. Inline styles above are the source of truth. */
  @media (max-width:600px){
    .jg-card{width:100% !important;border-radius:0 !important;}
    .jg-pad{padding-left:18px !important;padding-right:18px !important;}
    .jg-row-label,.jg-row-value{display:block !important;width:100% !important;white-space:normal !important;}
    .jg-row-label{padding-bottom:0 !important;border-top:none !important;}
    .jg-row-value{padding-top:2px !important;border-top:none !important;}
  }
  @media (prefers-color-scheme:dark){
    .jg-body{background:#0f1512 !important;}
    .jg-card{background:#16211b !important;border-color:#2a3a31 !important;}
    .jg-header{background:#1b2a22 !important;}
    .jg-panel{background:#1b2620 !important;border-color:#2a3a31 !important;}
    .jg-heading,.jg-row-value{color:#eaf3ea !important;}
    .jg-text{color:#b3c4b8 !important;}
    .jg-muted,.jg-row-label{color:#8b9d92 !important;}
  }
</style>
</head>
<body class="jg-body" bgcolor="${BRAND.page}" style="margin:0;padding:0;background:${BRAND.page};-webkit-font-smoothing:antialiased;">
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${escapeHtml(content.preheader)}</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="${BRAND.page}" style="width:100%;background:${BRAND.page};">
<tr><td align="center" style="padding:28px 12px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" class="jg-card" bgcolor="${BRAND.card}" style="width:600px;max-width:600px;background:${BRAND.card};border:1px solid ${BRAND.cardBorder};border-radius:16px;overflow:hidden;">

  <tr><td class="jg-header jg-pad" bgcolor="${BRAND.headerTint}" style="padding:18px 28px;background:${BRAND.headerTint};background-image:linear-gradient(120deg,#eef8e6 0%,#fff6f0 55%,#f3f9ff 100%);border-bottom:1px solid ${BRAND.divider};">
    <div style="font-family:${FONT};font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:${BRAND.eyebrow};font-weight:700;">Manifest FTS</div>
    <div class="jg-heading" style="margin-top:3px;font-family:${FONT};font-size:20px;line-height:1.2;color:${BRAND.heading};font-weight:800;">Jongo</div>
  </td></tr>

  <tr><td class="jg-pad" style="padding:26px 28px 4px;">
    ${content.badge ? renderBadge(content.badge) : ""}
    <h1 class="jg-heading" style="margin:0 0 10px;font-family:${FONT};font-size:22px;line-height:1.3;color:${BRAND.heading};font-weight:700;">${escapeHtml(content.title)}</h1>
    ${content.intro ? `<p class="jg-text" style="margin:0 0 18px;font-family:${FONT};font-size:14px;line-height:1.6;color:${BRAND.body};">${escapeHtml(content.intro)}</p>` : ""}
    ${content.rows && content.rows.length > 0 ? renderRows(content.rows) : ""}
    ${content.callout ? renderCallout(content.callout) : ""}
    ${content.cta && ctaHref ? renderCta(content.cta) : ""}
  </td></tr>

  ${content.footnote || ctaHref ? `<tr><td class="jg-pad" style="padding:16px 28px 22px;">
    <div style="border-top:1px solid ${BRAND.divider};padding-top:14px;">
      ${content.footnote ? `<p class="jg-muted" style="margin:0 0 6px;font-family:${FONT};font-size:12px;line-height:1.5;color:${BRAND.muted};">${escapeHtml(content.footnote)}</p>` : ""}
      ${ctaHref ? `<p class="jg-muted" style="margin:0;font-family:${FONT};font-size:11px;line-height:1.5;color:${BRAND.muted};word-break:break-all;">Or open this link: ${escapeHtml(ctaHref)}</p>` : ""}
    </div>
  </td></tr>` : ""}

</table>
</td></tr>
</table>
</body></html>`;
}
