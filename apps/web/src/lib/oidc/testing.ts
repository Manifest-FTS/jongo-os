/** Test-only helpers for the OIDC modules: an in-memory fake of the Prisma delegates they use. Not imported by app code. */
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { hashClientSecret, type OidcClientRecord } from "./clients";
import type { OidcConfig } from "./config";

export function newSigningKeyJwk(): string {
  const { privateKey } = generateKeyPairSync("ed25519");
  return JSON.stringify(privateKey.export({ format: "jwk" }));
}

export function newSigningKeyPem(): string {
  const { privateKey } = generateKeyPairSync("ed25519");
  return privateKey.export({ format: "pem", type: "pkcs8" }).toString();
}

export function testConfig(overrides: Partial<OidcConfig> = {}): OidcConfig {
  return { issuer: "https://jongo.example", signingKey: newSigningKeyJwk(), previousPublicKeys: null, ...overrides };
}

export const ids = {
  org: "20000000-0000-4000-8000-000000000001",
  site: "20000000-0000-4000-8000-000000000002",
  user: "20000000-0000-4000-8000-000000000003",
  client: "20000000-0000-4000-8000-000000000004"
};

export const CLIENT_ID = "jc_AAAAAAAAAAAAAAAAAAAAAA";
export const CLIENT_SECRET = "jcs_test-secret-value-that-is-long-enough-0123456789";
export const REDIRECT_URI = "https://site.example/craft/auth/callback";

export function makeClient(overrides: Partial<OidcClientRecord> = {}): OidcClientRecord {
  return {
    id: ids.client, clientId: CLIENT_ID, organizationId: ids.org, siteId: ids.site, name: "Golf Lab Craft",
    datasetName: "production", status: "active", secretHash: hashClientSecret(CLIENT_SECRET),
    previousSecretHash: null, previousSecretExpiresAt: null,
    redirectUris: [REDIRECT_URI], allowedOrigins: ["https://site.example"], ...overrides
  };
}

type Row = Record<string, any>;

export class FakeOidcDb {
  clients: OidcClientRecord[] = [];
  codes: Row[] = [];
  consents: Row[] = [];
  audits: Row[] = [];
  failAudit = false;
  /** Awaited inside updateMany so concurrent redemptions interleave like real round trips. */
  tick: () => Promise<void> = async () => undefined;

  oidcClient = {
    findUnique: async ({ where }: { where: { clientId: string } }) => this.clients.find((c) => c.clientId === where.clientId) ?? null
  };

  oidcAuthCode = {
    create: async ({ data }: { data: Row }) => {
      if (this.codes.some((c) => c.codeHash === data.codeHash)) throw Object.assign(new Error("unique"), { code: "P2002" });
      const row = { id: randomUUID(), consumedAt: null, ...data };
      this.codes.push(row);
      return row;
    },
    findUnique: async ({ where }: { where: { codeHash: string } }): Promise<any> => {
      const row = this.codes.find((c) => c.codeHash === where.codeHash);
      return row ? { ...row } : null;
    },
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      await this.tick();
      const matches = this.codes.filter((c) => c.codeHash === where.codeHash &&
        (where.consumedAt !== null || c.consumedAt === null) &&
        (!where.expiresAt?.gt || c.expiresAt.getTime() > where.expiresAt.gt.getTime()));
      for (const row of matches) Object.assign(row, data);
      return { count: matches.length };
    },
    deleteMany: async ({ where }: { where: Row }) => {
      const before = this.codes.length;
      this.codes = this.codes.filter((c) => !(where.expiresAt?.lt && c.expiresAt.getTime() < where.expiresAt.lt.getTime()));
      return { count: before - this.codes.length };
    }
  };

  oidcConsent = {
    findUnique: async ({ where }: { where: { userId_oidcClientId: { userId: string; oidcClientId: string } } }) =>
      this.consents.find((c) => c.userId === where.userId_oidcClientId.userId && c.oidcClientId === where.userId_oidcClientId.oidcClientId) ?? null,
    upsert: async ({ where, create, update }: { where: { userId_oidcClientId: { userId: string; oidcClientId: string } }; create: Row; update: Row }) => {
      const existing = this.consents.find((c) => c.userId === where.userId_oidcClientId.userId && c.oidcClientId === where.userId_oidcClientId.oidcClientId);
      if (existing) Object.assign(existing, update);
      else this.consents.push({ revokedAt: null, ...create });
    }
  };

  auditLog = {
    create: async ({ data }: { data: Row }) => {
      if (this.failAudit) throw new Error("audit unavailable");
      this.audits.push(data);
      return data;
    }
  };
}
