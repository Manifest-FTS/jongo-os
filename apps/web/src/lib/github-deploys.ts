/**
 * Sites deployed from a customer's own GitHub: creating the app from a repo
 * through the org's private hosting source, changing branch / auto-deploy,
 * deploying on push, and following renames. Every entry point checks the
 * install belongs to the site's organization (lib/github-access.ts).
 */
import { getDb } from "@/lib/db";
import { assertInstallUsable } from "@/lib/github-access";
import { listBranches, listInstallationRepos } from "@/lib/github-app";
import { getOrgInstallation, audit } from "@/lib/github-installations";
import { buildGithubApplicationRequest, type GithubBuildPack } from "@/lib/github-app-request";
import { sitesForPush, type LinkedSite, type PushEvent } from "@/lib/github-push-match";

export type Outcome<T = unknown> = { ok: boolean; status: number; message: string; value?: T };

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type CreateFromGithubInput = {
  orgId: string;
  /** The Git source to deploy through (several per client, like Coolify). */
  sourceId?: string | null;
  userId: string;
  name: string;
  repoFullName: string;
  branch: string;
  buildPack: GithubBuildPack;
  port: number;
  baseDirectory?: string;
  envVars?: Array<{ key: string; value: string }>;
  temporaryDomainSlug?: string | null;
  temporaryDomainSuffix?: string | null;
};

export async function createSiteFromGithub(input: CreateFromGithubInput): Promise<Outcome<{ siteId: string; domain: string | null }>> {
  const db: any = await getDb();
  if (!db) return { ok: false, status: 503, message: "The database is unavailable." };

  const install = await getOrgInstallation(input.orgId, input.sourceId);
  const usable = assertInstallUsable(install, input.orgId, { needSource: true });
  if (!usable.ok) return { ok: false, status: usable.status, message: usable.message };

  const envVars = (input.envVars ?? []).filter((row) => row.key.trim());
  const badKey = envVars.find((row) => !ENV_KEY.test(row.key.trim()));
  if (badKey) return { ok: false, status: 400, message: `"${badKey.key}" isn't a valid variable name. Use letters, numbers and underscores.` };

  const repos = await listInstallationRepos(Number(install!.installationId));
  const repo = repos.find((candidate) => candidate.fullName.toLowerCase() === input.repoFullName.toLowerCase());
  if (!repo) return { ok: false, status: 404, message: "That repository isn't shared with Jongo. Add it on GitHub, then try again." };

  const org = await db.organization.findUnique({ where: { id: input.orgId }, select: { coolifyProjectId: true } });
  const { coolifyFetch, coolifyMutateWithResponse, applyCoolifyApplicationDomains, triggerCoolifyDeploy } = await import("@/lib/coolify");
  const { resolveStagingServerUuid } = await import("@/lib/coolify-server-resolve");
  const servers = await coolifyFetch("/api/v1/servers").catch(() => []);
  const server = resolveStagingServerUuid({ service: null, servers: Array.isArray(servers) ? (servers as Array<Record<string, unknown>>) : [] });

  const request = buildGithubApplicationRequest({
    projectUuid: org?.coolifyProjectId ?? "",
    serverUuid: server.uuid,
    sourceUuid: install!.coolifySourceUuid ?? "",
    repoFullName: repo.fullName,
    branch: input.branch,
    buildPack: input.buildPack,
    port: input.port,
    baseDirectory: input.baseDirectory,
    name: input.name
  });
  if (!request.ok) return { ok: false, status: 400, message: server.uuid ? request.message : server.reason ?? request.message };

  const created = await coolifyMutateWithResponse("/api/v1/applications/private-github-app", "POST", request.body);
  const appUuid = (created.body as any)?.uuid;
  if (!created.ok || typeof appUuid !== "string") {
    return { ok: false, status: 502, message: `The app couldn't be created (HTTP ${created.status ?? "n/a"}). Nothing was saved; try again.` };
  }

  if (envVars.length) {
    await coolifyMutateWithResponse(`/api/v1/applications/${appUuid}/envs/bulk`, "PATCH", {
      data: envVars.map((row) => ({ key: row.key.trim(), value: row.value, is_preview: false }))
    }).catch(() => null);
  }

  const { buildTemporaryProductionDomain } = await import("@/lib/temporary-domains");
  const { nextAvailableSlug, toSiteSlug } = await import("@/lib/site-slug");
  const taken = await db.site.findMany({ where: { organizationId: input.orgId }, select: { slug: true } });
  const slug = nextAvailableSlug(toSiteSlug(input.name), taken.map((row: { slug: string }) => row.slug));
  const domain = buildTemporaryProductionDomain({ slug: input.temporaryDomainSlug || slug, suffix: input.temporaryDomainSuffix }) ?? null;
  const domainApplied = domain ? await applyCoolifyApplicationDomains(appUuid, `https://${domain}`).catch(() => false) : false;

  const site = await db.site.create({
    data: {
      organizationId: input.orgId,
      slug,
      name: input.name.trim(),
      coolifyServiceUuid: appUuid,
      coolifyProjectId: org?.coolifyProjectId ?? null,
      gitRepositoryUrl: `https://github.com/${repo.fullName}`,
      temporaryDomainSlug: input.temporaryDomainSlug || slug,
      temporaryDomainSuffix: input.temporaryDomainSuffix ?? null,
      githubInstallationId: install!.id,
      gitRepoFullName: repo.fullName,
      gitRepoId: String(repo.id),
      gitBranch: input.branch,
      autoDeploy: true,
      gitStatus: "linked"
    }
  });

  let deployed = true;
  try {
    await triggerCoolifyDeploy(appUuid, "production");
  } catch {
    deployed = false;
  }
  await audit(input.orgId, input.userId, "github_repo_linked", { repo: repo.fullName, branch: input.branch, appUuid, created: true }, site.id);

  const parts = [`Created from ${repo.fullName}@${input.branch}.`];
  if (domain && !domainApplied) parts.push(`The address ${domain} couldn't be applied yet; use Apply address on the app.`);
  parts.push(deployed ? "The first deploy has started; it takes a few minutes." : "The first deploy didn't start; use Deploy now on the app.");
  return { ok: true, status: 201, message: parts.join(" "), value: { siteId: site.id, domain } };
}

