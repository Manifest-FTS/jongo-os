import { describe, expect, it } from "vitest";
import { cleanCommand, detectFramework, dockerfileExposedPort } from "./frameworks";

const pkg = (deps: Record<string, string>, scripts: Record<string, string> = {}) => ({ dependencies: deps, scripts });

describe("detectFramework", () => {
  it.each([
    [{ next: "15" }, {}, "nextjs", "nixpacks", 3000],
    [{ nuxt: "3" }, {}, "nuxt", "nixpacks", 3000],
    [{ "@remix-run/node": "2" }, {}, "remix", "nixpacks", 3000],
    [{ "@sveltejs/kit": "2" }, {}, "sveltekit", "nixpacks", 3000],
    [{ astro: "4" }, {}, "astro-static", "nixpacks", 80],
    [{ astro: "4", "@astrojs/node": "8" }, {}, "astro", "nixpacks", 4321],
    [{ "@angular/core": "17" }, {}, "angular", "nixpacks", 80],
    [{ "react-scripts": "5" }, {}, "create-react-app", "nixpacks", 80],
    [{ vite: "5", react: "18" }, { build: "vite build" }, "vite", "nixpacks", 80],
    [{ express: "4" }, {}, "node", "nixpacks", 3000],
    [{ lodash: "4" }, { start: "node server.js" }, "node", "nixpacks", 3000]
  ])("%j → %s", (deps, scripts, id, buildPack, port) => {
    const { preset } = detectFramework({ packageJson: pkg(deps, scripts), files: ["package.json"] });
    expect(preset).toMatchObject({ id, buildPack, port });
  });

  it("prefers a framework over a Dockerfile, and a Dockerfile over a bare start script", () => {
    expect(detectFramework({ packageJson: pkg({ next: "15" }), files: ["Dockerfile"] }).preset.id).toBe("nextjs");
    const docker = detectFramework({ packageJson: pkg({}, { start: "x" }), files: ["Dockerfile"], dockerfile: "FROM node\nEXPOSE 8080\n" });
    expect(docker.preset).toMatchObject({ id: "dockerfile", port: 8080 });
  });

  it("builds front-end apps, then serves the output folder", () => {
    expect(detectFramework({ packageJson: pkg({ vite: "5" }), files: [] }).preset).toMatchObject({ isStatic: true, publishDirectory: "/dist", isSpa: true });
    expect(detectFramework({ packageJson: pkg({ next: "15" }), files: [] }).preset.isStatic).toBeUndefined();
  });

  it("serves plain HTML as it is and falls back to auto-detect", () => {
    expect(detectFramework({ files: ["index.html", "style.css"] }).preset).toMatchObject({ id: "static-html", buildPack: "static" });
    expect(detectFramework({ files: ["main.py", "requirements.txt"] }).preset.id).toBe("other");
  });

  it("says why it chose", () => {
    expect(detectFramework({ packageJson: pkg({ next: "15" }), files: [] }).reason).toContain("next");
  });
});

describe("helpers", () => {
  it("reads the Dockerfile's port", () => {
    expect(dockerfileExposedPort("FROM x\n  expose 4000/tcp")).toBe(4000);
    expect(dockerfileExposedPort("FROM x")).toBeNull();
    expect(dockerfileExposedPort("EXPOSE 99999")).toBeNull();
  });

  it("accepts one-line commands only", () => {
    expect(cleanCommand("  npm run build  ")).toBe("npm run build");
    expect(cleanCommand("")).toBe("");
    expect(cleanCommand(undefined)).toBeUndefined();
    expect(cleanCommand("a\nrm -rf /")).toBeNull();
    expect(cleanCommand("x".repeat(501))).toBeNull();
  });
});
