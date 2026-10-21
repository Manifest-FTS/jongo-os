import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { TextDecoder } from "node:util";
import { LIMITS, type JsonValue } from "../validation";

export class ImportError extends Error {
  constructor(public readonly code: string, public readonly line = 0) {
    super(`CMS import ${code}${line ? ` at physical line ${line}` : ""}.`);
    this.name = "ImportError";
  }
}
export const READER_LIMITS = Object.freeze({ file: 32 * 1024 * 1024, line: 512 * 1024, records: 10000 });
const invalid = (code: string): never => { throw new ImportError(code); };

/** Strict JSON, including decoded-key uniqueness. No source modules are executed.
 * Budgets are checked during parsing, before constructing unbounded collections. */
export function parseRecord(raw: string): JsonValue {
  let at = 0, nodes = 0;
  const whitespace = () => { while (/[\x20\t\r\n]/.test(raw[at] ?? "x")) at++; };
  function string(): string {
    const start = at++;
    while (at < raw.length) {
      const c = raw[at++];
      if (at - start > LIMITS.string * 6 + 2) invalid("string_limit");
      if (c === "\\") { at++; continue; }
      if (c !== '"') continue;
      let value: string;
      try { value = JSON.parse(raw.slice(start, at)); } catch { return invalid("json"); }
      if (value.length > LIMITS.string) invalid("string_limit");
      for (let i = 0; i < value.length; i++) {
        const unit = value.charCodeAt(i);
        if (!unit || (unit >= 0xdc00 && unit <= 0xdfff)) invalid("unicode");
        if (unit >= 0xd800 && unit <= 0xdbff) {
          const next = value.charCodeAt(++i);
          if (!(next >= 0xdc00 && next <= 0xdfff)) invalid("unicode");
        }
      }
      return value;
    }
    return invalid("json");
  }
  function value(depth: number): JsonValue {
    if (++nodes > LIMITS.nodes) invalid("node_limit");
    if (depth > LIMITS.depth) invalid("depth_limit");
    whitespace();
    const c = raw[at];
    if (c === '"') return string();
    if (c === "{" || c === "[") {
      const array = c === "[", end = array ? "]" : "}";
      at++; whitespace();
      const output: JsonValue[] | Record<string, JsonValue> = array ? [] : Object.create(null);
      const seen = new Set<string>();
      let count = 0;
      if (raw[at] === end) { at++; return output; }
      while (at < raw.length) {
        if (++count > (array ? LIMITS.array : LIMITS.properties)) invalid("collection_limit");
        whitespace();
        if (array) (output as JsonValue[]).push(value(depth + 1));
        else {
          if (raw[at] !== '"') invalid("json");
          const key = string();
          if (["__proto__", "constructor", "prototype"].includes(key)) invalid("unsafe_key");
          if (seen.has(key)) invalid("duplicate_key");
          seen.add(key); whitespace();
          if (raw[at++] !== ":") invalid("json");
          (output as Record<string, JsonValue>)[key] = value(depth + 1);
        }
        whitespace();
        if (raw[at] === end) { at++; return output; }
        if (raw[at++] !== ",") invalid("json");
      }
      return invalid("json");
    }
    for (const [token, result] of [["true", true], ["false", false], ["null", null]] as const) {
      if (raw.startsWith(token, at)) { at += token.length; return result; }
    }
    const token = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(raw.slice(at));
    if (!token) return invalid("json");
    at += token[0].length;
    const number = Number(token[0]);
    if (!Number.isFinite(number) || (Number.isInteger(number) && !Number.isSafeInteger(number))) invalid("number");
    return number;
  }
  const output = value(0); whitespace();
  if (at !== raw.length) invalid("json");
  return output;
}

export type SourceRecord = { raw: string; value: JsonValue; line: number; offset: number; sha256: string };
export type Snapshot = { sha256: string; bytes: number; records: number; blanks: number };
export const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/** Fixed diagnostics only: never echo a supplied hash, path or source content. */
export function assertReviewedSnapshot(expected: unknown, actual?: string): string {
  if (typeof expected !== "string" || expected.length !== 64 || !/^[0-9a-f]+$/i.test(expected)) throw new ImportError("snapshot_confirmation");
  const normalized = expected.toLowerCase();
  if (actual !== undefined && normalized !== actual) throw new ImportError("snapshot_confirmation");
  return normalized;
}

/** Opens read-only, pins one regular file descriptor, hashes original bytes.
 * Fixed read buffer + fixed line buffer; no readline/unbounded concatenation. */
export async function readNdjson(file: string, visit: (record: SourceRecord) => void | Promise<void>): Promise<Snapshot> {
  let handle;
  try { handle = await open(file, "r"); } catch { throw new ImportError("source_unavailable"); }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > READER_LIMITS.file) throw new ImportError("file_limit");
    const buffer = Buffer.alloc(64 * 1024), pending = Buffer.alloc(READER_LIMITS.line);
    const hash = createHash("sha256");
    let used = 0, bytes = 0, line = 0, offset = 0, records = 0, blanks = 0;
    async function consume(): Promise<void> {
      line++;
      let data = pending.subarray(0, used);
      if (line === 1 && data.subarray(0, 3).equals(Buffer.from([239, 187, 191]))) data = data.subarray(3);
      // CR is part of the CRLF delimiter, never the raw JSON record.
      if (data[data.length - 1] === 13) data = data.subarray(0, -1);
      let raw: string;
      try { raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data); }
      catch { throw new ImportError("utf8", line); }
      if (raw.includes("\ufeff")) throw new ImportError("bom", line);
      if (/^[\x20\t\r]*$/.test(raw)) { blanks++; return; }
      if (++records > READER_LIMITS.records) throw new ImportError("record_limit", line);
      let value: JsonValue;
      try { value = parseRecord(raw); }
      catch (error) { throw new ImportError(error instanceof ImportError ? error.code : "json", line); }
      await visit({ raw, value, line, offset, sha256: sha256(data) });
    }
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      bytes += bytesRead;
      if (bytes > READER_LIMITS.file) throw new ImportError("file_limit");
      hash.update(buffer.subarray(0, bytesRead));
      for (let i = 0; i < bytesRead; i++) {
        if (buffer[i] === 10) { await consume(); offset += used + 1; used = 0; }
        else {
          if (used === pending.length) throw new ImportError("line_limit", line + 1);
          pending[used++] = buffer[i];
        }
      }
    }
    if (used) await consume();
    const after = await handle.stat();
    const pathAfter = await stat(file);
    if (before.dev !== pathAfter.dev || before.ino !== pathAfter.ino || before.ctimeMs !== pathAfter.ctimeMs ||
      before.size !== bytes || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new ImportError("source_changed");
    return { sha256: hash.digest("hex"), bytes, records, blanks };
  } catch (error) {
    if (error instanceof ImportError) throw error;
    throw new ImportError("source_unavailable");
  } finally { await handle.close(); }
}