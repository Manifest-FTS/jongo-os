import { describe, expect, it } from "vitest";
import { inspectPublicRepo } from "./repo-inspect";

// Hits the real hosts; runs only when NETWORK_TESTS=1.
describe.skipIf(!process.env.NETWORK_TESTS)("inspectPublicRepo (network)", () => {
  it.each([
    ["https://github.com/vercel/next-learn", "dashboard/final-example", "nextjs"],
    ["https://github.com/nuxt/starter", "", null],
    ["https://gitlab.com/pages/plain-html", "", null],
    ["https://gitlab.com/pages/nextjs", "", null],
    ["https://codeberg.org/Codeberg/pages-server", "", null],
    ["https://bitbucket.org/tutorials/markdowndemo", "", null]
  ])("%s %s", async (repoUrl, baseDirectory, expected) => {
    const result = await inspectPublicRepo({ repoUrl, baseDirectory });
    console.log(repoUrl, baseDirectory, JSON.stringify(result.ok ? { id: result.detection.preset.id, reason: result.detection.reason, defaultBranch: result.defaultBranch } : result));
    if (expected) expect(result.ok && result.detection.preset.id).toBe(expected);
  }, 30_000);
});
