/**
 * The GitHub App manifest Jongo submits when a platform admin clicks
 * "Create Jongo GitHub App". Read-only access to code and metadata; webhooks
 * come to Jongo (installation and installation_repositories events are always
 * delivered to an app and cannot be listed here).
 */
export function buildAppManifest(input: { baseUrl: string; name: string }) {
  const base = input.baseUrl.replace(/\/+$/, "");
  return {
    name: input.name,
    url: base,
    hook_attributes: { url: `${base}/api/github/webhook`, active: true },
    redirect_url: `${base}/api/github/app/manifest-callback`,
    setup_url: `${base}/api/github/install-callback`,
    setup_on_update: true,
    public: true,
    default_permissions: { contents: "read", metadata: "read" },
    default_events: ["push", "repository"]
  };
}
