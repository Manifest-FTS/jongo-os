import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { getSiteWorkspace } from "@/lib/repositories";
import { resolveSitePermissionSnapshot } from "@/lib/permissions";
import {
  buildConnectionInfo,
  buildSftpHomePath,
  buildSftpUsername,
  checkSshPublicKey,
  generateSftpPassword,
  MAX_SFTP_PUBLIC_KEYS,
  sftpSupportedFor,
  sshFingerprint
} from "@/lib/sftp-provision";
import { deleteSftpUser, isSftpConfigured, readSftpConfig, upsertSftpUser } from "@/lib/sftp-provision-apply";
import { decryptSecret, encryptSecret } from "@/lib/secret-box";
import { generateDeployKeyPair } from "@/lib/deploy-keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ siteId: string }> };

/**
 * SFTP access for one WordPress app.
 *
 *   GET    — current account, if any, plus connection details
 *   POST   — {}                         create it
 *            { rotate: true }           new password
 *            { addKey: "<public key>" } allow an SSH key
 *            { generateKey: true }      make a key pair; the private key is
 *                                       returned once and never stored
 *            { removeKey: "<SHA256:…>" } stop allowing a key
 *   DELETE — revoke access
 *
 * Gated on canManageSftp (admin only): this hands out read/write access to every
 * file the site is built from, which is the same power as restoring a backup
 * over it. Passwords are stored encrypted (lib/secret-box).
 */

const ENCRYPTED = /^v[12]:/;

/** The stored password in plain text. Legacy rows held it unencrypted. */
function readPassword(stored: string): string {
  return ENCRYPTED.test(stored) ? decryptSecret(stored) : stored;
}

function describeKeys(keys: string[] | null | undefined) {
  return (keys ?? []).map((key) => {
    const [type, blob, ...rest] = key.split(/\s+/);
    return { type, fingerprint: sshFingerprint(blob ?? ""), comment: rest.join(" ") || null };
  });
}

function present(account: Record<string, any> | null) {
  const config = readSftpConfig();
  if (!account || !config) {
    return { configured: isSftpConfigured(), account: null as null };
  }
  return {
    configured: true,
    account: {
      username: account.username,
      // Null when it can't be read back (encryption key changed): rotate to recover.
      password: (() => {
        try {
          return readPassword(account.password);
        } catch {
          return null;
        }
      })(),
      homePath: account.homePath,
      status: account.status,
      providerError: account.providerError ?? null,
      createdAt: account.createdAt,
      lastRotatedAt: account.lastRotatedAt ?? null,
      publicKeys: describeKeys(account.publicKeys),
      maxPublicKeys: MAX_SFTP_PUBLIC_KEYS,
      connection: buildConnectionInfo({
        host: config.publicHost,
        port: config.port,
        username: account.username
      })
    }
  };
}

