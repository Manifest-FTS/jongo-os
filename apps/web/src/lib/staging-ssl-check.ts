/**
 * Has the certificate for a custom staging hostname been issued? Pure: the
 * TLS handshake itself is in lib/staging-ssl-probe.ts.
 *
 * Until Let's Encrypt answers, Traefik serves its own "TRAEFIK DEFAULT CERT".
 * That is normal for a few minutes after attaching, so it reads as pending; if
 * it is still there after 30 minutes something is wrong (usually DNS changed
 * or a proxy in front), and it reads as failed rather than pending forever.
 */

export const SSL_GRACE_MS = 30 * 60_000;

export type CertificateObservation = {
  error?: "timeout" | "refused" | "tls_error";
  subjectAltNames: string[];
  issuer: string;
  validFrom: string;
  validTo: string;
};

export type CertificateVerdict =
  | { status: "issued"; expiresAt: Date }
  | { status: "pending"; reason: "traefik_default_cert" | "unreachable" }
  | { status: "failed"; reason: "timed_out" | "unreachable" | "name_mismatch" | "expired" };

function covers(name: string, host: string): boolean {
  const pattern = name.trim().toLowerCase().replace(/\.$/, "");
  if (pattern === host) return true;
  if (!pattern.startsWith("*.")) return false;
  const rest = pattern.slice(2);
  const dot = host.indexOf(".");
  return dot > 0 && host.slice(dot + 1) === rest;
}

export function evaluateCertificate(
  hostname: string,
  observation: CertificateObservation,
  timing: { attachedAt: Date | string; now?: Date }
): CertificateVerdict {
  const now = timing.now ?? new Date();
  const late = now.getTime() - new Date(timing.attachedAt).getTime() > SSL_GRACE_MS;
  const host = hostname.trim().toLowerCase();

  if (observation.error) return late ? { status: "failed", reason: "unreachable" } : { status: "pending", reason: "unreachable" };

  if (/traefik default cert/i.test(observation.issuer)) {
    return late ? { status: "failed", reason: "timed_out" } : { status: "pending", reason: "traefik_default_cert" };
  }

  const validTo = new Date(observation.validTo);
  if (!Number.isFinite(validTo.getTime()) || validTo.getTime() <= now.getTime()) return { status: "failed", reason: "expired" };

  if (!observation.subjectAltNames.some((name) => covers(name, host))) return { status: "failed", reason: "name_mismatch" };

  return { status: "issued", expiresAt: validTo };
}

export const SSL_MESSAGES: Record<string, string> = {
  traefik_default_cert: "Waiting for Let's Encrypt to issue the certificate. This usually takes a few minutes.",
  unreachable: "We could not reach this address over HTTPS yet.",
  timed_out:
    "The certificate was not issued within 30 minutes. Check the DNS record still points at Jongo and is not proxied (Cloudflare must be DNS only).",
  name_mismatch: "The certificate served does not cover this hostname. Check nothing else (a CDN or proxy) sits in front of it.",
  expired: "The certificate has expired. Check the DNS record still points at Jongo so it can renew."
};
