/**
 * Customer GitHub installs: saving the Jongo GitHub App, connecting an install
 * to an organization, its private hosting source, disconnecting, applying
 * GitHub's installation/repository events, and the hourly double-check.
 */
import { getDb } from "@/lib/db";
import { encryptSecret } from "@/lib/secret-box";
import { coolifyMutateWithResponse } from "@/lib/coolify";
import {
  appForOrganization,
  clearGithubAppCache,
  getGithubApp,
  type GithubAppSecrets,
  getInstallation,
  listInstallationRepos,
  type ManifestConversion
} from "@/lib/github-app";
import { planInstallEvent, type SiteRef } from "@/lib/github-install-events";

export type InstallationRow = {
  id: string;
  organizationId: string;
  installationId: bigint;
  accountLogin: string;
  accountType: string;
  repositorySelection: string | null;
  coolifySourceUuid: string | null;
  coolifySourceId: number | null;
  githubAppConfigId?: string | null;
  status: string;
  lastError: string | null;
  createdAt: Date;
};

export async function audit(organizationId: string, actorId: string | null, actionType: string, details: Record<string, unknown>, siteId?: string) {
  const db: any = await getDb();
  try {
    await db?.auditLog.create({
      data: {
        organizationId,
        actorId,
        action: siteId ? "site_updated" : "organization_updated",
        resourceType: siteId ? "site_github" : "github",
        resourceId: siteId ?? organizationId,
        details: { actionType, ...details }
      }
    });
  } catch (error) {
    console.error("[github] audit write failed", error);
  }
}

// ---------------------------------------------------------------------------
// The app itself (platform admin, once)
// ---------------------------------------------------------------------------

/**
 * Stores a GitHub App GitHub just created (manifest flow). organizationId set:
 * the client's own app; null: the optional shared app.
 */
export async function saveGithubApp(conversion: ManifestConversion, actorId: string, organizationId: string | null): Promise<{ ok: boolean; message: string; app: GithubAppSecrets | null }> {
  const db: any = await getDb();
  if (!db) return { ok: false, message: "The database is unavailable.", app: null };
  const existing = await db.githubAppConfig.findFirst({ where: { organizationId } });
  if (existing) {
    const app = await getGithubApp({ id: existing.id });
    return { ok: true, message: "GitHub is already set up for this client.", app };
  }
  const row = await db.githubAppConfig.create({
    data: {
      organizationId,
      appId: Number(conversion.id),
      slug: conversion.slug,
      name: conversion.name,
      htmlUrl: conversion.html_url,
      clientId: conversion.client_id,
      clientSecretEnc: encryptSecret(conversion.client_secret),
      webhookSecretEnc: encryptSecret(conversion.webhook_secret),
      privateKeyEnc: encryptSecret(conversion.pem),
      createdById: actorId
    }
  });
  clearGithubAppCache();
  const app = await getGithubApp({ id: row.id });
  if (app) await ensureHostingKey(app);
  if (organizationId) await audit(organizationId, actorId, "github_app_created", { appId: conversion.id, slug: conversion.slug });
  return { ok: true, message: `${conversion.name} was created on GitHub.`, app };
}

/** Uploads an app's private key to the hosting server once; sources reference it. */
export async function ensureHostingKey(app: GithubAppSecrets | null): Promise<{ ok: boolean; message: string; uuid?: string }> {
  if (!app) return { ok: false, message: "GitHub isn't set up yet." };
  if (app.coolifyPrivateKeyUuid) return { ok: true, message: "Key in place.", uuid: app.coolifyPrivateKeyUuid };
  const response = await coolifyMutateWithResponse("/api/v1/security/keys", "POST", {
    name: `jongo-github-app-${app.slug}`,
    description: "Private key of a Jongo GitHub App (managed by Jongo).",
    private_key: app.privateKey
  });
  const uuid = (response.body as any)?.uuid;
  if (!response.ok || typeof uuid !== "string") {
    return { ok: false, message: `the hosting server answered HTTP ${response.status ?? "n/a"}` };
  }
  const db: any = await getDb();
  await db.githubAppConfig.update({ where: { id: app.id }, data: { coolifyPrivateKeyUuid: uuid } });
  clearGithubAppCache();
  return { ok: true, message: "Key uploaded.", uuid };
}

