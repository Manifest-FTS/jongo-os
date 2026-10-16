import { getDb } from "@/lib/db";
import { BillingInputError, CLIENT_BILLING_SELECT, clientBillingDto, validId, validateBillingUpdate } from "@/lib/client-billing";
import { billingError, billingJson, billingViewer, readBillingBody } from "@/lib/client-billing-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ clientId: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    await billingViewer();
    const { clientId } = await context.params;
    if (!validId(clientId)) throw new BillingInputError("Invalid client ID.");
    const db = await getDb();
    if (!db) throw new Error("Database unavailable");
    const client = await db.organization.findFirst({ where: { id: clientId, deletedAt: null }, select: CLIENT_BILLING_SELECT });
    if (!client) throw new BillingInputError("Client not found.", 404);
    return billingJson({ client: await clientBillingDto(client) });
  } catch (error) { return billingError(error); }
}

export async function PATCH(request: Request, context: Context) {
  try {
    const viewer = await billingViewer();
    const { clientId } = await context.params;
    if (!validId(clientId)) throw new BillingInputError("Invalid client ID.");
    const body = await readBillingBody(request);
    const db = await getDb();
    if (!db) throw new Error("Database unavailable");
    const client = await db.$transaction(async (tx: NonNullable<typeof db>) => {
      const current = await tx.organization.findFirst({ where: { id: clientId, deletedAt: null }, select: CLIENT_BILLING_SELECT });
      if (!current) throw new BillingInputError("Client not found.", 404);
      const data = validateBillingUpdate(body, current.billingMode);
      const updated = await tx.organization.update({ where: { id: clientId }, data, select: CLIENT_BILLING_SELECT });
      await tx.auditLog.create({ data: {
        organizationId: clientId, actorId: viewer.userId, action: "client_billing_updated",
        resourceType: "organization", resourceId: clientId,
        // Field names only: notes, links, identifiers and their prior values are never logged.
        details: { fields: Object.keys(data) }
      } });
      // DTO construction inside transaction also fails closed on invalid persisted enums.
      return clientBillingDto(updated);
    }, { isolationLevel: "Serializable" });
    return billingJson({ client });
  } catch (error) { return billingError(error); }
}