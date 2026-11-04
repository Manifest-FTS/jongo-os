/**
 * The Coolify request that creates an app from a customer's private repo
 * through their own GitHub source. Auto-deploy is off: Jongo receives the push
 * webhooks and decides what to deploy.
 */
import { parsePublicRepoUrl } from "./git-sources";
import { cleanCommand } from "./frameworks";

export type GithubBuildPack = "nixpacks" | "dockerfile" | "static";

/** Vercel-style build settings; each is optional and overrides auto-detection. */
export type BuildSettings = {
  installCommand?: string | null;
  buildCommand?: string | null;
  startCommand?: string | null;
  /** Static sites: the folder with the built files, like /dist. */
  publishDirectory?: string | null;
  /** Build with nixpacks, then serve publishDirectory. */
  isStatic?: boolean;
  /** Static sites: send unknown paths to index.html. */
  isSpa?: boolean;
};

export type GithubApplicationInput = {
  projectUuid: string;
  serverUuid: string;
  sourceUuid: string;
  repoFullName: string;
  branch: string;
  buildPack: GithubBuildPack;
  port: number;
  baseDirectory?: string;
  name: string;
  build?: BuildSettings;
};

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH = /^[^\s~^:?*[\\]+$/;

export function normalizeBaseDirectory(value?: string | null): string | null {
  const trimmed = (value ?? "").trim().replace(/^\/+|\/+$/g, "");
  if (!trimmed) return "";
  if (trimmed.split("/").some((part) => part === ".." || part === "." || part === "")) return null;
  if (!/^[A-Za-z0-9_./-]+$/.test(trimmed)) return null;
  return `/${trimmed}`;
}

export function buildGithubApplicationRequest(
  input: GithubApplicationInput
): { ok: true; body: Record<string, unknown> } | { ok: false; message: string } {
  if (!input.projectUuid?.trim()) return { ok: false, message: "This client's hosting isn't set up yet, so the app wasn't created. Try again in a few minutes." };
  if (!input.serverUuid?.trim()) return { ok: false, message: "Could not determine which server to create the app on." };
  if (!input.sourceUuid?.trim()) return { ok: false, message: "GitHub is still finishing setup for this client. Try again in a minute." };
  if (!REPO.test(input.repoFullName)) return { ok: false, message: "Choose a repository." };
  if (!input.branch || !BRANCH.test(input.branch)) return { ok: false, message: "Choose a branch." };
  if (input.buildPack !== "nixpacks" && input.buildPack !== "dockerfile" && input.buildPack !== "static") {
    return { ok: false, message: "Choose how to build the app." };
  }
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) return { ok: false, message: "The port must be between 1 and 65535." };
  const baseDirectory = normalizeBaseDirectory(input.baseDirectory);
  if (baseDirectory === null) return { ok: false, message: "The base directory must be a folder inside the repo, like apps/web." };
  const name = input.name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "app";

  const build = input.build ?? {};
  const commands: Record<string, string> = {};
  for (const [field, key, label] of [
    ["installCommand", "install_command", "install"],
    ["buildCommand", "build_command", "build"],
    ["startCommand", "start_command", "start"]
  ] as const) {
    const cleaned = cleanCommand(build[field]);
    if (cleaned === null) return { ok: false, message: `The ${label} command must be one line, up to 500 characters.` };
    if (cleaned) commands[key] = cleaned;
  }
  const serveStatic = input.buildPack === "static" || build.isStatic === true;
  let publishDirectory: string | null = null;
  if (serveStatic && build.publishDirectory) {
    const normalized = normalizeBaseDirectory(build.publishDirectory);
    if (normalized === null) return { ok: false, message: "The output folder must be a folder inside the repo, like dist." };
    publishDirectory = normalized || "/";
  }

  return {
    ok: true,
    body: {
      project_uuid: input.projectUuid,
      server_uuid: input.serverUuid,
      environment_name: "production",
      github_app_uuid: input.sourceUuid,
      git_repository: input.repoFullName,
      git_branch: input.branch,
      build_pack: input.buildPack,
      // Static sites are served by the web server on port 80.
      ports_exposes: String(serveStatic ? 80 : input.port),
      name,
      is_auto_deploy_enabled: false,
      instant_deploy: false,
      ...(baseDirectory ? { base_directory: baseDirectory } : {}),
      ...commands,
      ...(build.isStatic === true && input.buildPack === "nixpacks" ? { is_static: true } : {}),
      ...(serveStatic && build.isSpa === true ? { is_spa: true } : {}),
      ...(publishDirectory ? { publish_directory: publishDirectory } : {})
    }
  };
}

