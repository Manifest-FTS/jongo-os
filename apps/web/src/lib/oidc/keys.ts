import { createHash, createPrivateKey, createPublicKey, hkdfSync, type KeyObject } from "node:crypto";
import { calculateJwkThumbprint } from "jose";
import { OIDC_ENV, type OidcConfig } from "./config";

/** Public parameters only. There is intentionally no field that can carry `d`. */
export type PublicJwk = { kty: "OKP"; crv: "Ed25519"; x: string; kid: string; use: "sig"; alg: "EdDSA" };

export type OidcKeys = {
  signingKey: KeyObject;
  kid: string;
  /** Current key first, then retired keys that are still published. */
  publicKeys: PublicJwk[];
  /** HMAC secret for the consent form token, derived from the private key (never NEXTAUTH_SECRET). */
  consentSecret: Buffer;
};

/** Error messages name the variable only: never key material. */
export class OidcKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OidcKeyError";
  }
}

async function toPublicJwk(x: string): Promise<PublicJwk> {
  const base = { kty: "OKP", crv: "Ed25519", x } as const;
  const kid = await calculateJwkThumbprint(base, "sha256");
  return { ...base, kid, use: "sig", alg: "EdDSA" };
}

function parsePrivateKey(raw: string): KeyObject {
  try {
    const key = raw.startsWith("{")
      ? createPrivateKey({ key: JSON.parse(raw), format: "jwk" })
      : createPrivateKey(raw);
    if (key.asymmetricKeyType !== "ed25519") throw new Error("not ed25519");
    return key;
  } catch {
    throw new OidcKeyError(`${OIDC_ENV.signingKey}: not a valid Ed25519 private key (JWK JSON or PKCS#8 PEM)`);
  }
}

async function parsePreviousPublicKeys(raw: string | null): Promise<PublicJwk[]> {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new OidcKeyError(`${OIDC_ENV.previousPublicKeys}: not valid JSON`);
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { keys?: unknown })?.keys;
  if (!Array.isArray(list)) throw new OidcKeyError(`${OIDC_ENV.previousPublicKeys}: expected a JWK array or {"keys":[...]}`);
  const out: PublicJwk[] = [];
  for (const entry of list) {
    const jwk = entry as Record<string, unknown> | null;
    if (!jwk || jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") {
      throw new OidcKeyError(`${OIDC_ENV.previousPublicKeys}: every entry must be an Ed25519 OKP public key`);
    }
    // A retired entry carrying private material would be published; refuse the whole set.
    if ("d" in jwk) throw new OidcKeyError(`${OIDC_ENV.previousPublicKeys}: contains private key material`);
    try {
      createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: jwk.x }, format: "jwk" });
    } catch {
      throw new OidcKeyError(`${OIDC_ENV.previousPublicKeys}: an entry is not a valid public key`);
    }
    out.push(await toPublicJwk(jwk.x));
  }
  return out;
}

const cache = new Map<string, Promise<OidcKeys>>();

async function build(config: OidcConfig): Promise<OidcKeys> {
  const signingKey = parsePrivateKey(config.signingKey);
  const exported = createPublicKey(signingKey).export({ format: "jwk" }) as { x?: string };
  if (!exported.x) throw new OidcKeyError(`${OIDC_ENV.signingKey}: could not derive the public key`);
  const current = await toPublicJwk(exported.x);
  const previous = (await parsePreviousPublicKeys(config.previousPublicKeys)).filter((key) => key.kid !== current.kid);
  const d = (signingKey.export({ format: "jwk" }) as { d?: string }).d ?? "";
  const consentSecret = Buffer.from(
    hkdfSync("sha256", Buffer.from(d, "base64url"), Buffer.from("jongo-oidc-consent-v1"), Buffer.from("consent-form-token"), 32)
  );
  return { signingKey, kid: current.kid, publicKeys: [current, ...previous], consentSecret };
}

/** Parsed once per distinct configuration; a failed load is not cached. */
export function loadOidcKeys(config: OidcConfig): Promise<OidcKeys> {
  const id = createHash("sha256").update(config.signingKey).update("\0").update(config.previousPublicKeys ?? "").digest("hex");
  let entry = cache.get(id);
  if (!entry) {
    entry = build(config);
    cache.set(id, entry);
    entry.catch(() => cache.delete(id));
  }
  return entry;
}

export function publicJwks(keys: OidcKeys): { keys: PublicJwk[] } {
  return { keys: keys.publicKeys.map((key) => ({ ...key })) };
}
