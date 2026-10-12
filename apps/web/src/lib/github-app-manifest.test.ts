import { describe, expect, it } from "vitest";
import { buildAppManifest } from "./github-app-manifest";
import { buildGithubApplicationRequest } from "./github-app-request";

describe("buildAppManifest", () => {
  const manifest = buildAppManifest({ baseUrl: "https://jongo.app/", name: "Jongo" });
  it("asks only for read access to code and metadata", () => {
    expect(manifest.default_permissions).toEqual({ contents: "read", metadata: "read" });
    expect(manifest.default_events).toEqual(["push", "repository"]);
  });
  it("points webhooks and redirects at Jongo", () => {
    expect(manifest.hook_attributes).toEqual({ url: "https://jongo.app/api/github/webhook", active: true });
    expect(manifest.redirect_url).toBe("https://jongo.app/api/github/app/manifest-callback");
    expect(manifest.setup_url).toBe("https://jongo.app/api/github/install-callback");
    expect(manifest.public).toBe(true);
  });
});

describe("buildGithubApplicationRequest", () => {
  const input = {
    projectUuid: "p1",
    serverUuid: "srv",
    sourceUuid: "src",
    repoFullName: "acme/web",
    branch: "main",
    buildPack: "nixpacks" as const,
    port: 3000,
    baseDirectory: "",
    name: "acme web"
  };
  it("builds the private GitHub app body with auto-deploy off", () => {
    const result = buildGithubApplicationRequest(input);
    expect(result).toEqual({
      ok: true,
      body: {
        project_uuid: "p1",
        server_uuid: "srv",
        environment_name: "production",
        github_app_uuid: "src",
        git_repository: "acme/web",
        git_branch: "main",
        build_pack: "nixpacks",
        ports_exposes: "3000",
        name: "acme-web",
        is_auto_deploy_enabled: false,
        instant_deploy: false
      }
    });
  });
  it("adds a base directory with a leading slash", () => {
    const result = buildGithubApplicationRequest({ ...input, baseDirectory: "apps/site" });
    expect(result.ok && result.body.base_directory).toBe("/apps/site");
  });
  it("refuses bad input", () => {
    expect(buildGithubApplicationRequest({ ...input, projectUuid: "" }).ok).toBe(false);
    expect(buildGithubApplicationRequest({ ...input, port: 70000 }).ok).toBe(false);
    expect(buildGithubApplicationRequest({ ...input, repoFullName: "not a repo" }).ok).toBe(false);
    expect(buildGithubApplicationRequest({ ...input, baseDirectory: "../etc" }).ok).toBe(false);
    expect(buildGithubApplicationRequest({ ...input, buildPack: "dockercompose" as never }).ok).toBe(false);
  });
});
