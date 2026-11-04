/**
 * Deploy keys: how Jongo reads a private repository on GitLab, Bitbucket,
 * Codeberg, a self-hosted Git server — any host — without an OAuth app.
 *
 * Jongo makes an ed25519 key pair, stores the private half in hosting
 * (Coolify's documented POST /api/v1/security/keys) and keeps only the public
 * half, which the client adds to their repository as a read-only deploy key.
 * The private key is never stored by Jongo and never shown.
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";

function sshString(value: Buffer | string): Buffer {
  const data = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, data]);
}

function wrap(base64: string): string {
  return base64.match(/.{1,70}/g)?.join("\n") ?? base64;
}

/**
 * A new ed25519 key pair in OpenSSH formats: `publicKey` is the one line a Git
 * host asks for; `privateKey` is "-----BEGIN OPENSSH PRIVATE KEY-----".
 */
export function generateDeployKeyPair(comment: string): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = publicKey.export({ format: "jwk" });
  const priv = privateKey.export({ format: "jwk" });
  const publicRaw = Buffer.from(pub.x as string, "base64url");
  const seed = Buffer.from(priv.d as string, "base64url");

  const keyType = "ssh-ed25519";
  const publicBlob = Buffer.concat([sshString(keyType), sshString(publicRaw)]);
  const safeComment = comment.replace(/[^\w.@-]+/g, "-").slice(0, 80);

  const check = randomBytes(4);
  let privateSection = Buffer.concat([
    check,
    check,
    sshString(keyType),
    sshString(publicRaw),
    sshString(Buffer.concat([seed, publicRaw])),
    sshString(safeComment)
  ]);
  const padding = Buffer.from(Array.from({ length: (8 - (privateSection.length % 8)) % 8 }, (_, i) => i + 1));
  privateSection = Buffer.concat([privateSection, padding]);

  const body = Buffer.concat([
    Buffer.from("openssh-key-v1\0", "binary"),
    sshString("none"),
    sshString("none"),
    sshString(Buffer.alloc(0)),
    Buffer.from([0, 0, 0, 1]),
    sshString(publicBlob),
    sshString(privateSection)
  ]);

  return {
    publicKey: `${keyType} ${publicBlob.toString("base64")} ${safeComment}`,
    privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${wrap(body.toString("base64"))}\n-----END OPENSSH PRIVATE KEY-----\n`
  };
}

type Deps = {
  db: any;
  uploadKey: (body: { name: string; description: string; private_key: string }) => Promise<{ ok: boolean; status?: number; body?: unknown }>;
};

async function defaultDeps(): Promise<Deps> {
  const [{ db }, core] = await Promise.all([import("@/lib/db"), import("@/lib/coolify-core")]);
  return { db, uploadKey: (body) => core.coolifyMutateWithResponse("/api/v1/security/keys", "POST", body) };
}

export type DeployKeyResult =
  | { ok: true; id: string; publicKey: string }
  | { ok: false; status: number; message: string };

/** Make a deploy key for this client and return its public half. */
export async function createDeployKey(
  input: { organizationId: string; actorId: string; label?: string },
  injected?: Partial<Deps>
): Promise<DeployKeyResult> {
  const deps = { ...(await defaultDeps()), ...injected } as Deps;
  const label = (input.label ?? "").trim().slice(0, 60) || "deploy key";
  const { publicKey, privateKey } = generateDeployKeyPair(`jongo-${label}`);

  const uploaded = await deps.uploadKey({
    name: `jongo-${input.organizationId.slice(0, 8)}-${label}`.slice(0, 100),
    description: `Deploy key for Jongo client ${input.organizationId}.`,
    private_key: privateKey
  });
  const uuid = (uploaded.body as { uuid?: unknown } | undefined)?.uuid;
  if (!uploaded.ok || typeof uuid !== "string" || !uuid) {
    console.error("[deploy-keys] upload failed", { organizationId: input.organizationId, status: uploaded.status });
    return { ok: false, status: 503, message: "Couldn't create the deploy key right now. Try again in a minute." };
  }

  const row = await deps.db.gitDeployKey.create({
    data: { organizationId: input.organizationId, coolifyKeyUuid: uuid, publicKey, label, createdById: input.actorId },
    select: { id: true }
  });
  return { ok: true, id: row.id, publicKey };
}