async function appForInstallRow(install: Pick<InstallationRow, "githubAppConfigId" | "organizationId">): Promise<GithubAppSecrets | null> {
  if (install.githubAppConfigId) return getGithubApp({ id: install.githubAppConfigId });
  return appForOrganization(install.organizationId);
}

// ---------------------------------------------------------------------------
// Installs
// ---------------------------------------------------------------------------

export async function getOrgInstallation(orgId: string): Promise<InstallationRow | null> {
  const db: any = await getDb();
  if (!db) return null;
  return db.githubInstallation.findFirst({
    where: { organizationId: orgId, status: { not: "removed" } },
    orderBy: { createdAt: "desc" }
  });
}

/** Creates the install's private hosting source if it doesn't exist yet. */
export async function ensureHostingSource(install: InstallationRow): Promise<{ ok: boolean; message: string }> {
  if (install.coolifySourceUuid) return { ok: true, message: "Ready." };
  const db: any = await getDb();
  const app = await appForInstallRow(install);
  const key = await ensureHostingKey(app);
  if (!key.ok || !app || !key.uuid) {
    await db.githubInstallation.update({ where: { id: install.id }, data: { lastError: key.message } });
    return { ok: false, message: "GitHub is connected, but setup isn't finished yet. It retries automatically, or use Finish setup." };
  }
  const response = await coolifyMutateWithResponse("/api/v1/github-apps", "POST", {
    name: `jongo-${install.accountLogin}-${String(install.installationId)}`.slice(0, 250),
    organization: install.accountType === "Organization" ? install.accountLogin : null,
    api_url: "https://api.github.com",
    html_url: "https://github.com",
    custom_user: "git",
    custom_port: 22,
    app_id: app.appId,
    installation_id: Number(install.installationId),
    client_id: app.clientId,
    client_secret: app.clientSecret,
    webhook_secret: app.webhookSecret,
    private_key_uuid: key.uuid,
    is_system_wide: false
  });
  const body = response.body as any;
  if (!response.ok || typeof body?.uuid !== "string") {
    const message = `the hosting server answered HTTP ${response.status ?? "n/a"}`;
    await db.githubInstallation.update({ where: { id: install.id }, data: { lastError: message } });
    return { ok: false, message: "GitHub is connected, but setup isn't finished yet. It retries automatically, or use Finish setup." };
  }
  await db.githubInstallation.update({
    where: { id: install.id },
    data: { coolifySourceUuid: body.uuid, coolifySourceId: Number.isFinite(Number(body.id)) ? Number(body.id) : null, lastError: null }
  });
  return { ok: true, message: "Ready." };
}