/** "Public repository" (Coolify's public-git-repository): no app or key, just the URL. */
export function buildPublicApplicationRequest(
  input: Omit<GithubApplicationInput, "sourceUuid" | "repoFullName"> & { repoUrl: string }
): { ok: true; body: Record<string, unknown> } | { ok: false; message: string } {
  // Validated with the same rules as the private path, then the URL replaces the source.
  const parsed = parsePublicRepoUrl(input.repoUrl);
  if (!parsed.ok) return { ok: false, message: parsed.message };
  const base = buildGithubApplicationRequest({ ...input, sourceUuid: "public", repoFullName: "public/repo" });
  if (!base.ok) return base;
  const { github_app_uuid: _source, ...body } = base.body;
  return { ok: true, body: { ...body, git_repository: parsed.url } };
}

/**
 * Private repository on any Git host, read with a deploy key (Coolify's
 * private-deploy-key). The repo address is the SSH form the host shows, like
 * git@gitlab.com:group/app.git.
 */
export function buildDeployKeyApplicationRequest(
  input: Omit<GithubApplicationInput, "sourceUuid" | "repoFullName"> & { sshUrl: string; privateKeyUuid: string }
): { ok: true; body: Record<string, unknown> } | { ok: false; message: string } {
  const ssh = parseSshRepoUrl(input.sshUrl);
  if (!ssh.ok) return ssh;
  if (!input.privateKeyUuid?.trim()) return { ok: false, message: "Create a deploy key first." };
  const base = buildGithubApplicationRequest({ ...input, sourceUuid: "deploy-key", repoFullName: "deploy/key" });
  if (!base.ok) return base;
  const { github_app_uuid: _source, ...body } = base.body;
  return { ok: true, body: { ...body, git_repository: ssh.url, private_key_uuid: input.privateKeyUuid } };
}

/** git@host:path.git or ssh://git@host[:port]/path.git, nothing else. */
export function parseSshRepoUrl(value: string): { ok: true; url: string; host: string; path: string } | { ok: false; message: string } {
  const input = value.trim();
  const scp = /^([A-Za-z0-9_.-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,}):([A-Za-z0-9_.\/-]+?)(\.git)?$/.exec(input);
  const url = /^ssh:\/\/([A-Za-z0-9_.-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})(:\d{1,5})?\/([A-Za-z0-9_.\/-]+?)(\.git)?$/.exec(input);
  const parts = scp ? { user: scp[1], host: scp[2], port: "", path: scp[3] } : url ? { user: url[1], host: url[2], port: url[3] ?? "", path: url[4] } : null;
  if (!parts || parts.path.split("/").some((segment) => !segment || segment === "." || segment === "..") || parts.path.split("/").length < 2) {
    return { ok: false, message: "Paste the repository's SSH address, like git@gitlab.com:team/app.git." };
  }
  const normalized = parts.port
    ? `ssh://${parts.user}@${parts.host.toLowerCase()}${parts.port}/${parts.path}.git`
    : `${parts.user}@${parts.host.toLowerCase()}:${parts.path}.git`;
  return { ok: true, url: normalized, host: parts.host.toLowerCase(), path: parts.path };
}
