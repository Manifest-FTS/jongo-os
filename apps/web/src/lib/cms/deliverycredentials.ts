import { randomBytes, randomUUID } from "node:crypto";
import { executeCmsWriteTransaction, CmsDocumentError } from "./documents";
import { marketingChecksum } from "./marketing-snapshot";
import { isUuid } from "@/lib/site-identity";
export { deliveryTokenHash } from "./marketing-snapshot";

/** Internal only; current sponsor tier + freshly locked manage permission.
 * Returns the raw token once. Never serialize into audit/outbox/logs. */
export async function mintMarketingDeliveryCredential(actorId: string, datasetId: string, expiresAt: Date | null = null) {
  const expiry = expiresAt === null ? null : new Date(expiresAt.getTime());
  if (expiry && (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= Date.now())) throw new CmsDocumentError("invalid");
  return executeCmsWriteTransaction({ userId: actorId, datasetId }, "manage", async (tx, policy) => {
    if (expiry && expiry.getTime() <= Date.now()) throw new CmsDocumentError("invalid");
    const token = `jcms_${randomBytes(32).toString("base64url")}`;
    const id = randomUUID();
    // Display identifier independent of secret bytes, not an authenticator.
    const prefix = `jcms:${id.slice(0, 8)}`;
    await tx.cmsDeliveryCredential.create({ data: { id, datasetId, type: "marketing.read",
      tokenHash: marketingChecksum(token), prefix, expiresAt: expiry, actorId } });
    await tx.auditLog.create({ data: { organizationId: policy.organizationId, actorId,
      action: "cms.delivery.credential.mint", resourceType: "cms_dataset", resourceId: datasetId,
      details: { credentialId: id } } });
    return { id, prefix, token, expiresAt: expiry };
  });
}

export async function revokeMarketingDeliveryCredential(actorId: string, datasetId: string, credentialId: string) {
  if (!isUuid(credentialId)) throw new CmsDocumentError("invalid");
  return executeCmsWriteTransaction({ userId: actorId, datasetId }, "manage", async (tx, policy) => {
    const changed = await tx.cmsDeliveryCredential.updateMany({ where: { id: credentialId, datasetId, revokedAt: null }, data: { revokedAt: new Date() } });
    if (changed.count !== 1) throw new CmsDocumentError("conflict");
    await tx.auditLog.create({ data: { organizationId: policy.organizationId, actorId,
      action: "cms.delivery.credential.revoke", resourceType: "cms_dataset", resourceId: datasetId,
      details: { credentialId } } });
  });
}