export async function connectInstallation(input: {
  orgId: string;
  userId: string;
  installationId: number;
}): Promise<{ ok: boolean; status: number; message: string }> {
  const db: any = await getDb();
  if (!db) return { ok: false, status: 503, message: "The database is unavailable." };
  // The client's own app first, then the shared one: whichever owns this install.
  const candidates = [await getGithubApp({ organizationId: input.orgId }), await getGithubApp()].filter((app): app is GithubAppSecrets => Boolean(app));
  let info = null as Awaited<ReturnType<typeof getInstallation>>;
  let app: GithubAppSecrets | null = null;
  for (const candidate of candidates) {
    info = await getInstallation(input.installationId, candidate).catch(() => null);
    if (info) {
      app = candidate;
      break;
    }
  }
  if (!info || !app) return { ok: false, status: 404, message: "GitHub doesn't know that installation. Try connecting again." };

  const existing = await db.githubInstallation.findUnique({ where: { installationId: BigInt(input.installationId) } });
  if (existing && existing.organizationId !== input.orgId && existing.status !== "removed") {
    return { ok: false, status: 409, message: `GitHub account ${info.account.login} is already connected to another client in Jongo.` };
  }

  const data = {
    organizationId: input.orgId,
    accountLogin: info.account.login,
    accountType: info.account.type,
    accountId: BigInt(info.account.id || 0),
    repositorySelection: info.repositorySelection,
    status: info.suspended ? "suspended" : "active",
    githubAppConfigId: app.id,
    removedAt: null,
    createdById: input.userId
  };
  const row = existing
    ? await db.githubInstallation.update({ where: { id: existing.id }, data: { ...data, ...(existing.organizationId !== input.orgId ? { coolifySourceUuid: null, coolifySourceId: null } : {}) } })
    : await db.githubInstallation.create({ data: { ...data, installationId: BigInt(input.installationId) } });

  // Reconnecting the same install brings its sites back; the hourly check
  // re-confirms each repo is still shared.
  await db.site.updateMany({ where: { githubInstallationId: row.id, gitStatus: { in: ["install_removed", "install_suspended"] } }, data: { gitStatus: info.suspended ? "install_suspended" : "linked" } });
  await audit(input.orgId, input.userId, "github_connected", { installationId: input.installationId, account: info.account.login });
  const source = await ensureHostingSource(row);
  return source.ok
    ? { ok: true, status: 200, message: `GitHub account ${info.account.login} is connected.` }
    : { ok: true, status: 200, message: source.message };
}

async function deleteHostingSource(install: InstallationRow): Promise<void> {
  if (!install.coolifySourceId) return;
  // Refused while apps still use it; the source then stays (it can't pull
  // anything once the app is uninstalled) and is listed in the audit entry.
  const response = await coolifyMutateWithResponse(`/api/v1/github-apps/${install.coolifySourceId}`, "DELETE");
  if (response.ok) {
    const db: any = await getDb();
    await db.githubInstallation.update({ where: { id: install.id }, data: { coolifySourceUuid: null, coolifySourceId: null } });
  }
}

export async function disconnectInstallation(orgId: string, actorId: string): Promise<{ ok: boolean; message: string; manageUrl: string | null }> {
  const db: any = await getDb();
  const install = await getOrgInstallation(orgId);
  if (!install) return { ok: false, message: "GitHub isn't connected.", manageUrl: null };
  await db.githubInstallation.update({ where: { id: install.id }, data: { status: "removed", removedAt: new Date() } });
  await db.site.updateMany({ where: { githubInstallationId: install.id }, data: { gitStatus: "install_removed" } });
  await deleteHostingSource(install).catch((error) => console.error("[github] deleting hosting source failed", error));
  await audit(orgId, actorId, "github_disconnected", { installationId: String(install.installationId), account: install.accountLogin });
  return {
    ok: true,
    message: `Disconnected from Jongo. To remove Jongo's access completely, uninstall it on GitHub too.`,
    manageUrl: installationSettingsUrl(install)
  };
}

export function installationSettingsUrl(install: Pick<InstallationRow, "accountType" | "accountLogin" | "installationId">): string {
  return install.accountType === "Organization"
    ? `https://github.com/organizations/${install.accountLogin}/settings/installations/${String(install.installationId)}`
    : `https://github.com/settings/installations/${String(install.installationId)}`;
}

// ---------------------------------------------------------------------------
// Webhook events and the hourly check
// ---------------------------------------------------------------------------

async function sitesOf(installRowId: string): Promise<SiteRef[]> {
  const db: any = await getDb();
  const rows = await db.site.findMany({
    where: { githubInstallationId: installRowId, deletedAt: null },
    select: { id: true, gitRepoId: true, gitStatus: true }
  });
  return rows.map((row: any) => ({ siteId: row.id, gitRepoId: row.gitRepoId === null ? null : Number(row.gitRepoId), gitStatus: row.gitStatus }));
}

