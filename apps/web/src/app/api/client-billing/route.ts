import { getDb } from "@/lib/db";
import { CLIENT_BILLING_SELECT, clientBillingDto, pagination } from "@/lib/client-billing";
import { billingError, billingJson, billingViewer } from "@/lib/client-billing-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    await billingViewer();
    const { page, pageSize, skip, take } = pagination(new URL(request.url).searchParams);
    const db = await getDb();
    if (!db) throw new Error("Database unavailable");
    const rows = await db.organization.findMany({ where: { deletedAt: null }, select: CLIENT_BILLING_SELECT, orderBy: [{ name: "asc" }, { id: "asc" }], skip, take: take + 1 });
    return billingJson({ clients: await Promise.all(rows.slice(0, take).map(clientBillingDto)), page, pageSize, hasMore: rows.length > take });
  } catch (error) { return billingError(error); }
}