/** Repos and branches for the picker; tokens never leave the server. */
export async function reposForOrg(orgId: string, sourceId?: string | null) {
  const install = await getOrgInstallation(orgId, sourceId);
  const usable = assertInstallUsable(install, orgId);
  if (!usable.ok) return { ok: false as const, status: usable.status, message: usable.message };
  const repos = await listInstallationRepos(Number(install!.installationId));
  return { ok: true as const, repos };
}

export async function branchesForOrg(orgId: string, fullName: string, sourceId?: string | null) {
  const install = await getOrgInstallation(orgId, sourceId);
  const usable = assertInstallUsable(install, orgId);
  if (!usable.ok) return { ok: false as const, status: usable.status, message: usable.message };
  const repos = await listInstallationRepos(Number(install!.installationId));
  if (!repos.some((repo) => repo.fullName.toLowerCase() === fullName.toLowerCase())) {
    return { ok: false as const, status: 404, message: "That repository isn't shared with Jongo." };
  }
  return { ok: true as const, branches: await listBranches(Number(install!.installationId), fullName) };
}

type SourceSite = {
  id: string;
  organizationId: string;
  coolifyServiceUuid: string | null;
  stagingTargetUuid: string | null;
  githubInstallationId: string | null;
  gitRepoFullName: string | null;
  gitBranch: string | null;
  gitStagingBranch: string | null;
  autoDeploy: boolean;
  gitStatus: string | null;
  pendingCommitSha: string | null;
};

async function loadSourceSite(siteId: string): Promise<SourceSite | null> {
  const db: any = await getDb();
  return db.site.findUnique({
    where: { id: siteId },
    select: {
      id: true,
      organizationId: true,
      coolifyServiceUuid: true,
      stagingTargetUuid: true,
      githubInstallationId: true,
      gitRepoFullName: true,
      gitBranch: true,
      gitStagingBranch: true,
      autoDeploy: true,
      gitStatus: true,
      pendingCommitSha: true
    }
  });
}

