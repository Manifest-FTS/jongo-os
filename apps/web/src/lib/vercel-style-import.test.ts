import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDeployKeyApplicationRequest, buildGithubApplicationRequest, parseSshRepoUrl } from "./github-app-request";
import { parseGitPush, verifyGitWebhook } from "./git-webhooks";
import { createDeployKey } from "./deploy-keys";
import { parseDotEnv } from "../components/GithubRepoFields";

const base = { projectUuid: "p", serverUuid: "s", sourceUuid: "src", repoFullName: "o/r", branch: "main", port: 3000, name: "My App" };

describe("app creation request", () => {
  it("sends framework build settings to hosting", () => {
    const out = buildGithubApplicationRequest({
      ...base,
      buildPack: "nixpacks",
      build: { installCommand: "pnpm i", buildCommand: "pnpm build", startCommand: "node .output/server/index.mjs" }
    });
    expect(out.ok && out.body).toMatchObject({
      install_command: "pnpm i",
      build_command: "pnpm build",
      start_command: "node .output/server/index.mjs",
      ports_exposes: "3000"
    });
  });

  it("builds front-ends with nixpacks, then serves the output folder on port 80", () => {
    const out = buildGithubApplicationRequest({ ...base, buildPack: "nixpacks", build: { isStatic: true, isSpa: true, publishDirectory: "dist", buildCommand: "npm run build" } });
    expect(out.ok && out.body).toMatchObject({ is_static: true, is_spa: true, publish_directory: "/dist", ports_exposes: "80" });
  });

  it("serves plain HTML as it is", () => {
    const out = buildGithubApplicationRequest({ ...base, buildPack: "static", build: { publishDirectory: "/" } });
    expect(out.ok && out.body).toMatchObject({ build_pack: "static", publish_directory: "/", ports_exposes: "80" });
    expect(out.ok && "is_static" in out.body).toBe(false);
  });

  it("refuses multi-line commands and folders outside the repo", () => {
    expect(buildGithubApplicationRequest({ ...base, buildPack: "nixpacks", build: { buildCommand: "npm run build\ncurl evil" } }).ok).toBe(false);
    expect(buildGithubApplicationRequest({ ...base, buildPack: "nixpacks", build: { isStatic: true, publishDirectory: "../etc" } }).ok).toBe(false);
  });
});

describe("deploy-key repositories", () => {
  it("accepts SSH addresses from any host and normalises them", () => {
    expect(parseSshRepoUrl("git@gitlab.com:Team/sub/app.git")).toMatchObject({ ok: true, url: "git@gitlab.com:Team/sub/app.git", host: "gitlab.com" });
    expect(parseSshRepoUrl("git@bitbucket.org:team/app")).toMatchObject({ ok: true, url: "git@bitbucket.org:team/app.git" });
    expect(parseSshRepoUrl("ssh://git@git.example.com:2222/team/app.git")).toMatchObject({ ok: true, url: "ssh://git@git.example.com:2222/team/app.git" });
  });

  it("refuses anything that isn't a plain SSH repository address", () => {
    for (const bad of ["https://gitlab.com/team/app", "git@gitlab.com:app.git", "git@gitlab.com:team/../x.git", "git@localhost:team/app.git", "git@gitlab.com:team/app.git; rm -rf /", "-oProxyCommand=x@host.com:a/b"]) {
      expect(parseSshRepoUrl(bad).ok).toBe(false);
    }
  });

  it("creates the app with the deploy key and the SSH address", () => {
    const out = buildDeployKeyApplicationRequest({ ...base, buildPack: "nixpacks", sshUrl: "git@gitlab.com:team/app.git", privateKeyUuid: "key-1" });
    expect(out.ok && out.body).toMatchObject({ private_key_uuid: "key-1", git_repository: "git@gitlab.com:team/app.git" });
    expect(out.ok && "github_app_uuid" in out.body).toBe(false);
  });

  it("stores the private key in hosting and keeps only the public half", async () => {
    const uploadKey = vi.fn(async () => ({ ok: true, status: 201, body: { uuid: "coolify-key-1" } }));
    const create = vi.fn(async ({ data }: any) => ({ id: "dk-1", ...data }));
    const out = await createDeployKey({ organizationId: "org-1", actorId: "u1", label: "my app" }, { uploadKey, db: { gitDeployKey: { create } } });
    expect(out).toMatchObject({ ok: true, id: "dk-1" });
    const uploaded = (uploadKey.mock.calls[0] as any[])[0];
    expect(uploaded.private_key).toContain("BEGIN OPENSSH PRIVATE KEY");
    const saved = (create.mock.calls[0] as any[])[0].data;
    expect(saved).toMatchObject({ organizationId: "org-1", coolifyKeyUuid: "coolify-key-1" });
    expect(saved.publicKey).toMatch(/^ssh-ed25519 AAAA/);
    expect(JSON.stringify(saved)).not.toContain("PRIVATE KEY");
  });

  it("saves nothing when hosting refuses the key", async () => {
    const create = vi.fn();
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const out = await createDeployKey({ organizationId: "org-1", actorId: "u1" }, { uploadKey: async () => ({ ok: false, status: 422 }), db: { gitDeployKey: { create } } });
    spy.mockRestore();
    expect(out.ok).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });
});

