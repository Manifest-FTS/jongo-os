/**
 * Generates the Ed25519 signing key for "Sign in with Jongo" (JONGO_OIDC_SIGNING_KEY).
 *
 *   node scripts/oidc-generate-key.mjs                 print the private JWK (one line) + public JWK + kid
 *   node scripts/oidc-generate-key.mjs --out key.json  write the private JWK to a new file (mode 0600,
 *                                                      refuses to overwrite) and print only public details
 *
 * The private JWK is a secret: store it in the deployment secret store as JONGO_OIDC_SIGNING_KEY. Never commit it,
 * paste it into chat or logs, or reuse NEXTAUTH_SECRET. Nothing here reads .env files or the network.
 * To rotate, see docs/craft-sso-design.md ("Implemented in Phase 1a"): keep the OLD public JWK in
 * JONGO_OIDC_PREVIOUS_PUBLIC_KEYS while relying parties refresh their cache.
 */
import { createHash, generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** RFC 7638 thumbprint of an OKP public key: the same `kid` the server derives. */
export function thumbprint(publicJwk) {
  const canonical = JSON.stringify({ crv: publicJwk.crv, kty: publicJwk.kty, x: publicJwk.x });
  return createHash("sha256").update(canonical).digest("base64url");
}

export function generateSigningKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateJwk = privateKey.export({ format: "jwk" });
  const { kty, crv, x } = publicKey.export({ format: "jwk" });
  const publicJwk = { kty, crv, x };
  return { privateJwk, publicJwk, kid: thumbprint(publicJwk) };
}

function main(argv) {
  const outIndex = argv.indexOf("--out");
  const out = outIndex >= 0 ? argv[outIndex + 1] : null;
  if (outIndex >= 0 && !out) {
    console.error("--out requires a file path");
    process.exit(2);
  }
  const { privateJwk, publicJwk, kid } = generateSigningKey();
  const privateLine = JSON.stringify(privateJwk);

  if (out) {
    // "wx": fail rather than overwrite an existing key file.
    writeFileSync(out, `${privateLine}\n`, { flag: "wx", mode: 0o600 });
    console.log(`Private key written to ${out}. Move it into your secret store (JONGO_OIDC_SIGNING_KEY) and delete the file.`);
  } else {
    console.log("JONGO_OIDC_SIGNING_KEY (secret, single line):");
    console.log(privateLine);
  }
  console.log(`kid: ${kid}`);
  console.log("Public JWK (safe to share; keep it if you later rotate this key out):");
  console.log(JSON.stringify({ ...publicJwk, kid, use: "sig", alg: "EdDSA" }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