export async function applyInstallEvent(event: string, payload: any): Promise<void> {
  const db: any = await getDb();
  const installationId = Number(payload?.installation?.id);
  if (!db || !Number.isFinite(installationId)) return;
  const install = await db.githubInstallation.findUnique({ where: { installationId: BigInt(installationId) } });
  if (!install) return; // Not connected to any client: nothing to update.

  const plan = planInstallEvent(event, payload, await sitesOf(install.id));
  if (plan.installStatus && plan.installStatus !== install.status) {
    await db.githubInstallation.update({
      where: { id: install.id },
      data: { status: plan.installStatus, ...(plan.installStatus === "removed" ? { removedAt: new Date() } : {}) }
    });
    await audit(install.organizationId, null, "github_install_status_changed", { installationId, status: plan.installStatus, event, action: payload?.action });
  }
  for (const update of plan.siteUpdates) {
    await db.site.update({
      where: { id: update.siteId },
      data: {
        ...(update.gitStatus ? { gitStatus: update.gitStatus } : {}),
        ...(update.gitRepoFullName ? { gitRepoFullName: update.gitRepoFullName, gitRepositoryUrl: `https://github.com/${update.gitRepoFullName}` } : {})
      }
    });
    if (update.gitRepoFullName) {
      const { followRepoRename } = await import("@/lib/github-deploys");
      await followRepoRename(update.siteId, update.gitRepoFullName).catch((error) => console.error("[github] rename follow failed", error));
    }
  }
  if (plan.removeSource) await deleteHostingSource(install).catch(() => undefined);
}

export type GithubReconcileResult = { checked: number; removed: number; suspended: number; accessLost: number; sourcesCreated: number; deliveriesPruned: number };

/** Catches anything a missed webhook would have told us. Max 20 installs per run. */
export async function reconcileGithubInstallations(limit = 20): Promise<GithubReconcileResult> {
  const result: GithubReconcileResult = { checked: 0, removed: 0, suspended: 0, accessLost: 0, sourcesCreated: 0, deliveriesPruned: 0 };
  const db: any = await getDb();
  if (!db) return result;

  const pruned = await db.githubWebhookDelivery.deleteMany({ where: { receivedAt: { lt: new Date(Date.now() - 14 * 24 * 3600_000) } } });
  result.deliveriesPruned = pruned.count ?? 0;

  const installs: InstallationRow[] = await db.githubInstallation.findMany({
    where: { status: { in: ["active", "suspended"] } },
    orderBy: { updatedAt: "asc" },
    take: limit
  });
  for (const install of installs) {
    result.checked += 1;
    const info = await getInstallation(Number(install.installationId)).catch(() => undefined);
    if (info === undefined) continue; // GitHub unreachable: try next hour.
    if (info === null) {
      await applyInstallEvent("installation", { action: "deleted", installation: { id: Number(install.installationId) } });
      result.removed += 1;
      continue;
    }
    if (info.suspended !== (install.status === "suspended")) {
      await applyInstallEvent("installation", { action: info.suspended ? "suspend" : "unsuspend", installation: { id: Number(install.installationId) } });
      if (info.suspended) result.suspended += 1;
    }
    await db.githubInstallation.update({ where: { id: install.id }, data: { repositorySelection: info.repositorySelection, accountLogin: info.account.login } });
    if (!install.coolifySourceUuid && !info.suspended) {
      if ((await ensureHostingSource(install)).ok) result.sourcesCreated += 1;
    }
    if (info.suspended) continue;

    const repos = await listInstallationRepos(Number(install.installationId)).catch(() => null);
    if (!repos) continue;
    const visible = new Set(repos.map((repo) => repo.id));
    for (const site of await sitesOf(install.id)) {
      if (site.gitRepoId === null) continue;
      if (site.gitStatus === "linked" && !visible.has(site.gitRepoId)) {
        await db.site.update({ where: { id: site.siteId }, data: { gitStatus: "repo_access_lost" } });
        result.accessLost += 1;
      } else if (site.gitStatus === "repo_access_lost" && visible.has(site.gitRepoId)) {
        await db.site.update({ where: { id: site.siteId }, data: { gitStatus: "linked" } });
      }
    }
  }
  return result;
}