/** Branch, staging branch, auto-deploy, or a different repo from the same install. */
export async function updateSiteSource(input: {
  siteId: string;
  actorId: string;
  repoFullName?: string;
  branch?: string;
  stagingBranch?: string | null;
  autoDeploy?: boolean;
}): Promise<Outcome> {
  const db: any = await getDb();
  const site = await loadSourceSite(input.siteId);
  if (!site?.githubInstallationId) return { ok: false, status: 409, message: "This app isn't deployed from GitHub." };
  const install = await db.githubInstallation.findUnique({ where: { id: site.githubInstallationId } });
  const usable = assertInstallUsable(install, site.organizationId);
  if (!usable.ok) return { ok: false, status: usable.status, message: usable.message };

  const data: Record<string, unknown> = {};
  const coolifyPatch: Record<string, unknown> = {};
  let repoFullName = site.gitRepoFullName ?? "";

  if (input.repoFullName && input.repoFullName !== site.gitRepoFullName) {
    const repos = await listInstallationRepos(Number(install.installationId));
    const repo = repos.find((candidate) => candidate.fullName.toLowerCase() === input.repoFullName!.toLowerCase());
    if (!repo) return { ok: false, status: 404, message: "That repository isn't shared with Jongo." };
    repoFullName = repo.fullName;
    Object.assign(data, { gitRepoFullName: repo.fullName, gitRepoId: String(repo.id), gitRepositoryUrl: `https://github.com/${repo.fullName}`, gitStatus: "linked" });
    coolifyPatch.git_repository = repo.fullName;
  }

  const branches = input.branch !== undefined || input.stagingBranch ? await listBranches(Number(install.installationId), repoFullName) : [];
  if (input.branch !== undefined && input.branch !== site.gitBranch) {
    if (!branches.includes(input.branch)) return { ok: false, status: 404, message: `Branch ${input.branch} doesn't exist in ${repoFullName}.` };
    data.gitBranch = input.branch;
    coolifyPatch.git_branch = input.branch;
  }
  if (input.stagingBranch !== undefined) {
    const value = input.stagingBranch?.trim() || null;
    if (value && !branches.includes(value)) return { ok: false, status: 404, message: `Branch ${value} doesn't exist in ${repoFullName}.` };
    data.gitStagingBranch = value;
  }
  if (typeof input.autoDeploy === "boolean") data.autoDeploy = input.autoDeploy;

  const { coolifyMutateWithResponse } = await import("@/lib/coolify");
  if (Object.keys(coolifyPatch).length && site.coolifyServiceUuid) {
    const patched = await coolifyMutateWithResponse(`/api/v1/applications/${site.coolifyServiceUuid}`, "PATCH", coolifyPatch);
    if (!patched.ok) return { ok: false, status: 502, message: "The app's source couldn't be updated just now. Nothing changed; try again." };
  }
  // The staging copy builds from the staging branch when one is set.
  if (data.gitStagingBranch !== undefined && site.stagingTargetUuid) {
    const stagingBranch = (data.gitStagingBranch as string | null) ?? (data.gitBranch as string | undefined) ?? site.gitBranch;
    if (stagingBranch) {
      await coolifyMutateWithResponse(`/api/v1/applications/${site.stagingTargetUuid}`, "PATCH", {
        git_branch: stagingBranch,
        ...(coolifyPatch.git_repository ? { git_repository: coolifyPatch.git_repository } : {})
      }).catch(() => null);
    }
  }

  if (Object.keys(data).length) await db.site.update({ where: { id: site.id }, data });
  await audit(site.organizationId, input.actorId, "github_source_updated", { ...coolifyPatch, stagingBranch: data.gitStagingBranch, autoDeploy: data.autoDeploy }, site.id);
  return { ok: true, status: 200, message: Object.keys(coolifyPatch).length ? "Saved. Use Deploy now to build from the new source." : "Saved." };
}

async function deploySite(site: SourceSite, target: "production" | "staging"): Promise<{ ok: boolean; message: string }> {
  const uuid = target === "staging" ? site.stagingTargetUuid : site.coolifyServiceUuid;
  if (!uuid) return { ok: false, message: target === "staging" ? "There's no staging copy to deploy." : "This app isn't linked to a running site yet." };
  const { triggerCoolifyDeploy } = await import("@/lib/coolify");
  try {
    await triggerCoolifyDeploy(uuid, target);
    return { ok: true, message: "Deploy started." };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "The deploy didn't start." };
  }
}

/** "New commit available — Deploy" and the Deploy now button. */
export async function deployNow(siteId: string, actorId: string): Promise<Outcome> {
  const db: any = await getDb();
  const site = await loadSourceSite(siteId);
  if (!site) return { ok: false, status: 404, message: "Not found." };
  if (site.githubInstallationId && site.gitStatus && site.gitStatus !== "linked") {
    return { ok: false, status: 409, message: "Jongo can't read this repo right now. Reconnect it on GitHub first." };
  }
  const result = await deploySite(site, "production");
  if (result.ok) {
    await db.site.update({
      where: { id: site.id },
      data: { pendingCommitSha: null, pendingCommitMessage: null, ...(site.pendingCommitSha ? { lastDeployedSha: site.pendingCommitSha } : {}) }
    });
  }
  await audit(site.organizationId, actorId, result.ok ? "github_push_deploy" : "github_push_deploy_failed", { manual: true, sha: site.pendingCommitSha, message: result.message }, site.id);
  return { ok: result.ok, status: result.ok ? 200 : 502, message: result.ok ? "Deploy started. It takes a few minutes." : `${result.message} Try again in a minute.` };
}

