import { addFinding, childPath, finding, inspectJson, isObject, isSafeUrl, result, unknownFields, validateReference, type Finding, type JsonObject, type JsonValue, type ReferenceContext, type ValidationResult } from "./validation";

/** Finite renderer contract, not arbitrary CSS, HTML, or full NCW adapter coverage. */
export const PORTABLE_TEXT_TOKENS = {
  styles: ["normal", "h1", "h2", "h3", "h4", "blockquote", "blockquote2", "standout", "centered"],
  decorators: ["strong", "em", "underline", "strike-through", "code", "superscript", "center"],
  annotations: ["link", "buttonStyle1", "textColor"],
  colors: ["neutral", "lime", "blue", "magenta"],
  nodes: ["block", "image", "reference", "group"]
} as const;
export type PortableTextSpan = { _type: "span"; _key: string; text: string; marks: string[] };
export type PortableTextBlock = { _type: "block"; _key: string; children: (PortableTextSpan | JsonObject)[]; markDefs: JsonObject[]; style?: string; listItem?: "bullet" | "number"; level?: number };
export type PortableText = (PortableTextBlock | JsonObject)[];
const has = (list: readonly string[], value: unknown) => typeof value === "string" && list.includes(value);

function key(value: Record<string, unknown>, path: string, findings: Finding[]): void {
  if (typeof value._key !== "string" || !value._key || value._key.length > 200) addFinding(findings, finding(childPath(path, "_key"), "key", "Stable nonempty key required."));
}
function uniqueKeys(items: unknown[], path: string, findings: Finding[]): void {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    if (!isObject(item)) return;
    key(item, childPath(path, index), findings);
    if (typeof item._key === "string") {
      if (seen.has(item._key)) addFinding(findings, finding(childPath(childPath(path, index), "_key"), "duplicate_key", "Sibling keys must be unique."));
      seen.add(item._key);
    }
  });
}
/** Called only after bounded JSON inspection. Original objects/keys/order remain untouched. */
export function inspectPortableText(value: unknown, path: string, findings: Finding[], context: ReferenceContext = {}): void {
  function nodes(input: unknown, p: string): void {
    if (!Array.isArray(input)) { addFinding(findings, finding(p, "portable_text", "Expected Portable Text array.")); return; }
    uniqueKeys(input, p, findings);
    input.forEach((node, index) => visit(node, childPath(p, index), false));
  }
  function visit(value: unknown, p: string, inline: boolean): void {
    if (!isObject(value)) { addFinding(findings, finding(p, "node", "Expected typed block node.")); return; }
    key(value, p, findings);
    switch (value._type) {
      case "block": {
        if (inline) { addFinding(findings, finding(p, "inline_block", "Text blocks cannot be inline children.")); return; }
        unknownFields(value, ["_type", "_key", "style", "listItem", "level", "children", "markDefs"], p, findings);
        if (value.style !== undefined && !has(PORTABLE_TEXT_TOKENS.styles, value.style)) addFinding(findings, finding(childPath(p, "style"), "unsupported_style", "Style requires a reviewed renderer token.", true));
        if (value.listItem !== undefined && !has(["bullet", "number"], value.listItem)) addFinding(findings, finding(childPath(p, "listItem"), "list", "Unsupported list token.", true));
        if (value.level !== undefined && (!Number.isInteger(value.level) || Number(value.level) < 1 || Number(value.level) > 10 || value.listItem === undefined)) addFinding(findings, finding(childPath(p, "level"), "list_level", "List level must be 1–10 and belong to a list."));
        const definitions = new Set<string>();
        if (!Array.isArray(value.markDefs)) addFinding(findings, finding(childPath(p, "markDefs"), "mark_defs", "Expected annotation definitions array."));
        else {
          uniqueKeys(value.markDefs, childPath(p, "markDefs"), findings);
          value.markDefs.forEach((mark, i) => {
            const mp = childPath(childPath(p, "markDefs"), i);
            if (!isObject(mark)) { addFinding(findings, finding(mp, "annotation", "Expected annotation object.")); return; }
            if (typeof mark._key === "string") {
              definitions.add(mark._key);
              if (has(PORTABLE_TEXT_TOKENS.decorators, mark._key)) addFinding(findings, finding(mp, "annotation_key", "Annotation keys cannot shadow decorators."));
            }
            if (mark._type === "link" || mark._type === "buttonStyle1") {
              unknownFields(mark, ["_type", "_key", "href"], mp, findings);
              if (!isSafeUrl(mark.href)) addFinding(findings, finding(childPath(mp, "href"), "unsafe_url", "Link URL is not allowed."));
            } else if (mark._type === "textColor") {
              unknownFields(mark, ["_type", "_key", "color"], mp, findings);
              if (!has(PORTABLE_TEXT_TOKENS.colors, mark.color)) addFinding(findings, finding(childPath(mp, "color"), "color_token", "Only named color tokens are supported."));
            } else addFinding(findings, finding(mp, "unsupported_annotation", "Annotation retained privately pending adapter review.", true));
          });
        }
        if (!Array.isArray(value.children)) addFinding(findings, finding(childPath(p, "children"), "children", "Expected ordered children array."));
        else {
          uniqueKeys(value.children, childPath(p, "children"), findings);
          value.children.forEach((span, i) => {
            const sp = childPath(childPath(p, "children"), i);
            if (isObject(span) && span._type === "span") {
              unknownFields(span, ["_type", "_key", "text", "marks"], sp, findings);
              if (typeof span.text !== "string") addFinding(findings, finding(childPath(sp, "text"), "span_text", "Span text must be a string."));
              if (!Array.isArray(span.marks)) addFinding(findings, finding(childPath(sp, "marks"), "marks", "Expected marks array."));
              else span.marks.forEach((mark, mi) => {
                if (!has(PORTABLE_TEXT_TOKENS.decorators, mark) && !(typeof mark === "string" && definitions.has(mark))) addFinding(findings, finding(childPath(childPath(sp, "marks"), mi), "unknown_mark", "Mark has no supported decorator or annotation definition.", true));
              });
            } else visit(span, sp, true);
          });
        }
        break;
      }
      case "reference": validateReference(value, p, findings, [], context); break;
      case "image": {
        unknownFields(value, ["_type", "_key", "asset", "alt", "caption", "crop", "hotspot"], p, findings);
        validateReference(value.asset, childPath(p, "asset"), findings, ["sanity.imageAsset"], context);
        if (value.alt !== undefined && typeof value.alt !== "string") addFinding(findings, finding(childPath(p, "alt"), "alt", "Alt must be text."));
        if (value.caption !== undefined) {
          if (typeof value.caption !== "string") nodes(value.caption, childPath(p, "caption"));
        }
        for (const name of ["crop", "hotspot"] as const) {
          const geometry = value[name];
          if (geometry === undefined) continue;
          const fields = name === "crop" ? ["top", "bottom", "left", "right"] : ["x", "y", "width", "height"];
          if (!isObject(geometry)) { addFinding(findings, finding(childPath(p, name), "geometry", "Expected image geometry object.")); continue; }
          unknownFields(geometry, ["_type", ...fields], childPath(p, name), findings);
          if (geometry._type !== undefined && geometry._type !== `sanity.image${name === "crop" ? "Crop" : "Hotspot"}`) addFinding(findings, finding(childPath(p, name), "geometry_type", "Unexpected geometry type."));
          for (const field of fields) if (typeof geometry[field] !== "number" || Number(geometry[field]) < 0 || Number(geometry[field]) > 1) addFinding(findings, finding(childPath(childPath(p, name), field), "geometry", "Image geometry must be in [0, 1]."));
          if (name === "crop" && (Number(geometry.top) + Number(geometry.bottom) >= 1 || Number(geometry.left) + Number(geometry.right) >= 1)) addFinding(findings, finding(childPath(p, name), "crop", "Crop must leave visible image area."));
        }
        break;
      }
      case "group":
        if (inline) { addFinding(findings, finding(p, "inline_group", "Groups are block-level only.")); break; }
        unknownFields(value, ["_type", "_key", "children"], p, findings);
        nodes(value.children, childPath(p, "children"));
        break;
      case "html": case "rawHtml": case "script": case "iframe":
        addFinding(findings, finding(p, "unsafe_block", "Executable/raw HTML blocks are prohibited.")); break;
      default: addFinding(findings, finding(p, "unsupported_block", "Unknown block retained privately; no fallback renderer.", true));
    }
  }
  nodes(value, path);
}
export function validatePortableText(input: unknown, context: ReferenceContext = {}): ValidationResult<PortableText> {
  const findings = inspectJson(input);
  if (findings.length) return result(undefined, findings);
  inspectPortableText(input, "$", findings, context);
  return result(input as JsonValue, findings, findings.some((item) => item.disposition === "quarantine") ? undefined : input as PortableText);
}