import { describe, expect, it } from "vitest";
import { deployRequestPlan, deployRetryDelaySeconds, isRetryableDeployStatus } from "./coolify-deploy-plan";

describe("deployRequestPlan", () => {
  it("tries POST before any GET, because Coolify 4.3 answers GET with 405", () => {
    const plan = deployRequestPlan("abc");
    const firstGet = plan.findIndex((r) => r.method === "GET");
    expect(plan.slice(0, firstGet).every((r) => r.method === "POST")).toBe(true);
    expect(firstGet).toBeGreaterThan(0);
  });

  it("restarts a service rather than 'start', which refuses a running service", () => {
    const plan = deployRequestPlan("abc");
    expect(plan[0]).toEqual({ method: "POST", path: "/api/v1/services/abc/restart" });
    expect(plan.some((r) => r.method === "POST" && r.path.endsWith("/start"))).toBe(false);
  });

  it("falls through to deploy for an application uuid", () => {
    expect(deployRequestPlan("abc")[1]).toEqual({ method: "POST", path: "/api/v1/deploy?uuid=abc" });
  });

  it("encodes the uuid", () => {
    expect(deployRequestPlan("a/b")[0].path).toBe("/api/v1/services/a%2Fb/restart");
  });
});

describe("rate-limit retry", () => {
  it("retries only on 429", () => {
    expect(isRetryableDeployStatus(429)).toBe(true);
    expect(isRetryableDeployStatus(405)).toBe(false);
    expect(isRetryableDeployStatus(500)).toBe(false);
  });

  it("waits Retry-After seconds, capped, with a default", () => {
    expect(deployRetryDelaySeconds("7")).toBe(7);
    expect(deployRetryDelaySeconds("600")).toBe(30);
    expect(deployRetryDelaySeconds(null)).toBe(15);
    expect(deployRetryDelaySeconds("soon")).toBe(15);
  });
});
