/**
 * The GitHub App manifest Jongo submits to create a GitHub App. Normally each
 * client gets its own app, created on the client's own GitHub account or
 * organization when they click Connect GitHub (private: only that account can
 * install it). Read-only access to code and metadata; webhooks come to Jongo
 * (installation and installation_repositories events are always delivered to
 * an app and cannot be listed here).
 */
export function buildAppManifest(input: { baseUrl: string; name: string; public?: boolean }) {
  const base = input.baseUrl.replace(/\/+$/, "");
  return {
    name: input.name,
    url: base,
    hook_attributes: { url: `${base}/api/github/webhook`, active: true },
    redirect_url: `${base}/api/github/app/manifest-callback`,
    setup_url: `${base}/api/github/install-callback`,
    setup_on_update: true,
    public: input.public ?? true,
    default_permissions: { contents: "read", metadata: "read" },
    default_events: ["push", "repository"]
  };
}

/** GitHub App names are unique across GitHub and at most 34 characters. */
export function clientAppName(clientSlug: string, organizationId: string): string {
  const suffix = ` ${organizationId.replace(/-/g, "").slice(0, 6)}`;
  const slug = clientSlug.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "client";
  return `Jongo ${slug}`.slice(0, 34 - suffix.length).replace(/-+$/, "") + suffix;
}
