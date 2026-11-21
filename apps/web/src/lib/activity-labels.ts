/**
 * Plain-language labels for the client Activity page. Audit rows store a
 * machine action (and often a more specific details.actionType); anything not
 * listed here is shown humanised rather than hidden.
 */
const LABELS: Record<string, string> = {
  deploy: "Deployed",
  deploy_triggered: "Started a deploy",
  site_created: "Created an app",
  site_deleted: "Deleted an app",
  site_archived: "Archived an app",
  site_url_rewritten: "Changed the site's saved address",
  privacy_mode_enabled: "Turned on privacy mode",
  privacy_mode_disabled: "Turned off privacy mode",
  staging_enable_requested: "Turned on staging",
  staging_enable_provision: "Created the staging copy",
  staging_enable_existing: "Reused the existing staging copy",
  staging_disable_requested: "Turned off staging",
  staging_disable_destroy: "Removed the staging copy",
  staging_synced_from_production: "Refreshed staging from live",
  staging_promote_triggered: "Pushed staging to live",
  staging_promote_backup_started: "Backed up live before pushing staging",
  staging_promote_blocked: "Push to live was blocked",
  staging_promote_failed: "Push to live failed",
  staging_domain_added: "Added a staging domain",
  staging_domain_attached: "Connected a staging domain",
  staging_domain_verified: "Verified a staging domain",
  staging_domain_removed: "Removed a staging domain",
  staging_domain_primary_changed: "Changed the main staging domain",
  staging_domain_dns_lost: "A staging domain stopped pointing here",
  production_primary_domain_set: "Changed the main address",
  sftp_access_revoked: "Removed SFTP access",
  restore: "Restored a backup",
  restart: "Restarted an app",
  restart_site: "Restarted an app",
  github_repo_linked: "Linked a GitHub repository",
  public_repo_linked: "Linked a public repository",
  deploy_key_repo_linked: "Linked a repository with a deploy key",
  client_billing_updated: "Updated client billing",
  managed_domain_updated: "Updated a domain",
  "craft.access.invite": "Invited someone to the CMS",
  "craft.access.grant": "Gave CMS access",
  "craft.access.revoke": "Removed CMS access",
  "cms.marketing.release.publish": "Published content",
  "cms.marketing.release.unpublish": "Unpublished content",
  "cms.marketing.release.rollback": "Rolled back content"
};

export function humanizeAction(key: string): string {
  const text = key.replace(/[._]+/g, " ").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "Change";
}

export function activityLabel(action: string, details: unknown): string {
  const specific =
    details && typeof details === "object" && typeof (details as Record<string, unknown>).actionType === "string"
      ? String((details as Record<string, unknown>).actionType)
      : "";
  return LABELS[specific] ?? LABELS[action] ?? humanizeAction(specific || action);
}

/** A short, safe summary of a row's details: names and hosts, never secrets. */
export function activityDetail(details: unknown): string | null {
  if (!details || typeof details !== "object") return null;
  const d = details as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ["hostname", "domain", "environment", "outcome", "reason"]) {
    const value = d[key];
    if (typeof value === "string" && value.trim() && value.length <= 120) parts.push(value.trim());
  }
  return parts.length ? parts.join(" · ") : null;
}
