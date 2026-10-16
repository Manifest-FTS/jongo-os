import { BILLING_MODES, BILLING_STATUSES, getBillingDriver, type BillingClient, type BillingMode, type BillingStatus } from "./client-billing-drivers";

export { BILLING_MODES, BILLING_STATUSES } from "./client-billing-drivers";
export type { BillingDriverInterface, BillingMode, BillingStatus } from "./client-billing-drivers";

export class BillingInputError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); }
}

/** Explicit selects and DTOs: never return raw Prisma objects. */
export const CLIENT_BILLING_SELECT = {
  id: true, name: true, billingMode: true, billingStatus: true,
  billingNotes: true, bonsaiClientId: true, externalInvoiceUrl: true
} as const;

export function safeInvoiceUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048 || /[\s\\\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

export function bonsaiClientUrl(id: string | null): string | null {
  return id ? `https://app.hellobonsai.com/clients/${encodeURIComponent(id)}` : null;
}

export async function clientBillingDto(client: BillingClient) {
  const status = await getBillingDriver(client.billingMode).getClientStatus(client);
  return {
    id: client.id, name: client.name, billingMode: client.billingMode,
    billingStatus: status.billingStatus, supported: status.supported, message: status.message,
    billingNotes: client.billingNotes, bonsaiClientId: client.bonsaiClientId,
    bonsaiUrl: bonsaiClientUrl(client.bonsaiClientId), externalInvoiceUrl: safeInvoiceUrl(client.externalInvoiceUrl)
  };
}
export type ClientBillingDto = Awaited<ReturnType<typeof clientBillingDto>>;

export function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BillingInputError("Expected a JSON object.");
  return value as Record<string, unknown>;
}

export function assertKeys(body: Record<string, unknown>, allowed: readonly string[]) {
  const keys = Object.keys(body);
  if (!keys.length || keys.some((key) => !allowed.includes(key))) throw new BillingInputError("Empty update or unknown fields.");
}

export function validId(id: unknown): id is string {
  return typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

function nullableText(value: unknown, max: number): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new BillingInputError(`Text must be at most ${max} characters.`);
  return value.trim() || null;
}

export type BillingUpdate = Partial<Pick<BillingClient, "billingMode" | "billingStatus" | "billingNotes" | "bonsaiClientId" | "externalInvoiceUrl">>;
export function validateBillingUpdate(value: unknown, currentMode: BillingMode): BillingUpdate {
  const body = objectBody(value);
  assertKeys(body, ["billingMode", "billingStatus", "billingNotes", "bonsaiClientId", "externalInvoiceUrl"]);
  const data: BillingUpdate = {};
  let mode = currentMode;
  if ("billingMode" in body) {
    if (!BILLING_MODES.includes(body.billingMode as BillingMode)) throw new BillingInputError("Invalid billing mode.");
    mode = body.billingMode as BillingMode;
    data.billingMode = mode;
    // A previous manual-paid/comped flag must not survive a mode transition.
    if (mode !== currentMode) data.billingStatus = "pending_setup";
  }
  if ("billingStatus" in body) {
    if (mode !== "manual_override") throw new BillingInputError("Only manual mode accepts a stored status override. Exempt comped status is derived.");
    if (!BILLING_STATUSES.includes(body.billingStatus as BillingStatus)) throw new BillingInputError("Invalid billing status.");
    data.billingStatus = body.billingStatus as BillingStatus;
  }
  if ("billingNotes" in body) data.billingNotes = nullableText(body.billingNotes, 4000);
  if ("bonsaiClientId" in body) {
    data.bonsaiClientId = nullableText(body.bonsaiClientId, 200);
    if (data.bonsaiClientId && !/^[a-zA-Z0-9_-]+$/.test(data.bonsaiClientId)) throw new BillingInputError("Invalid Bonsai client ID.");
  }
  if ("externalInvoiceUrl" in body) {
    const raw = nullableText(body.externalInvoiceUrl, 2048);
    data.externalInvoiceUrl = raw === null ? null : safeInvoiceUrl(raw);
    if (raw !== null && data.externalInvoiceUrl === null) throw new BillingInputError("Invoice links must use HTTPS without credentials or whitespace.");
  }
  return data;
}

export function pagination(params: URLSearchParams) {
  const parse = (key: string, fallback: number, max: number) => {
    const raw = params.get(key);
    if (raw === null) return fallback;
    if (!/^[1-9]\d*$/.test(raw) || Number(raw) > max) throw new BillingInputError(`Invalid ${key}; maximum ${max}.`);
    return Number(raw);
  };
  const page = parse("page", 1, 10000);
  const pageSize = parse("pageSize", 50, 100);
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}