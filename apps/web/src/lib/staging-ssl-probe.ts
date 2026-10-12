import { connect } from "node:tls";
import type { CertificateObservation } from "@/lib/staging-ssl-check";

/**
 * Reads the certificate a hostname actually serves (TLS handshake with SNI).
 * Validation is off on purpose: we want to SEE an invalid certificate (Traefik's
 * default one, a wrong name) and report it, not just fail to connect. The
 * verdict is decided in lib/staging-ssl-check.ts.
 */
export function probeCertificate(hostname: string, timeoutMs = 8000): Promise<CertificateObservation> {
  const empty = { subjectAltNames: [], issuer: "", validFrom: "", validTo: "" };
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: CertificateObservation) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };

    const socket = connect({ host: hostname, port: 443, servername: hostname, rejectUnauthorized: false, timeout: timeoutMs }, () => {
      const cert = socket.getPeerCertificate();
      if (!cert || Object.keys(cert).length === 0) return done({ ...empty, error: "tls_error" });
      const issuer = cert.issuer as Record<string, string | string[] | undefined> | undefined;
      const issuerName = [issuer?.CN, issuer?.O].flat().filter(Boolean).join(" ");
      done({
        subjectAltNames: String(cert.subjectaltname ?? "")
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry.startsWith("DNS:"))
          .map((entry) => entry.slice(4)),
        issuer: issuerName,
        validFrom: new Date(cert.valid_from).toISOString(),
        validTo: new Date(cert.valid_to).toISOString()
      });
    });

    socket.on("timeout", () => done({ ...empty, error: "timeout" }));
    socket.on("error", (error: NodeJS.ErrnoException) =>
      done({ ...empty, error: error.code === "ECONNREFUSED" || error.code === "ENOTFOUND" ? "refused" : "tls_error" })
    );
  });
}
