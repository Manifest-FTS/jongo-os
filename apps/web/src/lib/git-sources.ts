/**
 * Git sources, the way Coolify does them: a client adds a GitHub App (name,
 * optional organization), then 1. registers it on GitHub, then 2. installs it
 * on the repos it may read. Pure helpers; I/O is in github-installations.ts.
 */

export type StepState = "todo" | "done" | "blocked";
export type GitSourceStatus = "draft" | "registered" | "finishing" | "ready" | "suspended";

/** Where a source is in Coolify's two steps, and what the page should offer next. */
export function gitSourceSteps(
  app: { appId: number | null },
  install: { status: string; coolifySourceUuid: string | null } | null
): { status: GitSourceStatus; register: StepState; install: StepState } {
  if (!app.appId) return { status: "draft", register: "todo", install: "blocked" };
  if (!install || install.status === "removed") return { status: "registered", register: "done", install: "todo" };
  if (install.status === "suspended") return { status: "suspended", register: "done", install: "done" };
  return { status: install.coolifySourceUuid ? "ready" : "finishing", register: "done", install: "done" };
}

const PUBLIC_HOSTS = new Set(["github.com", "gitlab.com", "bitbucket.org", "codeberg.org"]);

/** A public repository URL for "Public repository" (no app). https only, known hosts, no credentials. */
export function parsePublicRepoUrl(
  input: string
): { ok: true; url: string; host: string; fullName: string } | { ok: false; message: string } {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return { ok: false, message: "Paste the repository's https address, like https://github.com/owner/repo." };
  }
  if (url.protocol !== "https:") return { ok: false, message: "Use the repository's https address." };
  if (url.username || url.password) return { ok: false, message: "Don't put credentials in the address; public repos don't need any." };
  const host = url.hostname.toLowerCase();
  if (!PUBLIC_HOSTS.has(host)) return { ok: false, message: "Use a GitHub, GitLab, Bitbucket or Codeberg repository address." };
  const parts = url.pathname.replace(/\.git\/?$/, "").split("/").filter(Boolean);
  // github.com/owner/repo/tree/branch → owner/repo; GitLab allows nested groups (up to "/-/").
  const stop = parts.findIndex((part) => part === "-" || part === "tree" || part === "blob");
  const path = (stop >= 0 ? parts.slice(0, stop) : parts).slice(0, host === "gitlab.com" ? undefined : 2);
  if (path.length < 2 || path.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part))) {
    return { ok: false, message: "That doesn't look like a repository address (owner/repo)." };
  }
  const fullName = path.join("/").replace(/\.git$/, "");
  return { ok: true, url: `https://${host}/${fullName}`, host, fullName };
}