async function resolve(siteId: string) {
  const session = await auth();
  if (!session?.user?.id) {
    return { ok: false as const, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }

  const workspace = await getSiteWorkspace(siteId, {
    userId: session.user.id,
    email: session.user.email
  });
  if (!workspace) {
    return { ok: false as const, response: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  }

  const permissions = await resolveSitePermissionSnapshot({
    siteId,
    workspace,
    viewer: { userId: session.user.id, email: session.user.email }
  });
  if (!permissions.canManageSftp) {
    return {
      ok: false as const,
      response: NextResponse.json(
        { error: "You do not have permission to manage SFTP access for this app." },
        { status: 403 }
      )
    };
  }

  // The account opens the WordPress files folder; other app types have none.
  if (!sftpSupportedFor(workspace)) {
    return {
      ok: false as const,
      response: NextResponse.json(
        { ok: false, reason: "unsupported_app", message: "SFTP access is available for WordPress sites." },
        { status: 409 }
      )
    };
  }

  const { getDb } = await import("@/lib/db");
  const db = await getDb();
  if (!db || !("sftpAccount" in db)) {
    return {
      ok: false as const,
      response: NextResponse.json(
        { ok: false, reason: "feature_unavailable", message: "SFTP access is not available in this environment yet." },
        { status: 503 }
      )
    };
  }

  return {
    ok: true as const,
    ctx: { db, workspace, actorId: session.user.id, resourceUuid: String(workspace.coolifyServiceUuid ?? "").trim() }
  };
}

async function audit(db: any, workspace: { id: string; organizationId?: string }, actorId: string, details: Record<string, unknown>) {
  try {
    await db.auditLog.create({
      data: { organizationId: workspace.organizationId, actorId, action: "site_updated", resourceType: "site", resourceId: workspace.id, details }
    });
  } catch (error) {
    // Never fail a working provision because the audit row did not write.
    console.error("sftp: audit write failed", error);
  }
}

export async function GET(_request: Request, { params }: Params) {
  const { siteId } = await params;
  const resolved = await resolve(siteId);
  if (!resolved.ok) return resolved.response;
  const { db, workspace } = resolved.ctx;

  let account = await (db as any).sftpAccount.findFirst({ where: { siteId: workspace.id } });
  // A row from before encryption: encrypt it now that it has been read.
  if (account && !ENCRYPTED.test(account.password)) {
    try {
      account = await (db as any).sftpAccount.update({ where: { id: account.id }, data: { password: encryptSecret(account.password) } });
    } catch (error) {
      console.error("sftp: could not encrypt a legacy password", error);
    }
  }
  return NextResponse.json({ ok: true, ...present(account) });
}

export async function POST(request: Request, { params }: Params) {
  const { siteId } = await params;
  const resolved = await resolve(siteId);
  if (!resolved.ok) return resolved.response;
  const { db, workspace, actorId, resourceUuid } = resolved.ctx;

  if (!isSftpConfigured()) {
    return NextResponse.json(
      {
        ok: false,
        reason: "not_configured",
        message: "SFTP is not configured on this platform yet, so access cannot be provisioned."
      },
      { status: 503 }
    );
  }

  if (!resourceUuid) {
    return NextResponse.json(
      { ok: false, reason: "not_linked", message: "This app is not linked to a running resource." },
      { status: 409 }
    );
  }

  const body = (await request.json().catch(() => ({}))) as {
    rotate?: unknown;
    addKey?: unknown;
    generateKey?: unknown;
    removeKey?: unknown;
  };
  const existing = await (db as any).sftpAccount.findFirst({ where: { siteId: workspace.id } });

  // --- SSH keys: change the allowed keys, keep the password -----------------
  if (body.addKey !== undefined || body.generateKey || body.removeKey !== undefined) {
    if (!existing) {
      return NextResponse.json({ ok: false, reason: "no_account", message: "Create SFTP access first, then add a key." }, { status: 409 });
    }
    const keys: string[] = [...(existing.publicKeys ?? [])];
    let privateKey: string | null = null;
    let actionType: string;
    let fingerprint: string;

    if (body.removeKey !== undefined) {
      fingerprint = String(body.removeKey);
      const next = keys.filter((key) => sshFingerprint(key.split(/\s+/)[1] ?? "") !== fingerprint);
      if (next.length === keys.length) {
        return NextResponse.json({ ok: false, reason: "key_not_found", message: "That key isn't on this account." }, { status: 404 });
      }
      keys.splice(0, keys.length, ...next);
      actionType = "sftp_key_removed";
    } else {
      if (keys.length >= MAX_SFTP_PUBLIC_KEYS) {
        return NextResponse.json(
          { ok: false, reason: "too_many_keys", message: `An account can have up to ${MAX_SFTP_PUBLIC_KEYS} SSH keys. Remove one first.` },
          { status: 409 }
        );
      }
      let line: string;
      if (body.generateKey) {
        const pair = generateDeployKeyPair(`jongo-sftp-${existing.username}`);
        line = pair.publicKey;
        privateKey = pair.privateKey;
      } else {
        line = String(body.addKey ?? "");
      }
      const checked = checkSshPublicKey(line);
      if (!checked.ok) return NextResponse.json({ ok: false, reason: "invalid_key", message: checked.message }, { status: 400 });
      if (keys.some((key) => sshFingerprint(key.split(/\s+/)[1] ?? "") === checked.fingerprint)) {
        return NextResponse.json({ ok: false, reason: "duplicate_key", message: "That key is already on this account." }, { status: 409 });
      }
      keys.push(checked.key);
      fingerprint = checked.fingerprint;
      actionType = body.generateKey ? "sftp_key_generated" : "sftp_key_added";
    }

    let currentPassword: string;
    try {
      currentPassword = readPassword(existing.password);
    } catch {
      return NextResponse.json(
        { ok: false, reason: "password_unreadable", message: "The saved password can't be read. Generate a new password first, then change keys." },
        { status: 409 }
      );
    }
    const applied = await upsertSftpUser({
      username: existing.username,
      password: currentPassword,
      homePath: existing.homePath,
      publicKeys: keys
    });
    if (!applied.ok) {
      return NextResponse.json({ ok: false, reason: applied.reason, message: applied.message }, { status: 502 });
    }
    const saved = await (db as any).sftpAccount.update({ where: { id: existing.id }, data: { publicKeys: keys, status: "active", providerError: null } });
    await audit(db, workspace, actorId, { actionType, username: existing.username, fingerprint });

    return NextResponse.json({
      ok: true,
      ...present(saved),
      // Shown once, for download. Jongo keeps only the public half.
      privateKey,
      message:
        actionType === "sftp_key_removed"
          ? "The key can no longer log in."
          : privateKey
            ? "Key created. Download it now: Jongo doesn't keep a copy."
            : "Key added. It can log in now."
    });
  }

  // --- Create, or rotate the password ---------------------------------------
  const rotate = Boolean(body.rotate);

  // An existing account keeps its password unless a rotation is asked for:
  // regenerating it silently would break every client already using it.
  if (existing && !rotate) {
    return NextResponse.json({ ok: true, ...present(existing), message: "SFTP access is already set up." });
  }

  let username: string;
  let homePath: string;
  try {
    username = existing?.username ?? buildSftpUsername({ siteSlug: workspace.slug, resourceUuid });
    homePath = buildSftpHomePath(resourceUuid);
  } catch {
    return NextResponse.json(
      {
        ok: false,
        reason: "unsafe_identifier",
        message: "This app's identifiers could not be turned into a safe SFTP path, so nothing was created."
      },
      { status: 409 }
    );
  }

  const password = generateSftpPassword();
  let sealed: string;
  try {
    sealed = encryptSecret(password);
  } catch {
    // Fail closed: never hand out a password that would be stored in plain text.
    return NextResponse.json(
      { ok: false, reason: "encryption_unavailable", message: "SFTP passwords can't be stored safely right now, so nothing was changed. Contact support." },
      { status: 503 }
    );
  }

  // The SFTP service is changed first. A row written before the account exists
  // would show a client credentials that do not work.
  const applied = await upsertSftpUser({ username, password, homePath, publicKeys: existing?.publicKeys ?? [] });
  if (!applied.ok) {
    if (existing) {
      await (db as any).sftpAccount.update({
        where: { id: existing.id },
        data: { status: "failed", providerError: applied.reason }
      });
    }
    return NextResponse.json({ ok: false, reason: applied.reason, message: applied.message }, { status: 502 });
  }

  const saved = existing
    ? await (db as any).sftpAccount.update({
        where: { id: existing.id },
        data: {
          password: sealed,
          homePath,
          status: "active",
          providerError: null,
          lastRotatedAt: new Date()
        }
      })
    : await (db as any).sftpAccount.create({
        data: { siteId: workspace.id, username, password: sealed, homePath, status: "active", createdBy: actorId }
      });

  await audit(db, workspace, actorId, { actionType: existing ? "sftp_password_rotated" : "sftp_access_created", username });

  return NextResponse.json({
    ok: true,
    ...present(saved),
    message: existing ? "A new SFTP password has been generated." : "SFTP access is ready."
  });
}

export async function DELETE(_request: Request, { params }: Params) {
  const { siteId } = await params;
  const resolved = await resolve(siteId);
  if (!resolved.ok) return resolved.response;
  const { db, workspace, actorId } = resolved.ctx;

  const existing = await (db as any).sftpAccount.findFirst({ where: { siteId: workspace.id } });
  if (!existing) {
    return NextResponse.json({ ok: true, configured: isSftpConfigured(), account: null });
  }

  const removed = await deleteSftpUser(existing.username);
  if (!removed.ok) {
    await (db as any).sftpAccount.update({
      where: { id: existing.id },
      data: { status: "failed", providerError: removed.reason }
    });
    return NextResponse.json({ ok: false, reason: removed.reason, message: removed.message }, { status: 502 });
  }

  await (db as any).sftpAccount.delete({ where: { id: existing.id } });
  await audit(db, workspace, actorId, { actionType: "sftp_access_revoked", username: existing.username });

  return NextResponse.json({
    ok: true,
    configured: isSftpConfigured(),
    account: null,
    message: "SFTP access has been revoked."
  });
}
