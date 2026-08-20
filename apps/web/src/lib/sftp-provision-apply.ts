/**
 * Talking to the SFTP service.
 *
 * SFTPGo exposes a REST API, so provisioning needs no SSH and no shell — unlike
 * the backup and privacy-mode paths, nothing here runs a command on the host.
 * Jongo reaches it over the internal Docker network; the port clients connect to
 * is a separate, public one and is never used from here.
 */

import { buildSftpUserPayload, type SftpUserPayload } from "@/lib/sftp-provision";

export type SftpApplyResult<T = void> =
  | { ok: true; value: T }
  | { ok: false; reason: string; message: string };

type SftpConfig = {
  apiUrl: string;
  adminUsername: string;
  adminPassword: string;
  publicHost: string;
  port: number;
};

/** Read the service's configuration, or say precisely what is missing. */
export function readSftpConfig(): SftpConfig | null {
  const apiUrl = (process.env.SFTPGO_API_URL || "").trim().replace(/\/+$/, "");
  const adminUsername = (process.env.SFTPGO_ADMIN_USERNAME || "").trim();
  const adminPassword = (process.env.SFTPGO_ADMIN_PASSWORD || "").trim();
  const publicHost = (process.env.SFTP_PUBLIC_HOST || "").trim();
  const port = Number(process.env.SFTP_PUBLIC_PORT || 2222);

  if (!apiUrl || !adminUsername || !adminPassword || !publicHost || !Number.isFinite(port)) {
    return null;
  }
  return { apiUrl, adminUsername, adminPassword, publicHost, port };
}

export function isSftpConfigured(): boolean {
  return readSftpConfig() !== null;
}

const NOT_CONFIGURED = {
  ok: false as const,
  reason: "not_configured",
  message: "SFTP is not configured on this platform yet, so access cannot be provisioned."
};

const TIMEOUT_MS = 15_000;

async function request(
  config: SftpConfig,
  path: string,
  init: RequestInit & { token?: string } = {}
): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${config.apiUrl}${path}`, {
      ...init,
      cache: "no-store",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
        ...(init.headers ?? {})
      }
    });
    const body = await response.json().catch(() => null);
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * SFTPGo issues short-lived tokens, so one is fetched per operation rather than
 * cached. Provisioning happens on a button press, not in a hot path.
 */
async function getToken(config: SftpConfig): Promise<SftpApplyResult<string>> {
  try {
    const basic = Buffer.from(`${config.adminUsername}:${config.adminPassword}`).toString("base64");
    const { status, body } = await request(config, "/api/v2/token", {
      method: "GET",
      headers: { Authorization: `Basic ${basic}` }
    });
    const token = (body as { access_token?: string } | null)?.access_token;
    if (status !== 200 || !token) {
      return {
        ok: false,
        reason: status === 401 ? "bad_admin_credentials" : "token_failed",
        message: "Could not authenticate with the SFTP service, so access was not changed."
      };
    }
    return { ok: true, value: token };
  } catch {
    return {
      ok: false,
      reason: "unreachable",
      message: "The SFTP service could not be reached, so access was not changed."
    };
  }
}

/**
 * Create the account, or update it if it already exists.
 *
 * Update rather than create-then-fail: a retry after a partial failure, or a
 * password rotation, must converge on the right state instead of erroring
 * because the username is taken.
 */
export async function upsertSftpUser(input: {
  username: string;
  password: string;
  homePath: string;
}): Promise<SftpApplyResult<{ created: boolean }>> {
  const config = readSftpConfig();
  if (!config) return NOT_CONFIGURED;

  const auth = await getToken(config);
  if (!auth.ok) return auth;

  const payload: SftpUserPayload = buildSftpUserPayload(input);

  try {
    const created = await request(config, "/api/v2/users", {
      method: "POST",
      token: auth.value,
      body: JSON.stringify(payload)
    });
    if (created.status === 201) return { ok: true, value: { created: true } };

    // 409 = the username already exists, which is the normal path for a rotation.
    if (created.status === 409 || created.status === 500) {
      const updated = await request(config, `/api/v2/users/${encodeURIComponent(input.username)}`, {
        method: "PUT",
        token: auth.value,
        body: JSON.stringify(payload)
      });
      if (updated.status === 200) return { ok: true, value: { created: false } };
      return {
        ok: false,
        reason: `update_failed_${updated.status}`,
        message: "The SFTP service refused to update this account, so the credentials were not changed."
      };
    }

    return {
      ok: false,
      reason: `create_failed_${created.status}`,
      message: "The SFTP service refused to create this account, so no access was granted."
    };
  } catch {
    return {
      ok: false,
      reason: "unreachable",
      message: "The SFTP service could not be reached, so access was not changed."
    };
  }
}

/** Revoke access. A 404 counts as success — the account is gone either way. */
export async function deleteSftpUser(username: string): Promise<SftpApplyResult> {
  const config = readSftpConfig();
  if (!config) return NOT_CONFIGURED;

  const auth = await getToken(config);
  if (!auth.ok) return auth;

  try {
    const { status } = await request(config, `/api/v2/users/${encodeURIComponent(username)}`, {
      method: "DELETE",
      token: auth.value
    });
    if (status === 200 || status === 404) return { ok: true, value: undefined };
    return {
      ok: false,
      reason: `delete_failed_${status}`,
      // Worth stating plainly: the danger here is believing access is revoked
      // when the credential still works.
      message: "The SFTP service refused to remove this account, so the credentials may still work."
    };
  } catch {
    return {
      ok: false,
      reason: "unreachable",
      message: "The SFTP service could not be reached, so the account may still exist."
    };
  }
}