/** Webhook `push`: deploy (or record) every site linked to this repo and branch. */
export async function handlePush(payload: any): Promise<{ deployed: number; pending: number; failed: number }> {
  const db: any = await getDb();
  const result = { deployed: 0, pending: 0, failed: 0 };
  const installationId = Number(payload?.installation?.id);
  const repoId = Number(payload?.repository?.id);
  if (!db || !Number.isFinite(installationId) || !Number.isFinite(repoId)) return result;

  const install = await db.githubInstallation.findUnique({ where: { installationId: BigInt(installationId) } });
  if (!install || install.status !== "active") return result;

  const rows = await db.site.findMany({
    where: { githubInstallationId: install.id, gitRepoId: String(repoId), deletedAt: null },
    select: {
      id: true, organizationId: true, coolifyServiceUuid: true, stagingTargetUuid: true, githubInstallationId: true,
      gitRepoFullName: true, gitBranch: true, gitStagingBranch: true, autoDeploy: true, gitStatus: true, pendingCommitSha: true,
      stagingEnabled: true
    }
  });
  const push: PushEvent = {
    ref: String(payload?.ref ?? ""),
    after: String(payload?.after ?? ""),
    deleted: Boolean(payload?.deleted),
    installationId,
    repoId,
    headCommit: payload?.head_commit
      ? { message: String(payload.head_commit.message ?? "").split("\n")[0].slice(0, 200), author: String(payload.head_commit.author?.username ?? payload.head_commit.author?.name ?? "") }
      : null
  };
  const linked: LinkedSite[] = rows.map((row: any) => ({
    siteId: row.id,
    installationId,
    gitRepoId: repoId,
    gitBranch: row.gitBranch,
    gitStagingBranch: row.gitStagingBranch,
    autoDeploy: row.autoDeploy,
    gitStatus: row.gitStatus ?? "linked",
    stagingEnabled: row.stagingEnabled
  }));

  for (const action of sitesForPush(push, linked)) {
    const site = rows.find((row: any) => row.id === action.siteId);
    const details = { sha: push.after, branch: push.ref.replace("refs/heads/", ""), target: action.target, author: push.headCommit?.author, message: push.headCommit?.message };
    if (action.action === "record_pending") {
      await db.site.update({ where: { id: site.id }, data: { pendingCommitSha: push.after, pendingCommitMessage: push.headCommit?.message ?? null } });
      await audit(site.organizationId, null, "github_commit_pending", details, site.id);
      result.pending += 1;
      continue;
    }
    const deployed = await deploySite(site, action.target);
    if (deployed.ok) {
      if (action.target === "production") {
        await db.site.update({ where: { id: site.id }, data: { lastDeployedSha: push.after, pendingCommitSha: null, pendingCommitMessage: null } });
      }
      result.deployed += 1;
    } else {
      result.failed += 1;
    }
    await audit(site.organizationId, null, deployed.ok ? "github_push_deploy" : "github_push_deploy_failed", { ...details, error: deployed.ok ? undefined : deployed.message }, site.id);
  }
  return result;
}

/** A renamed or transferred repo: point the app at its new name. */
export async function followRepoRename(siteId: string, fullName: string): Promise<void> {
  const site = await loadSourceSite(siteId);
  const { coolifyMutateWithResponse } = await import("@/lib/coolify");
  for (const uuid of [site?.coolifyServiceUuid, site?.gitStagingBranch ? site?.stagingTargetUuid : null]) {
    if (uuid) await coolifyMutateWithResponse(`/api/v1/applications/${uuid}`, "PATCH", { git_repository: fullName });
  }
}

/**
 * "Public repository" (Coolify's public-git-repository): no Git source, just
 * the URL. Jongo can't receive pushes for it, so it deploys on Deploy now.
 */
