/** Pure constants and helpers shared by the Craft admin routes and UI. No server-only imports: client components use it. */

export type CraftRoleName = "reader" | "editor" | "publisher" | "admin";

export const CRAFT_ROLE_OPTIONS: ReadonlyArray<{ value: CraftRoleName; label: string; help: string }> = [
  { value: "reader", label: "Reader", help: "Can view published content in the studio." },
  { value: "editor", label: "Editor", help: "Can edit drafts." },
  { value: "publisher", label: "Publisher", help: "Can edit and publish." },
  { value: "admin", label: "Admin", help: "Everything a publisher can do, plus export." }
];

export const NO_CRAFT_ACCESS_LABEL = "No Craft access";
export const CRAFT_INVITE_HELP = "Lets this person sign in to the app's Craft studio with their Jongo account. Applied when they accept. Only the client owner and admins can set this.";

/**
 * Environment names the customer site reads for "Sign in with Jongo".
 * Names follow docs/craft-sso-design.md section 4.6 (the relying party is built in Phase 2); change them here only.
 */
export const CRAFT_RP_ENV = {
  enabled: "CRAFT_SSO_ENABLED",
  issuer: "CRAFT_SSO_ISSUER",
  clientId: "CRAFT_SSO_CLIENT_ID",
  clientSecret: "CRAFT_SSO_CLIENT_SECRET",
  redirectUri: "CRAFT_SSO_REDIRECT_URI"
} as const;

export const SECRET_PLACEHOLDER = "<paste the client secret from the one-time reveal>";

export type EnvSnippetInput = {
  issuer: string | null;
  clientId: string | null;
  redirectUri: string | null;
  /** Only passed while the one-time reveal is on screen; otherwise a placeholder is used. */
  secret?: string | null;
};

/** Plain KEY=value lines; the secret appears only when the caller holds a freshly revealed one. */
export function buildEnvSnippet(input: EnvSnippetInput): string {
  return [
    `${CRAFT_RP_ENV.enabled}=true`,
    `${CRAFT_RP_ENV.issuer}=${input.issuer ?? "<Jongo issuer URL>"}`,
    `${CRAFT_RP_ENV.clientId}=${input.clientId ?? "<client id>"}`,
    `${CRAFT_RP_ENV.clientSecret}=${input.secret ?? SECRET_PLACEHOLDER}`,
    `${CRAFT_RP_ENV.redirectUri}=${input.redirectUri ?? "<one of the redirect URIs above>"}`
  ].join("\n");
}

export type InheritedSource = "platform_admin" | "org_owner" | "org_admin";
export function inheritedLabel(source: InheritedSource): string {
  return source === "platform_admin" ? "Jongo Super Admin" : source === "org_owner" ? "Owner (inherited admin)" : "Client admin (inherited admin)";
}

/** JSON shapes of GET /api/sites/[siteId]/craft-access and /craft-client (dates arrive as ISO strings). */
export type CraftAccessPayload = {
  siteId: string;
  roles: Array<{ value: CraftRoleName; label: string }>;
  maxGrantableRole: CraftRoleName;
  explicit: Array<{
    userId: string; email: string; name: string | null; role: CraftRoleName;
    grantedBy: { email: string; name: string | null } | null; createdAt: string; updatedAt: string;
  }>;
  inherited: Array<{
    source: InheritedSource; label: string; role: "admin"; userId: string | null; email: string | null; name: string | null; contacts?: string[];
  }>;
};

export type CraftClientDto = {
  clientId: string; name: string; datasetName: string; status: "active" | "disabled";
  redirectUris: string[]; allowedOrigins: string[];
  createdAt: string; rotatedAt: string | null; disabledAt: string | null; previousSecretValidUntil: string | null;
};

export type CraftClientPayload = { siteId: string; client: CraftClientDto | null; issuer: string | null };
