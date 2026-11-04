/**
 * Look inside a repository before it is deployed, to pick a framework preset.
 *
 * Private GitHub repos are read through the client's own install. Public repos
 * are read from GitHub, GitLab, Bitbucket and Codeberg only, through fixed API
 * addresses per host (no URL from the request is fetched as-is), with short
 * timeouts and size limits. Private repos on other hosts (deploy key) can't be
 * read; the person picks the framework.
 */
import { detectFramework, type Detection, type RepoSnapshot } from "@/lib/frameworks";
import { parsePublicRepoUrl } from "@/lib/git-sources";
import { normalizeBaseDirectory } from "@/lib/github-app-request";

export type Inspection = { ok: true; detection: Detection; defaultBranch: string | null } | { ok: false; message: string };

const BRANCH = /^[^\s~^:?*[\\]{1,200}$/;
const MAX_BYTES = 256_000;

async function getText(url: string): Promise<string | null> {
  const response = await fetch(url, {
    headers: { "user-agent": "jongo-app", accept: "application/json, text/plain, */*" },
    redirect: "error",
    signal: AbortSignal.timeout(6000),
    cache: "no-store"
  }).catch(() => null);
  if (!response?.ok) return null;
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_BYTES) return null;
  const text = await response.text().catch(() => null);
  return text && text.length <= MAX_BYTES ? text : null;
}

async function getJson<T>(url: string): Promise<T | null> {
  const text = await getText(url);
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function enc(path: string): string {
  return path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

type PublicReader = {
  defaultBranch(): Promise<string | null>;
  list(ref: string, dir: string): Promise<string[] | null>;
  file(ref: string, path: string): Promise<string | null>;
};

function readerFor(host: string, fullName: string): PublicReader | null {
  const repo = enc(fullName);
  switch (host) {
    case "github.com":
      return {
        defaultBranch: async () => (await getJson<{ default_branch?: string }>(`https://api.github.com/repos/${repo}`))?.default_branch ?? null,
        list: async (ref, dir) =>
          (await getJson<Array<{ name: string }>>(`https://api.github.com/repos/${repo}/contents/${enc(dir)}?ref=${encodeURIComponent(ref)}`))?.map?.((e) => e.name) ?? null,
        file: (ref, path) => getText(`https://raw.githubusercontent.com/${repo}/${encodeURIComponent(ref)}/${enc(path)}`)
      };
    case "gitlab.com": {
      const id = encodeURIComponent(fullName);
      return {
        defaultBranch: async () => (await getJson<{ default_branch?: string }>(`https://gitlab.com/api/v4/projects/${id}`))?.default_branch ?? null,
        list: async (ref, dir) =>
          (await getJson<Array<{ name: string }>>(
            `https://gitlab.com/api/v4/projects/${id}/repository/tree?per_page=100&ref=${encodeURIComponent(ref)}${dir ? `&path=${encodeURIComponent(dir)}` : ""}`
          ))?.map?.((e) => e.name) ?? null,
        file: (ref, path) => getText(`https://gitlab.com/api/v4/projects/${id}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(ref)}`)
      };
    }
    case "bitbucket.org":
      return {
        defaultBranch: async () => (await getJson<{ mainbranch?: { name?: string } }>(`https://api.bitbucket.org/2.0/repositories/${repo}`))?.mainbranch?.name ?? null,
        list: async (ref, dir) =>
          (await getJson<{ values?: Array<{ path: string }> }>(`https://api.bitbucket.org/2.0/repositories/${repo}/src/${encodeURIComponent(ref)}/${enc(dir)}${dir ? "/" : ""}?pagelen=100`))
            ?.values?.map((e) => e.path.split("/").pop() ?? "") ?? null,
        file: (ref, path) => getText(`https://api.bitbucket.org/2.0/repositories/${repo}/src/${encodeURIComponent(ref)}/${enc(path)}`)
      };
    case "codeberg.org":
      return {
        defaultBranch: async () => (await getJson<{ default_branch?: string }>(`https://codeberg.org/api/v1/repos/${repo}`))?.default_branch ?? null,
        list: async (ref, dir) =>
          (await getJson<Array<{ name: string }>>(`https://codeberg.org/api/v1/repos/${repo}/contents/${enc(dir)}?ref=${encodeURIComponent(ref)}`))?.map?.((e) => e.name) ?? null,
        file: (ref, path) => getText(`https://codeberg.org/api/v1/repos/${repo}/raw/${enc(path)}?ref=${encodeURIComponent(ref)}`)
      };
    default:
      return null;
  }
}

function toSnapshot(files: string[], packageJsonText: string | null, dockerfile: string | null): RepoSnapshot {
  let packageJson: RepoSnapshot["packageJson"] = null;
  if (packageJsonText) {
    try {
      packageJson = JSON.parse(packageJsonText);
    } catch {
      packageJson = null;
    }
  }
  return { files, packageJson, dockerfile };
}

function cleanInputs(branch: string | null | undefined, baseDirectory: string | null | undefined) {
  const dir = normalizeBaseDirectory(baseDirectory);
  if (dir === null) return { ok: false as const, message: "The root folder must be a folder inside the repo, like apps/web." };
  const ref = (branch ?? "").trim();
  if (ref && !BRANCH.test(ref)) return { ok: false as const, message: "That branch name isn't valid." };
  return { ok: true as const, dir: dir.replace(/^\//, ""), ref };
}

export async function inspectPublicRepo(input: { repoUrl: string; branch?: string | null; baseDirectory?: string | null }): Promise<Inspection> {
  const parsed = parsePublicRepoUrl(input.repoUrl);
  if (!parsed.ok) return { ok: false, message: parsed.message };
  const cleaned = cleanInputs(input.branch, input.baseDirectory);
  if (!cleaned.ok) return cleaned;
  const reader = readerFor(parsed.host, parsed.fullName);
  if (!reader) return { ok: false, message: "That host isn't supported." };

  const defaultBranch = await reader.defaultBranch();
  const ref = cleaned.ref || defaultBranch;
  if (!ref) return { ok: false, message: "Couldn't read that repository. Check it's public and the address is right." };
  const files = await reader.list(ref, cleaned.dir);
  if (!files) return { ok: false, message: "Couldn't read that branch or folder. Check they exist." };
  const at = (name: string) => [cleaned.dir, name].filter(Boolean).join("/");
  const packageJson = files.includes("package.json") ? await reader.file(ref, at("package.json")) : null;
  const dockerfile = files.includes("Dockerfile") ? await reader.file(ref, at("Dockerfile")) : null;
  return { ok: true, detection: detectFramework(toSnapshot(files, packageJson, dockerfile)), defaultBranch };
}

export async function inspectGithubRepo(input: {
  installationId: number;
  fullName: string;
  branch: string;
  baseDirectory?: string | null;
}): Promise<Inspection> {
  const cleaned = cleanInputs(input.branch, input.baseDirectory);
  if (!cleaned.ok) return cleaned;
  if (!cleaned.ref) return { ok: false, message: "Choose a branch." };
  try {
    const { readRepoFolder } = await import("@/lib/github-app");
    const folder = await readRepoFolder(input.installationId, input.fullName, cleaned.ref, cleaned.dir);
    return { ok: true, detection: detectFramework(toSnapshot(folder.files, folder.packageJson, folder.dockerfile)), defaultBranch: null };
  } catch {
    return { ok: false, message: "Couldn't read that branch or folder. Check they exist." };
  }
}
