import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

const ALGORITHM = "aes-256-gcm";
const FORMAT_VERSION = "v1";

function getSecretKey(): Buffer {
  const secret =
    process.env.WORDPRESS_TELEMETRY_ENCRYPTION_SECRET?.trim() ||
    process.env.NEXTAUTH_SECRET?.trim() ||
    "dev-only-wordpress-telemetry-secret";

  return createHash("sha256").update(secret).digest();
}

export function encryptSecret(value: string): string {
  const plaintext = value.trim();
  if (!plaintext) {
    throw new Error("Cannot encrypt an empty secret");
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, getSecretKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    FORMAT_VERSION,
    iv.toString("base64"),
    authTag.toString("base64"),
    encrypted.toString("base64")
  ].join(":");
}

export function decryptSecret(payload: string): string {
  const [version, ivB64, authTagB64, ciphertextB64] = payload.split(":");
  if (version !== FORMAT_VERSION || !ivB64 || !authTagB64 || !ciphertextB64) {
    throw new Error("Unsupported secret payload format");
  }

  const decipher = createDecipheriv(ALGORITHM, getSecretKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(authTagB64, "base64"));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, "base64")),
    decipher.final()
  ]);

  return decrypted.toString("utf8");
}
