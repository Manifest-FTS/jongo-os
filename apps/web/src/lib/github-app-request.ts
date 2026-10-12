/**
 * The Coolify request that creates an app from a customer's private repo
 * through their own GitHub source. Auto-deploy is off: Jongo receives the push
 * webhooks and decides what to deploy.
 */
export type GithubBuildPack = "nixpacks" | "dockerfile";

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
  if (!input.projectUuid?.trim()) return { ok: false, message: "No hosting project is linked to this client yet. Link one in Settings." };
  if (!input.serverUuid?.trim()) return { ok: false, message: "Could not determine which server to create the app on." };
  if (!input.sourceUuid?.trim()) return { ok: false, message: "GitHub is still finishing setup for this client. Try again in a minute." };
  if (!REPO.test(input.repoFullName)) return { ok: false, message: "Choose a repository." };
  if (!input.branch || !BRANCH.test(input.branch)) return { ok: false, message: "Choose a branch." };
  if (input.buildPack !== "nixpacks" && input.buildPack !== "dockerfile") return { ok: false, message: "Choose Auto-detect or Dockerfile." };
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) return { ok: false, message: "The port must be between 1 and 65535." };
  const baseDirectory = normalizeBaseDirectory(input.baseDirectory);
  if (baseDirectory === null) return { ok: false, message: "The base directory must be a folder inside the repo, like apps/web." };
  const name = input.name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "app";

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
      ports_exposes: String(input.port),
      name,
      is_auto_deploy_enabled: false,
      instant_deploy: false,
      ...(baseDirectory ? { base_directory: baseDirectory } : {})
    }
  };
}
