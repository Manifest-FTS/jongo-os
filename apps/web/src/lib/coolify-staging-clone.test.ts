import { describe, expect, it } from "vitest";
import {
  STAGING_CLONE_ALLOWLISTS,
  bodyViolatesAllowlist,
  buildStagingClonePlan,
  stagingCloneName
} from "./coolify-staging-clone";

/** The real values observed on the platform, so the shapes are not invented. */
const REAL = {
  sourceUuid: "c2mqv1xjksrkg2wn6eglw3u6", // Millenion Fitness (production)
  destinationUuid: "s602wydpds3q2ookbppzp6q9", // the Docker destination
  stagingEnvironmentUuid: "x12djrg1u0rh1wy2h3xwfwl8" // that project's staging env
};

function plan(overrides: Partial<Parameters<typeof buildStagingClonePlan>[0]> = {}) {
  return buildStagingClonePlan({ kind: "application", ...REAL, ...overrides });
}

describe("buildStagingClonePlan — the clone request", () => {
  it("sends the field Coolify REQUIRES", () => {
    const p = plan();
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.clone.body.destination_uuid).toBe(REAL.destinationUuid);
  });

  it("sends NOTHING outside Coolify's allowlist", () => {
    // This is the bug in one assertion. The old code sent
    // { environment, fqdn, domain } — all three rejected — and omitted
    // destination_uuid, so every call was a guaranteed 422.
    const p = plan({ productionName: "Millenion Fitness" });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(bodyViolatesAllowlist(p.clone.body, STAGING_CLONE_ALLOWLISTS.clone)).toEqual([]);
  });

  it("never sends the fields that used to break it", () => {
    const p = plan({ productionName: "Millenion Fitness" });
    if (!p.ok) return;
    for (const forbidden of ["environment", "fqdn", "domain"]) {
      expect(p.clone.body).not.toHaveProperty(forbidden);
    }
  });

  it("clones volume data by default, so staging is a real copy", () => {
    const p = plan();
    if (!p.ok) return;
    expect(p.clone.body.clone_volumes).toBe(true);
  });

  it("allows opting out of volume data", () => {
    const p = plan({ cloneVolumes: false });
    if (!p.ok) return;
    expect(p.clone.body.clone_volumes).toBe(false);
  });

  it("omits name entirely when there is none, rather than sending undefined", () => {
    const p = plan();
    if (!p.ok) return;
    expect(Object.keys(p.clone.body).sort()).toEqual(["clone_volumes", "destination_uuid"]);
  });

  it("targets the right endpoint per resource kind", () => {
    expect((plan({ kind: "application" }) as any).clone.path).toBe(
      `/api/v1/applications/${REAL.sourceUuid}/clone`
    );
    expect((plan({ kind: "service" }) as any).clone.path).toBe(
      `/api/v1/services/${REAL.sourceUuid}/clone`
    );
    expect((plan({ kind: "database" }) as any).clone.path).toBe(
      `/api/v1/databases/${REAL.sourceUuid}/clone`
    );
  });
});

describe("buildStagingClonePlan — the move request", () => {
  it("carries exactly one field, because Coolify allows exactly one", () => {
    const p = plan();
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    const move = p.move("newlyClonedUuid1234");
    expect(Object.keys(move.body)).toEqual(["environment_uuid"]);
    expect(move.body.environment_uuid).toBe(REAL.stagingEnvironmentUuid);
    expect(bodyViolatesAllowlist(move.body, STAGING_CLONE_ALLOWLISTS.move)).toEqual([]);
  });

  it("moves the CLONE, not the production resource", () => {
    // Moving the source would take production itself out of the production
    // environment — the worst possible way to get this wrong.
    const p = plan();
    if (!p.ok) return;
    const move = p.move("clone-uuid-9999");
    expect(move.path).toContain("clone-uuid-9999");
    expect(move.path).not.toContain(REAL.sourceUuid);
  });

  it("uses the matching endpoint family for services", () => {
    const p = plan({ kind: "service" });
    if (!p.ok) return;
    expect(p.move("abc").path).toBe("/api/v1/services/abc/move");
  });
});

describe("buildStagingClonePlan — refusals", () => {
  it("refuses without a destination instead of sending a doomed request", () => {
    const p = plan({ destinationUuid: "" });
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.reason).toBe("missing_destination");
    expect(p.message).toMatch(/destination/i);
  });

  it("refuses without a staging environment", () => {
    const p = plan({ stagingEnvironmentUuid: "   " });
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.reason).toBe("missing_staging_environment");
  });

  it("refuses without a source", () => {
    const p = plan({ sourceUuid: "" });
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.reason).toBe("missing_source");
  });
});

describe("stagingCloneName", () => {
  it("is recognisable and stable, not Coolify's random clone-of-xxx", () => {
    expect(stagingCloneName("Millenion Fitness")).toBe("Millenion Fitness staging");
  });

  it("does not double the suffix", () => {
    expect(stagingCloneName("joyfeed.app staging")).toBe("joyfeed.app staging");
  });

  it("survives empty and messy input", () => {
    expect(stagingCloneName("")).toBe("app staging");
    expect(stagingCloneName("  spaced   out  ")).toBe("spaced out staging");
  });

  it("stays within a sane length", () => {
    expect(stagingCloneName("x".repeat(200)).length).toBeLessThanOrEqual(48);
  });
});
