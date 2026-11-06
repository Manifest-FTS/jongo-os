/** Audit rows for the OIDC provider. Details carry ids and reason codes only: never codes, secrets, tokens or URLs. */

export type AuditWriter = {
  auditLog: { create(args: { data: Record<string, unknown> }): Promise<unknown> };
};

export type OidcAuditAction =
  | "oidc.code.issue"
  | "oidc.code.replay"
  | "oidc.consent.grant"
  | "oidc.token.issue"
  | "oidc.token.deny"
  | "craft.access.grant"
  | "craft.access.revoke";

export type OidcAuditEvent = {
  organizationId: string;
  actorId: string | null;
  action: OidcAuditAction;
  resourceType: "oidc_client" | "site";
  resourceId: string;
  details?: Record<string, string | number | boolean | null>;
  ipAddress?: string | null;
  userAgent?: string | null;
};

export async function writeOidcAudit(db: AuditWriter, event: OidcAuditEvent): Promise<void> {
  await db.auditLog.create({
    data: {
      organizationId: event.organizationId,
      actorId: event.actorId,
      action: event.action,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      details: event.details ?? {},
      ipAddress: event.ipAddress ?? null,
      userAgent: event.userAgent?.slice(0, 256) ?? null
    }
  });
}

/** Best effort: used where losing an audit row must not break sign-in. Never logs event contents. */
export async function writeOidcAuditBestEffort(db: AuditWriter, event: OidcAuditEvent): Promise<void> {
  try {
    await writeOidcAudit(db, event);
  } catch {
    console.error(`[oidc] audit write failed for ${event.action}`);
  }
}
