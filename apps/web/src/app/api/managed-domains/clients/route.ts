import { getDb } from "@/lib/db";
import { BillingInputError, pagination } from "@/lib/client-billing";
import { billingError, billingJson, billingViewer } from "@/lib/client-billing-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Minimal, searchable and paginated active-client picker; no billing notes. */
export async function GET(request: Request) {
  try {
    await billingViewer();
    const params = new URL(request.url).searchParams;
    const { page, pageSize, skip, take } = pagination(params);
    const q = params.get("q") ?? "";
    if (q.length > 200) throw new BillingInputError("Search is too long.");
    const db = await getDb();
    if (!db) throw new Error("Database unavailable");
    const rows = await db.organization.findMany({
      where: { deletedAt: null, ...(q ? { name: { contains: q, mode: "insensitive" } } : {}) },
      select: { id: true, name: true }, orderBy: [{ name: "asc" }, { id: "asc" }], skip, take: take + 1
    });
    return billingJson({ clients: rows.slice(0, take).map((row: { id: string; name: string }) => ({ id: row.id, name: row.name })), page, pageSize, hasMore: rows.length > take });
  } catch (error) { return billingError(error); }
}