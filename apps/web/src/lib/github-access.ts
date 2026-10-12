/**
 * The cross-organization guard: an install can only be used by the
 * organization it was connected to, and only while it is active. Every route
 * that lists repos, links a repo or creates a site goes through this.
 */
export type InstallLike = { id: string; organizationId: string; status: string; coolifySourceUuid: string | null };

export function assertInstallUsable(
  install: InstallLike | null | undefined,
  orgId: string,
  options: { needSource?: boolean } = {}
): { ok: true } | { ok: false; status: number; message: string } {
  if (!install) return { ok: false, status: 404, message: "Connect GitHub for this client first." };
  if (install.organizationId !== orgId) return { ok: false, status: 403, message: "That GitHub connection belongs to another client." };
  if (install.status === "suspended") return { ok: false, status: 409, message: "This GitHub connection is suspended on GitHub. Unsuspend it there to continue." };
  if (install.status !== "active") return { ok: false, status: 409, message: "This GitHub connection was removed. Connect GitHub again." };
  if (options.needSource && !install.coolifySourceUuid) {
    return { ok: false, status: 409, message: "GitHub is still finishing setup for this client. Try again in a minute." };
  }
  return { ok: true };
}
