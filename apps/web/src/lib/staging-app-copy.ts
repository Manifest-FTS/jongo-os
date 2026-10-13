/**
 * Staging for apps (Next.js, Sanity, anything built from a repo): a new
 * application in the staging environment, built from the same repo, source,
 * build settings and production environment variables. Coolify has no clone
 * endpoint for applications, so this is how its own "clone" is reproduced.
 * Pure: the request is decided here and tested; lib/coolify.ts sends it.
 */

type Row = Record<string, unknown>;

export type StagingAppPlacement = {
  projectUuid: string;
  serverUuid: string;
  environmentName: string;
  environmentUuid: string;
  destinationUuid?: string;
};

export type StagingAppCopyRefusal = "no_repository" | "source_not_found" | "unsupported_build_pack" | "no_placement";

const BUILD_PACKS = new Set(["nixpacks", "railpack", "dockerfile", "static", "dockercompose"]);

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

export function buildStagingAppCopyRequest(input: {
  source: Row;
  githubApps: Row[];
  privateKeys: Row[];
  placement: StagingAppPlacement;
  name: string;
  /** Full URL(s), comma-separated, as Coolify's `domains` field takes them. */
  domain?: string | null;
  /** Staging branch, when the site builds staging from another branch. */
  branch?: string | null;
}): { ok: true; path: string; body: Record<string, unknown> } | { ok: false; reason: StagingAppCopyRefusal } {
  const { source, placement } = input;
  if (!placement.projectUuid || !placement.serverUuid || !(placement.environmentUuid || placement.environmentName)) {
    return { ok: false, reason: "no_placement" };
  }
  const repository = str(source.git_repository);
  if (!repository) return { ok: false, reason: "no_repository" };
  const buildPack = str(source.build_pack);
  if (!BUILD_PACKS.has(buildPack)) return { ok: false, reason: "unsupported_build_pack" };

  let path: string;
  const sourceFields: Record<string, unknown> = {};
  const privateKeyId = str(source.private_key_id);
  if (str(source.source_type).endsWith("GithubApp") && str(source.source_id) !== "") {
    const app = input.githubApps.find((candidate) => str(candidate.id) === str(source.source_id));
    if (!app) return { ok: false, reason: "source_not_found" };
    if (app.is_public === true) {
      path = "/api/v1/applications/public";
      sourceFields.git_repository = /^https?:\/\//.test(repository) ? repository : `https://github.com/${repository}`;
    } else {
      path = "/api/v1/applications/private-github-app";
      sourceFields.github_app_uuid = str(app.uuid);
      sourceFields.git_repository = repository;
    }
  } else if (privateKeyId) {
    const key = input.privateKeys.find((candidate) => str(candidate.id) === privateKeyId);
    if (!key) return { ok: false, reason: "source_not_found" };
    path = "/api/v1/applications/private-deploy-key";
    sourceFields.private_key_uuid = str(key.uuid);
    sourceFields.git_repository = repository;
  } else {
    path = "/api/v1/applications/public";
    sourceFields.git_repository = repository;
  }

  const body: Record<string, unknown> = {
    name: input.name,
    project_uuid: placement.projectUuid,
    server_uuid: placement.serverUuid,
    environment_name: placement.environmentName,
    environment_uuid: placement.environmentUuid,
    ...(placement.destinationUuid ? { destination_uuid: placement.destinationUuid } : {}),
    ...sourceFields,
    git_branch: input.branch?.trim() || str(source.git_branch) || "main",
    build_pack: buildPack
  };

  const copy = (key: string, only?: string[]) => {
    if (only && !only.includes(buildPack)) return;
    const value = source[key];
    if (typeof value === "string" ? value.trim() : typeof value === "boolean" || typeof value === "number") body[key] = value;
  };
  copy("ports_exposes");
  copy("base_directory");
  copy("dockerfile_location", ["dockerfile"]);
  copy("docker_compose_location", ["dockercompose"]);
  copy("install_command", ["nixpacks", "railpack", "static"]);
  copy("build_command", ["nixpacks", "railpack", "static"]);
  copy("start_command", ["nixpacks", "railpack"]);
  copy("publish_directory");
  copy("health_check_enabled");
  copy("health_check_path");
  if (input.domain) body.domains = input.domain;
  body.instant_deploy = false;
  body.is_auto_deploy_enabled = false;

  return { ok: true, path, body };
}

/** Production variables only; never preview copies or ones Coolify generates itself. */
export function stagingEnvVarsToCopy(rows: Row[]): Array<{ key: string; value: string; is_preview: false; is_literal: boolean; is_multiline: boolean }> {
  const out: Array<{ key: string; value: string; is_preview: false; is_literal: boolean; is_multiline: boolean }> = [];
  for (const row of rows) {
    const key = str(row.key);
    if (!key || row.is_preview === true || row.is_coolify === true) continue;
    out.push({ key, value: typeof row.value === "string" ? row.value : "", is_preview: false, is_literal: row.is_literal === true, is_multiline: row.is_multiline === true });
  }
  return out;
}
