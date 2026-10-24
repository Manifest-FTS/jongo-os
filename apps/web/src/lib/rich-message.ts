/** Safe, small Markdown-like subset for announcements. Arbitrary HTML is text. */
export type RichInline =
  | { type: "text"; value: string }
  | { type: "link"; value: string; href: string }
  | { type: "strong" | "emphasis"; value: string };

export type RichBlock = RichInline[];

const INLINE_PATTERN = /\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>]+)|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*/gi;

function safeHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function inline(value: string): RichInline[] {
  const output: RichInline[] = [];
  let cursor = 0;
  for (const match of value.matchAll(INLINE_PATTERN)) {
    const index = match.index ?? 0;
    if (index > cursor) output.push({ type: "text", value: value.slice(cursor, index) });
    const [whole, linkText, markdownUrl, rawUrl, strong, emphasis] = match;
    if (markdownUrl) {
      const href = safeHttpUrl(markdownUrl);
      output.push(href ? { type: "link", value: linkText, href } : { type: "text", value: whole });
    } else if (rawUrl) {
      const trimmed = rawUrl.replace(/[.,!?;:]+$/, "");
      const href = safeHttpUrl(trimmed);
      if (href) {
        output.push({ type: "link", value: trimmed, href });
        if (trimmed.length < rawUrl.length) output.push({ type: "text", value: rawUrl.slice(trimmed.length) });
      } else output.push({ type: "text", value: whole });
    } else if (strong) output.push({ type: "strong", value: strong });
    else if (emphasis) output.push({ type: "emphasis", value: emphasis });
    cursor = index + whole.length;
  }
  if (cursor < value.length) output.push({ type: "text", value: value.slice(cursor) });
  return output;
}

export function parseRichMessage(value: string): RichBlock[] {
  return value
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n+/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => inline(block).flatMap((token, index) => {
      // Within a paragraph, retain single line breaks as explicit text tokens;
      // the React and email renderers turn them into line breaks safely.
      if (token.type !== "text" || !token.value.includes("\n")) return [token];
      return token.value.split("\n").flatMap((line, lineIndex) => [
        ...(line ? [{ type: "text" as const, value: line }] : []),
        ...(lineIndex < token.value.split("\n").length - 1 ? [{ type: "text" as const, value: "\n" }] : [])
      ]);
    }));
}

export function richMessageToPlainText(value: string): string {
  return parseRichMessage(value).map((block) => block.map((part) => {
    if (part.type === "link") return `${part.value} (${part.href})`;
    return part.value;
  }).join("")).join("\n\n");
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function richMessageToEmailHtml(value: string): string {
  return parseRichMessage(value).map((block) => {
    const content = block.map((part) => {
      if (part.type === "link") {
        return `<a href="${escapeHtml(part.href)}" style="color:#1f6f4a;text-decoration:underline;">${escapeHtml(part.value)}</a>`;
      }
      if (part.type === "strong") return `<strong>${escapeHtml(part.value)}</strong>`;
      if (part.type === "emphasis") return `<em>${escapeHtml(part.value)}</em>`;
      return escapeHtml(part.value).replace(/\n/g, "<br>");
    }).join("");
    return `<p style="margin:0 0 14px;font-family:Arial,sans-serif;font-size:14px;line-height:1.65;color:#425466;">${content}</p>`;
  }).join("");
}