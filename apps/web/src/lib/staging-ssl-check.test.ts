import { describe, expect, it } from "vitest";
import { evaluateCertificate, type CertificateObservation } from "./staging-ssl-check";

const now = new Date("2026-10-12T12:00:00Z");
const attachedAt = new Date("2026-10-12T11:55:00Z"); // 5 minutes ago
const cert = (partial: Partial<CertificateObservation>): CertificateObservation => ({
  subjectAltNames: ["staging.clientsite.com"],
  issuer: "R11",
  validFrom: "2026-10-12T11:56:00Z",
  validTo: "2027-01-10T11:56:00Z",
  ...partial
});

describe("evaluateCertificate", () => {
  it("reports a valid Let's Encrypt certificate as issued, with its expiry", () => {
    expect(evaluateCertificate("staging.clientsite.com", cert({}), { attachedAt, now })).toEqual({
      status: "issued",
      expiresAt: new Date("2027-01-10T11:56:00Z")
    });
  });

  it("accepts a wildcard certificate that covers the host", () => {
    expect(evaluateCertificate("staging.clientsite.com", cert({ subjectAltNames: ["*.clientsite.com"] }), { attachedAt, now }).status).toBe("issued");
    expect(evaluateCertificate("a.b.clientsite.com", cert({ subjectAltNames: ["*.clientsite.com"] }), { attachedAt, now }).status).toBe("failed");
  });

  it("treats Traefik's default certificate as pending while Let's Encrypt is still working", () => {
    const pending = evaluateCertificate("staging.clientsite.com", cert({ issuer: "TRAEFIK DEFAULT CERT", subjectAltNames: [] }), { attachedAt, now });
    expect(pending).toEqual({ status: "pending", reason: "traefik_default_cert" });
  });

  it("turns pending into failed after 30 minutes, so a stuck certificate is not hidden", () => {
    const late = new Date(attachedAt.getTime() + 31 * 60_000);
    expect(
      evaluateCertificate("staging.clientsite.com", cert({ issuer: "TRAEFIK DEFAULT CERT", subjectAltNames: [] }), { attachedAt, now: late })
    ).toEqual({ status: "failed", reason: "timed_out" });
  });

  it("fails a certificate for a different name or one that has expired", () => {
    expect(evaluateCertificate("staging.clientsite.com", cert({ subjectAltNames: ["other.example.com"] }), { attachedAt, now })).toEqual({
      status: "failed",
      reason: "name_mismatch"
    });
    expect(evaluateCertificate("staging.clientsite.com", cert({ validTo: "2026-10-01T00:00:00Z" }), { attachedAt, now })).toEqual({
      status: "failed",
      reason: "expired"
    });
  });

  it("treats an unreachable host as pending at first and failed after the grace period", () => {
    expect(evaluateCertificate("staging.clientsite.com", cert({ error: "refused" }), { attachedAt, now })).toEqual({ status: "pending", reason: "unreachable" });
    const late = new Date(attachedAt.getTime() + 31 * 60_000);
    expect(evaluateCertificate("staging.clientsite.com", cert({ error: "timeout" }), { attachedAt, now: late })).toEqual({ status: "failed", reason: "unreachable" });
  });
});
