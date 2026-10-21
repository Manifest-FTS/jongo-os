import { createHash } from "node:crypto";
import { marketingDtoJsonSchema } from "./marketing-contracts.schema";
import type { PublicMarketingDocument } from "./marketing-contracts";
import { inspectJson, isObject, isSafeUrl, isTimestamp } from "./validation";

export class MarketingDeliveryError extends Error {
  constructor(public readonly code: "unauthorized" | "not_found" | "unavailable") {
    super(`CMS delivery ${code}.`); this.name = "MarketingDeliveryError";
  }
}
const fail = (): never => { throw new MarketingDeliveryError("unavailable"); };
export const marketingChecksum = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
/** Bounded exact opaque token; no session/ApiToken/ops-token fallback. */
export function deliveryTokenHash(authorization: string | null): string {
  if (typeof authorization !== "string" || authorization.length > 128 ||
    !/^Bearer jcms_[A-Za-z0-9_-]{43}$/.test(authorization)) throw new MarketingDeliveryError("unauthorized");
  return marketingChecksum(authorization.slice(7));
}
type Shape = Record<string, any>;
/** Interpreter only for this code-owned finite schema; no remote refs or input schemas. */
function matches(value: unknown, schema: Shape): boolean {
  if (schema.$ref) return matches(value, (marketingDtoJsonSchema.$defs as Shape)[schema.$ref.split("/").at(-1)]);
  if (schema.oneOf) return schema.oneOf.filter((s: Shape) => matches(value, s)).length === 1;
  if ("const" in schema && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type === "string") {
    if (typeof value !== "string" || value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity) ||
      (schema.pattern && !new RegExp(schema.pattern).test(value))) return false;
    if (schema.format === "date-time" && !isTimestamp(value)) return false;
    if (schema.format === "date" && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !isTimestamp(`${value}T00:00:00Z`))) return false;
    if (schema.pattern?.includes("https") && !isSafeUrl(value)) return false;
  }
  if (schema.type === "number" || schema.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value) || (schema.type === "integer" && !Number.isInteger(value)) ||
      value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) return false;
  }
  if (schema.type === "array") return Array.isArray(value) && value.length >= (schema.minItems ?? 0) && value.every(item => matches(item, schema.items));
  if (schema.type === "object") return isObject(value) && schema.required.every((key: string) => Object.hasOwn(value, key)) &&
    Object.entries(value).every(([key, item]) => Object.hasOwn(schema.properties, key) && matches(item, schema.properties[key]));
  return true;
}
/** Strict transport validation before narrowing; never casts arbitrary DB JSON into DTOs. */
export function validateMarketingDocuments(value: unknown): asserts value is PublicMarketingDocument[] {
  if (!Array.isArray(value) || value.length > 100 || inspectJson(value).length) return fail();
  const ids = new Set<string>(), routes = new Set<string>();
  for (const item of value) {
    if (!matches(item, marketingDtoJsonSchema) || !isObject(item) || typeof item.id !== "string" || item.id.startsWith("drafts.")) fail();
    const route = `${item.kind}/${item.slug}`;
    if (ids.has(item.id) || routes.has(route)) fail();
    ids.add(item.id); routes.add(route);
    if (item.kind === "article") {
      for (const block of item.body as Array<Record<string, any>>) {
        if (block._type !== "block") continue;
        const keys = block.markDefs.map((mark: any) => mark._key);
        if (new Set(keys).size !== keys.length || block.children.some((span: any) =>
          span.marks.some((mark: string) => !["strong", "em", "code", ...keys].includes(mark)))) fail();
      }
    }
  }
}
export function parseMarketingSnapshot(snapshotText: unknown, checksum: unknown): PublicMarketingDocument[] {
  if (typeof snapshotText !== "string" || Buffer.byteLength(snapshotText, "utf8") > 1048576 ||
    typeof checksum !== "string" || !/^[a-f0-9]{64}$/.test(checksum)) return fail();
  let documents: unknown;
  try { documents = JSON.parse(snapshotText); } catch { return fail(); }
  if (JSON.stringify(documents) !== snapshotText || marketingChecksum(snapshotText) !== checksum) fail();
  validateMarketingDocuments(documents);
  return documents;
}