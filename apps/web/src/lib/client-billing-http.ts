import { auth } from "@/lib/auth.config";
import { resolvePrincipal, canManageBilling } from "@/lib/rbac";
import { BillingInputError } from "./client-billing";

export function billingJson(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", Vary: "Cookie" } });
}

/** Authentication and fresh DB principal precede application queries/body parsing. */
export async function billingViewer(superOnly = true) {
  const session = await auth();
  if (!session?.user?.id) throw new BillingInputError("Unauthorized", 401);
  const principal = await resolvePrincipal(session.user.id);
  if (!principal || (superOnly && !canManageBilling(principal))) throw new BillingInputError("Forbidden", 403);
  return principal;
}

/** Stream bounded, including chunked requests without Content-Length. */
export async function readBillingBody(request: Request): Promise<unknown> {
  const maxBytes = 16384;
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) throw new BillingInputError("Request body too large.", 413);
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new BillingInputError("Use application/json.", 415);
  const reader = request.body?.getReader();
  if (!reader) throw new BillingInputError("Expected JSON.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new BillingInputError("Request body too large.", 413); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof BillingInputError) throw error;
    throw new BillingInputError("Invalid JSON.");
  } finally { reader.releaseLock(); }
}

export function billingError(error: unknown) {
  return error instanceof BillingInputError
    ? billingJson({ error: error.message }, error.status)
    : billingJson({ error: "The operation could not be completed. No partial update was saved." }, 503);
}