describe("push webhooks from every host", () => {
  const secret = "s3cret";
  const body = JSON.stringify({ ref: "refs/heads/main", after: "abc123", head_commit: { message: "Fix header\n\nlong" } });
  const sig = createHmac("sha256", secret).update(body).digest("hex");
  const h = (values: Record<string, string>) => new Headers(values);

  it.each([
    ["GitLab", { "x-gitlab-token": secret, "x-gitlab-event": "Push Hook" }],
    ["GitHub", { "x-hub-signature-256": `sha256=${sig}`, "x-github-event": "push" }],
    ["Bitbucket", { "x-hub-signature": `sha256=${sig}`, "x-event-key": "repo:push" }],
    ["Gitea", { "x-gitea-signature": sig, "x-gitea-event": "push" }],
    ["Forgejo", { "x-forgejo-signature": sig, "x-forgejo-event": "push" }]
  ])("verifies %s", (_name, headers) => {
    expect(verifyGitWebhook(h(headers), body, secret)).toBe(true);
    expect(verifyGitWebhook(h(headers), body, "wrong")).toBe(false);
  });

  it("refuses unsigned or tampered requests", () => {
    expect(verifyGitWebhook(h({}), body, secret)).toBe(false);
    expect(verifyGitWebhook(h({ "x-hub-signature-256": `sha256=${sig}` }), body.replace("main", "evil"), secret)).toBe(false);
    expect(verifyGitWebhook(h({ "x-hub-signature-256": sig }), body, secret)).toBe(false); // missing sha256= prefix
  });

  it("reads the branch and commit from each host's payload", () => {
    expect(parseGitPush(h({ "x-github-event": "push" }), JSON.parse(body))).toEqual({ kind: "push", branch: "main", sha: "abc123", message: "Fix header" });
    expect(parseGitPush(h({ "x-gitlab-event": "Push Hook" }), { ref: "refs/heads/dev", checkout_sha: "d1", commits: [{ message: "one" }, { message: "two" }] }))
      .toEqual({ kind: "push", branch: "dev", sha: "d1", message: "two" });
    expect(parseGitPush(h({ "x-event-key": "repo:push" }), { push: { changes: [{ new: { type: "branch", name: "main", target: { hash: "b1", message: "bb\n" } } }] } }))
      .toEqual({ kind: "push", branch: "main", sha: "b1", message: "bb" });
  });

  it("ignores pings, tags, deleted branches and other events", () => {
    expect(parseGitPush(h({ "x-github-event": "ping" }), {})).toEqual({ kind: "ping" });
    expect(parseGitPush(h({ "x-github-event": "push" }), { ref: "refs/tags/v1", after: "a" }).kind).toBe("ignored");
    expect(parseGitPush(h({ "x-github-event": "push" }), { ref: "refs/heads/main", after: "0000000000", deleted: true }).kind).toBe("ignored");
    expect(parseGitPush(h({ "x-gitlab-event": "Merge Request Hook" }), { ref: "refs/heads/main" }).kind).toBe("ignored");
  });
});

describe("pasting a .env file", () => {
  it("reads keys and values, skipping comments and quotes", () => {
    expect(parseDotEnv('# db\nDATABASE_URL="postgres://x"\nexport API_KEY=abc\n\nBAD LINE\nEMPTY=\n')).toEqual([
      { key: "DATABASE_URL", value: "postgres://x" },
      { key: "API_KEY", value: "abc" },
      { key: "EMPTY", value: "" }
    ]);
  });
});