export async function createSiteFromPublicRepo(input: Omit<CreateFromGithubInput, "repoFullName" | "sourceId"> & { repoUrl: string }): Promise<Outcome<{ siteId: string; domain: string | null }>> {
  const db: any = await getDb();
  if (!db) return { ok: false, status: 503, message: "The database is unavailable." };
  const envVars = (input.envVars ?? []).filter((row) => row.key.trim());
  const badKey = envVars.find((row) => !ENV_KEY.test(row.key.trim()));
  if (badKey) return { ok: false, status: 400, message: `"${badKey.key}" isn't a valid variable name. Use letters, numbers and underscores.` };

  const org = await db.organization.findUnique({ where: { id: input.orgId }, select: { coolifyProjectId: true } });
  const { coolifyFetch, coolifyMutateWithResponse, applyCoolifyApplicationDomains, triggerCoolifyDeploy } = await import("@/lib/coolify");
  const { resolveStagingServerUuid } = await import("@/lib/coolify-server-resolve");
  const { buildPublicApplicationRequest } = await import("@/lib/github-app-request");
  const { parsePublicRepoUrl } = await import("@/lib/git-sources");
  const servers = await coolifyFetch("/api/v1/servers").catch(() => []);
  const server = resolveStagingServerUuid({ service: null, servers: Array.isArray(servers) ? (servers as Array<Record<string, unknown>>) : [] });
  const request = buildPublicApplicationRequest({
    projectUuid: org?.coolifyProjectId ?? "",
    serverUuid: server.uuid,
    repoUrl: input.repoUrl,
    branch: input.branch,
    buildPack: input.buildPack,
    port: input.port,
    baseDirectory: input.baseDirectory,
    name: input.name
  });
  if (!request.ok) return { ok: false, status: 400, message: server.uuid ? request.message : server.reason ?? request.message };
  const parsed = parsePublicRepoUrl(input.repoUrl);

  const created = await coolifyMutateWithResponse("/api/v1/applications/public", "POST", request.body);
  const appUuid = (created.body as any)?.uuid;
  if (!created.ok || typeof appUuid !== "string") {
    return { ok: false, status: 502, message: `The app couldn't be created (HTTP ${created.status ?? "n/a"}). Check the repository is public and the branch exists.` };
  }
  if (envVars.length) {
    await coolifyMutateWithResponse(`/api/v1/applications/${appUuid}/envs/bulk`, "PATCH", {
      data: envVars.map((row) => ({ key: row.key.trim(), value: row.value, is_preview: false }))
    }).catch(() => null);
  }
  const { buildTemporaryProductionDomain } = await import("@/lib/temporary-domains");
  const { nextAvailableSlug, toSiteSlug } = await import("@/lib/site-slug");
  const taken = await db.site.findMany({ where: { organizationId: input.orgId }, select: { slug: true } });
  const slug = nextAvailableSlug(toSiteSlug(input.name), taken.map((row: { slug: string }) => row.slug));
  const domain = buildTemporaryProductionDomain({ slug: input.temporaryDomainSlug || slug, suffix: input.temporaryDomainSuffix }) ?? null;
  const domainApplied = domain ? await applyCoolifyApplicationDomains(appUuid, `https://${domain}`).catch(() => false) : false;
  const site = await db.site.create({
    data: {
      organizationId: input.orgId,
      slug,
      name: input.name.trim(),
      coolifyServiceUuid: appUuid,
      coolifyProjectId: org?.coolifyProjectId ?? null,
      gitRepositoryUrl: parsed.ok ? parsed.url : input.repoUrl,
      gitBranch: input.branch,
      temporaryDomainSlug: input.temporaryDomainSlug || slug,
      temporaryDomainSuffix: input.temporaryDomainSuffix ?? null
    }
  });
  let deployed = true;
  try {
    await triggerCoolifyDeploy(appUuid, "production");
  } catch {
    deployed = false;
  }
  await audit(input.orgId, input.userId, "public_repo_linked", { repo: parsed.ok ? parsed.url : input.repoUrl, branch: input.branch, appUuid }, site.id);
  const parts = [`Created from ${parsed.ok ? parsed.fullName : "the repository"}@${input.branch}.`];
  if (domain && !domainApplied) parts.push(`The address ${domain} couldn't be applied yet; use Apply address on the app.`);
  parts.push(deployed ? "The first deploy has started; it takes a few minutes." : "The first deploy didn't start; use Deploy now on the app.");
  return { ok: true, status: 201, message: parts.join(" "), value: { siteId: site.id, domain } };
}
