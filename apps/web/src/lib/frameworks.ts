/**
 * Framework presets and detection, like Vercel's "Framework Preset".
 *
 * Detection reads only what a repo already declares (package.json
 * dependencies and scripts, a few well-known files) and picks how hosting
 * should build and run it. Every value is a starting point the person can
 * change before deploying.
 *
 * Build packs are Coolify's: "nixpacks" builds and runs a server (or, with
 * isStatic, builds and then serves the output folder), "static" serves the
 * repo's files as they are with no build, "dockerfile" uses the repo's own
 * Dockerfile.
 */

export type BuildPack = "nixpacks" | "static" | "dockerfile";

export type FrameworkId =
  | "nextjs"
  | "nuxt"
  | "remix"
  | "sveltekit"
  | "astro"
  | "astro-static"
  | "vite"
  | "create-react-app"
  | "angular"
  | "node"
  | "dockerfile"
  | "static-html"
  | "other";

export type FrameworkPreset = {
  id: FrameworkId;
  label: string;
  buildPack: BuildPack;
  port: number;
  installCommand?: string;
  buildCommand?: string;
  startCommand?: string;
  /** Build with nixpacks, then serve `publishDirectory` (Coolify's is_static). */
  isStatic?: boolean;
  /** Static sites: the folder that holds the built site. */
  publishDirectory?: string;
  /** Static builds: send unknown paths to index.html (client-side routing). */
  isSpa?: boolean;
};

export const FRAMEWORK_PRESETS: Record<FrameworkId, FrameworkPreset> = {
  nextjs: { id: "nextjs", label: "Next.js", buildPack: "nixpacks", port: 3000 },
  nuxt: { id: "nuxt", label: "Nuxt", buildPack: "nixpacks", port: 3000, startCommand: "node .output/server/index.mjs" },
  remix: { id: "remix", label: "Remix / React Router", buildPack: "nixpacks", port: 3000 },
  sveltekit: { id: "sveltekit", label: "SvelteKit", buildPack: "nixpacks", port: 3000, startCommand: "node build" },
  astro: { id: "astro", label: "Astro (server)", buildPack: "nixpacks", port: 4321, startCommand: "node ./dist/server/entry.mjs" },
  "astro-static": { id: "astro-static", label: "Astro", buildPack: "nixpacks", isStatic: true, port: 80, buildCommand: "npm run build", publishDirectory: "/dist" },
  vite: { id: "vite", label: "Vite (React, Vue, Svelte)", buildPack: "nixpacks", isStatic: true, port: 80, buildCommand: "npm run build", publishDirectory: "/dist", isSpa: true },
  "create-react-app": { id: "create-react-app", label: "Create React App", buildPack: "nixpacks", isStatic: true, port: 80, buildCommand: "npm run build", publishDirectory: "/build", isSpa: true },
  angular: { id: "angular", label: "Angular", buildPack: "nixpacks", isStatic: true, port: 80, buildCommand: "npm run build", publishDirectory: "/dist", isSpa: true },
  node: { id: "node", label: "Node.js server", buildPack: "nixpacks", port: 3000 },
  dockerfile: { id: "dockerfile", label: "Dockerfile", buildPack: "dockerfile", port: 3000 },
  "static-html": { id: "static-html", label: "Static HTML", buildPack: "static", port: 80, publishDirectory: "/" },
  other: { id: "other", label: "Other (auto-detect)", buildPack: "nixpacks", port: 3000 }
};

export type RepoSnapshot = {
  /** Parsed package.json at the app's root folder, if there is one. */
  packageJson?: { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string> } | null;
  /** File and folder names at the app's root folder. */
  files: string[];
  /** Contents of the Dockerfile, if there is one (for its EXPOSE port). */
  dockerfile?: string | null;
};

export type Detection = { preset: FrameworkPreset; reason: string };

function has(deps: Record<string, string>, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(deps, name);
}

/** The port a Dockerfile EXPOSEs, if it says. */
export function dockerfileExposedPort(dockerfile: string | null | undefined): number | null {
  const match = /^\s*EXPOSE\s+(\d{2,5})/im.exec(dockerfile ?? "");
  const port = match ? Number(match[1]) : NaN;
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

export function detectFramework(snapshot: RepoSnapshot): Detection {
  const files = new Set(snapshot.files.map((name) => name.toLowerCase()));
  const pkg = snapshot.packageJson ?? null;
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const scripts = pkg?.scripts ?? {};
  const preset = (id: FrameworkId, reason: string): Detection => ({ preset: FRAMEWORK_PRESETS[id], reason });

  if (pkg) {
    if (has(deps, "next")) return preset("nextjs", "next in package.json");
    if (has(deps, "nuxt") || has(deps, "nuxt3")) return preset("nuxt", "nuxt in package.json");
    if (has(deps, "@remix-run/node") || has(deps, "@remix-run/serve") || has(deps, "@react-router/serve")) {
      return preset("remix", "Remix / React Router server in package.json");
    }
    if (has(deps, "@sveltejs/kit")) return preset("sveltekit", "@sveltejs/kit in package.json");
    if (has(deps, "astro")) {
      return has(deps, "@astrojs/node")
        ? preset("astro", "astro with @astrojs/node in package.json")
        : preset("astro-static", "astro in package.json");
    }
    if (has(deps, "@angular/core")) return preset("angular", "@angular/core in package.json");
    if (has(deps, "react-scripts")) return preset("create-react-app", "react-scripts in package.json");
    if (has(deps, "vite") && !scripts.start) return preset("vite", "vite in package.json");
  }

  if (files.has("dockerfile")) {
    const detected = preset("dockerfile", "a Dockerfile in the repository");
    const port = dockerfileExposedPort(snapshot.dockerfile);
    return port ? { ...detected, preset: { ...detected.preset, port } } : detected;
  }

  if (pkg && (scripts.start || has(deps, "express") || has(deps, "fastify") || has(deps, "@nestjs/core") || has(deps, "koa") || has(deps, "hono"))) {
    return preset("node", scripts.start ? "a start script in package.json" : "a Node.js server framework in package.json");
  }
  if (pkg && has(deps, "vite")) return preset("vite", "vite in package.json");
  if (!pkg && files.has("index.html")) return preset("static-html", "index.html with no package.json");
  return preset("other", pkg ? "package.json without a known framework" : "no package.json");
}

/** Values a person may type into build settings: one line, bounded. */
export function cleanCommand(value: string | null | undefined): string | null | undefined {
  if (value === undefined || value === null) return value;
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.length > 500 || /[\r\n\0]/.test(trimmed)) return null;
  return trimmed;
}
