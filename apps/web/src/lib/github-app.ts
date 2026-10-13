/**
 * Talking to GitHub as the Jongo GitHub App: the app JWT, short-lived
 * installation tokens, and the few reads Jongo needs (installation, repos,
 * branches). Tokens stay in this process: never stored, logged or sent to a
 * browser.
 */
import { createSign } from "node:crypto";
import { getDb } from "@/lib/db";
import { decryptSecret } from "@/lib/secret-box";

const API = "https://api.github.com";

export type GithubAppSecrets = {
  id: string;
  /** The client that created it; null for an optional shared app. */
  organizationId: string | null;
  appId: number;
  slug: string;
  name: string;
  htmlUrl: string;
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  privateKey: string;
  coolifyPrivateKeyUuid: string | null;
};

const configCache = new Map<string, { at: number; value: GithubAppSecrets | null }>();

export function clearGithubAppCache(): void {
  configCache.clear();
  tokenCache.clear();
}

function decryptRow(row: any): GithubAppSecrets {
  return {
    id: row.id,
    organizationId: row.organizationId ?? null,
    appId: row.appId,
    slug: row.slug,
    name: row.name,
    htmlUrl: row.htmlUrl,
    clientId: row.clientId,
    clientSecret: decryptSecret(row.clientSecretEnc),
    webhookSecret: decryptSecret(row.webhookSecretEnc),
    privateKey: decryptSecret(row.privateKeyEnc),
    coolifyPrivateKeyUuid: row.coolifyPrivateKeyUuid ?? null
  };
}

/**
 * A Jongo GitHub App, decrypted: by row id, by GitHub app id (webhooks), or a
 * client's own app. With no selector: the optional shared app (no client).
 */
export async function getGithubApp(selector: { id?: string | null; appId?: number | null; organizationId?: string | null } = {}): Promise<GithubAppSecrets | null> {
  const where = selector.id
    ? { id: selector.id }
    : typeof selector.appId === "number" && Number.isFinite(selector.appId)
      ? { appId: selector.appId }
      : selector.organizationId
        ? { organizationId: selector.organizationId }
        : { organizationId: null };
  const key = JSON.stringify(where);
  const cached = configCache.get(key);
  if (cached && Date.now() - cached.at < 60_000) return cached.value;
  const db: any = await getDb();
  const row = db ? await db.githubAppConfig.findFirst({ where, orderBy: { createdAt: "asc" } }) : null;
  const value = row ? decryptRow(row) : null;
  configCache.set(key, { at: Date.now(), value });
  return value;
}

/** The app a client connects with: its own, else the shared one when there is one. */
export async function appForOrganization(organizationId: string): Promise<GithubAppSecrets | null> {
  return (await getGithubApp({ organizationId })) ?? (await getGithubApp());
}

/** The app an installation belongs to (recorded when it was connected). */
async function appForInstallation(installationId: number): Promise<GithubAppSecrets | null> {
  const db: any = await getDb();
  const row = db ? await db.githubInstallation.findUnique({ where: { installationId: BigInt(installationId) }, select: { githubAppConfigId: true, organizationId: true } }) : null;
  if (row?.githubAppConfigId) return getGithubApp({ id: row.githubAppConfigId });
  if (row?.organizationId) return appForOrganization(row.organizationId);
  return getGithubApp();
}

/** RS256 JWT identifying the app itself (9-minute expiry; GitHub allows 10). */
export function appJwt(app: Pick<GithubAppSecrets, "appId" | "privateKey">, now: number = Date.now()): string {
  const seconds = Math.floor(now / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: seconds - 60, exp: seconds + 9 * 60, iss: String(app.appId) })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(app.privateKey).toString("base64url");
  return `${unsigned}.${signature}`;
}

export class GithubApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function github<T>(path: string, init: { token?: string; bearer?: string; method?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "jongo-app"
  };
  if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
  if (init.token) headers.authorization = `token ${init.token}`;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${API}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new GithubApiError(detail?.message ? `GitHub: ${detail.message}` : `GitHub returned HTTP ${response.status}`, response.status);
  }
  return (response.status === 204 ? null : await response.json()) as T;
}

const tokenCache = new Map<number, { token: string; expiresAt: number }>();

/** A token scoped to one customer's install (and only the repos they picked). */
export async function installationToken(installationId: number, appOverride?: GithubAppSecrets | null): Promise<string> {
  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAt - Date.now() > 5 * 60_000) return cached.token;
  const app = appOverride ?? (await appForInstallation(installationId));
  if (!app) throw new GithubApiError("GitHub isn't connected for this client.", 503);
  const result = await github<{ token: string; expires_at: string }>(`/app/installations/${installationId}/access_tokens`, {
    bearer: appJwt(app),
    method: "POST"
  });
  tokenCache.set(installationId, { token: result.token, expiresAt: new Date(result.expires_at).getTime() });
  return result.token;
}

export type GithubInstallationInfo = {
  id: number;
  account: { login: string; type: string; id: number };
  repositorySelection: string | null;
  suspended: boolean;
};

/** The installation as GitHub reports it; null when it no longer exists. */
export async function getInstallation(installationId: number, appOverride?: GithubAppSecrets | null): Promise<GithubInstallationInfo | null> {
  const app = appOverride ?? (await appForInstallation(installationId));
  if (!app) throw new GithubApiError("GitHub isn't connected for this client.", 503);
  try {
    const raw: any = await github(`/app/installations/${installationId}`, { bearer: appJwt(app) });
    return {
      id: Number(raw.id),
      account: { login: String(raw.account?.login ?? ""), type: String(raw.account?.type ?? "User"), id: Number(raw.account?.id ?? 0) },
      repositorySelection: raw.repository_selection ?? null,
      suspended: Boolean(raw.suspended_at)
    };
  } catch (error) {
    if (error instanceof GithubApiError && error.status === 404) return null;
    throw error;
  }
}

export type GithubRepo = { id: number; name: string; fullName: string; private: boolean; defaultBranch: string };

/** Every repo the customer gave the install access to (up to 1,000). */
export async function listInstallationRepos(installationId: number): Promise<GithubRepo[]> {
  const token = await installationToken(installationId);
  const repos: GithubRepo[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const result = await github<{ repositories: any[]; total_count: number }>(`/installation/repositories?per_page=100&page=${page}`, { token });
    for (const repo of result.repositories ?? []) {
      repos.push({ id: Number(repo.id), name: repo.name, fullName: repo.full_name, private: Boolean(repo.private), defaultBranch: repo.default_branch ?? "main" });
    }
    if (!result.repositories?.length || repos.length >= result.total_count) break;
  }
  return repos;
}

export async function listBranches(installationId: number, fullName: string): Promise<string[]> {
  const token = await installationToken(installationId);
  const branches: string[] = [];
  for (let page = 1; page <= 5; page += 1) {
    const result = await github<Array<{ name: string }>>(`/repos/${fullName}/branches?per_page=100&page=${page}`, { token });
    branches.push(...result.map((branch) => branch.name));
    if (result.length < 100) break;
  }
  return branches;
}

/** What GitHub returns once, when the manifest flow creates the app. */
export type ManifestConversion = {
  id: number;
  slug: string;
  name: string;
  html_url: string;
  client_id: string;
  client_secret: string;
  webhook_secret: string;
  pem: string;
};

export async function convertManifestCode(code: string): Promise<ManifestConversion> {
  return github<ManifestConversion>(`/app-manifests/${encodeURIComponent(code)}/conversions`, { method: "POST" });
}
