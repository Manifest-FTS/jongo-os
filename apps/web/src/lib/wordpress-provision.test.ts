import { describe, expect, it } from "vitest";
import {
  buildWordPressServiceRequest,
  normalizeServiceName,
  WORDPRESS_SERVICE_TYPE
} from "./wordpress-provision";

const valid = {
  name: "Acme Dental",
  projectUuid: "proj-123",
  serverUuid: "srv-456"
};

describe("buildWordPressServiceRequest", () => {
  it("builds a one-click WordPress service request", () => {
    const r = buildWordPressServiceRequest(valid);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body).toMatchObject({
      type: WORDPRESS_SERVICE_TYPE,
      name: "acme-dental",
      project_uuid: "proj-123",
      server_uuid: "srv-456",
      environment_name: "production",
      instant_deploy: true
    });
  });

  it("uses the type the rest of the codebase recognises", () => {
    // lib/coolify.ts keys capability detection off this exact string, so a
    // different template would be classified differently by backups and staging.
    expect(WORDPRESS_SERVICE_TYPE).toBe("wordpress-with-mariadb");
  });

  it("refuses without a project rather than letting Coolify choose", () => {
    const r = buildWordPressServiceRequest({ ...valid, projectUuid: null });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("project_required");
  });

  it("refuses without a server", () => {
    const r = buildWordPressServiceRequest({ ...valid, serverUuid: "   " });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("server_required");
  });

  it("refuses a name that normalises to nothing", () => {
    const r = buildWordPressServiceRequest({ ...valid, name: "!!!" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("name_required");
  });

  it("honours an explicit environment", () => {
    const r = buildWordPressServiceRequest({ ...valid, environmentName: "staging", environmentUuid: "env-9" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body.environment_name).toBe("staging");
    expect(r.body.environment_uuid).toBe("env-9");
  });

  it("omits optional ids rather than sending empty strings", () => {
    const r = buildWordPressServiceRequest(valid);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect("environment_uuid" in r.body).toBe(false);
    expect("destination_uuid" in r.body).toBe(false);
  });

  it("allows instant deploy to be turned off", () => {
    const r = buildWordPressServiceRequest({ ...valid, instantDeploy: false });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body.instant_deploy).toBe(false);
  });
});

describe("normalizeServiceName", () => {
  it("makes names safe for container names and domains", () => {
    expect(normalizeServiceName("Acme Dental Ltd.")).toBe("acme-dental-ltd");
    expect(normalizeServiceName("  Fucarino.com  ")).toBe("fucarino-com");
    expect(normalizeServiceName("A_B/C")).toBe("a-b-c");
  });

  it("never leaves a leading or trailing dash", () => {
    expect(normalizeServiceName("-hello-")).toBe("hello");
    expect(normalizeServiceName("...trailing...")).toBe("trailing");
  });

  it("truncates without leaving a dangling dash", () => {
    // Truncation landing on a separator would produce name- as a hostname label.
    const name = normalizeServiceName(`${"a".repeat(59)} bcd`);
    expect(name.length).toBeLessThanOrEqual(60);
    expect(name.endsWith("-")).toBe(false);
  });

  it("returns empty for input with nothing usable", () => {
    expect(normalizeServiceName("!!!")).toBe("");
    expect(normalizeServiceName(null)).toBe("");
  });
});
