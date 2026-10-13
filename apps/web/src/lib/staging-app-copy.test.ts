import { describe, expect, it } from "vitest";
import { buildStagingAppCopyRequest, stagingEnvVarsToCopy } from "./staging-app-copy";

const placement = { projectUuid: "p1", serverUuid: "srv", environmentName: "stage", environmentUuid: "env-stage", destinationUuid: "" };
const githubApps = [
  { id: 0, uuid: "public-gh", is_public: true },
  { id: 2, uuid: "gh-manifest", is_public: false }
];
const source = {
  uuid: "aboehjcqgrtkjccsnta6ndev",
  name: "Bonsai Visual Feedback API",
  git_repository: "Manifest-FTS/bonsai-visual-feedback",
  git_branch: "main",
  build_pack: "dockerfile",
  source_type: "App\\Models\\GithubApp",
  source_id: 2,
  private_key_id: null,
  ports_exposes: "3005",
  base_directory: "/",
  dockerfile_location: "/Api.Dockerfile",
  docker_compose_location: "/docker-compose.yaml",
  install_command: null,
  build_command: null,
  start_command: null,
  publish_directory: "/",
  health_check_enabled: false,
  health_check_path: "/health"
};

describe("buildStagingAppCopyRequest", () => {
  it("copies a private-GitHub Dockerfile app into the staging environment", () => {
    const result = buildStagingAppCopyRequest({ source, githubApps, privateKeys: [], placement, name: "staging-bonsai-visual-feedback-api", domain: "https://bonsai.staging.mfts.link" });
    expect(result).toEqual({
      ok: true,
      path: "/api/v1/applications/private-github-app",
      body: {
        name: "staging-bonsai-visual-feedback-api",
        project_uuid: "p1",
        server_uuid: "srv",
        environment_name: "stage",
        environment_uuid: "env-stage",
        github_app_uuid: "gh-manifest",
        git_repository: "Manifest-FTS/bonsai-visual-feedback",
        git_branch: "main",
        build_pack: "dockerfile",
        ports_exposes: "3005",
        base_directory: "/",
        dockerfile_location: "/Api.Dockerfile",
        publish_directory: "/",
        health_check_enabled: false,
        health_check_path: "/health",
        domains: "https://bonsai.staging.mfts.link",
        instant_deploy: false,
        is_auto_deploy_enabled: false
      }
    });
  });

  it("uses a different branch for staging when one is given", () => {
    const result = buildStagingAppCopyRequest({ source, githubApps, privateKeys: [], placement, name: "s", branch: "develop" });
    expect(result.ok && result.body.git_branch).toBe("develop");
  });

  it("uses the public endpoint for public GitHub repos", () => {
    const result = buildStagingAppCopyRequest({ source: { ...source, source_id: 0, git_repository: "acme/site" }, githubApps, privateKeys: [], placement, name: "s" });
    expect(result.ok && result.path).toBe("/api/v1/applications/public");
    expect(result.ok && result.body.git_repository).toBe("https://github.com/acme/site");
    expect(result.ok && "github_app_uuid" in result.body).toBe(false);
  });

  it("uses the deploy-key endpoint for repos cloned with a key", () => {
    const result = buildStagingAppCopyRequest({
      source: { ...source, source_type: null, source_id: null, private_key_id: 7, git_repository: "git@gitlab.com:acme/site.git" },
      githubApps,
      privateKeys: [{ id: 7, uuid: "key-7" }],
      placement,
      name: "s"
    });
    expect(result.ok && result.path).toBe("/api/v1/applications/private-deploy-key");
    expect(result.ok && result.body.private_key_uuid).toBe("key-7");
  });

  it("copies Nixpacks commands and keeps compose apps' compose file", () => {
    const nix = buildStagingAppCopyRequest({ source: { ...source, build_pack: "nixpacks", install_command: "pnpm i", build_command: "pnpm build", start_command: "pnpm start" }, githubApps, privateKeys: [], placement, name: "s" });
    expect(nix.ok && [nix.body.install_command, nix.body.build_command, nix.body.start_command]).toEqual(["pnpm i", "pnpm build", "pnpm start"]);
    expect(nix.ok && "dockerfile_location" in nix.body).toBe(false);
    const compose = buildStagingAppCopyRequest({ source: { ...source, build_pack: "dockercompose" }, githubApps, privateKeys: [], placement, name: "s" });
    expect(compose.ok && compose.body.docker_compose_location).toBe("/docker-compose.yaml");
  });

  it("refuses what it cannot copy faithfully, saying why", () => {
    expect(buildStagingAppCopyRequest({ source: { ...source, source_id: 99 }, githubApps, privateKeys: [], placement, name: "s" })).toEqual({ ok: false, reason: "source_not_found" });
    expect(buildStagingAppCopyRequest({ source: { ...source, git_repository: "" }, githubApps, privateKeys: [], placement, name: "s" })).toEqual({ ok: false, reason: "no_repository" });
    expect(buildStagingAppCopyRequest({ source: { ...source, build_pack: "dockerimage" }, githubApps, privateKeys: [], placement, name: "s" })).toEqual({ ok: false, reason: "unsupported_build_pack" });
    expect(buildStagingAppCopyRequest({ source, githubApps, privateKeys: [], placement: { ...placement, serverUuid: "" }, name: "s" })).toEqual({ ok: false, reason: "no_placement" });
  });
});

describe("stagingEnvVarsToCopy", () => {
  it("copies production variables only, never preview or platform-generated ones", () => {
    const rows = [
      { key: "API_URL", value: "https://x", is_preview: false, is_coolify: false, is_literal: true, is_multiline: false, is_buildtime: true, is_runtime: true },
      { key: "API_URL", value: "https://preview", is_preview: true },
      { key: "COOLIFY_FQDN", value: "x", is_preview: false, is_coolify: true },
      { key: "", value: "x", is_preview: false }
    ];
    expect(stagingEnvVarsToCopy(rows)).toEqual([{ key: "API_URL", value: "https://x", is_preview: false, is_literal: true, is_multiline: false }]);
  });
});
