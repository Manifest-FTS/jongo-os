import { describe, expect, it } from "vitest";
import { resolveStagingServerUuid } from "./coolify-server-resolve";

// Captured verbatim from the live instance: this exact shape is what silently
// killed staging provisioning.
const LIVE_SERVICE = {
  service_type: "wordpress-with-mariadb",
  docker_compose_raw: "services:\n  wordpress:\n    image: 'wordpress:latest'",
  server_id: 0,
  destination_id: 0,
  name: "teach.lgbt"
};
const LIVE_SERVERS = [{ id: null, uuid: "nqhwfyhq4urgaoakhjiyu31u", name: "localhost" }];

describe("resolveStagingServerUuid", () => {
  it("resolves the live case that used to fail silently", () => {
    const r = resolveStagingServerUuid({ service: LIVE_SERVICE, servers: LIVE_SERVERS });
    expect(r.uuid).toBe("nqhwfyhq4urgaoakhjiyu31u");
    expect(r.source).toBe("only_server");
  });

  it("prefers an explicit server_uuid when Coolify provides one", () => {
    const r = resolveStagingServerUuid({
      service: { ...LIVE_SERVICE, server_uuid: "explicit-uuid" },
      servers: [{ uuid: "a" }, { uuid: "b" }]
    });
    expect(r.uuid).toBe("explicit-uuid");
    expect(r.source).toBe("service_server_uuid");
  });

  it("reads a nested server object", () => {
    const r = resolveStagingServerUuid({
      service: { server: { uuid: "nested-uuid" } },
      servers: [{ uuid: "a" }, { uuid: "b" }]
    });
    expect(r.uuid).toBe("nested-uuid");
    expect(r.source).toBe("service_server_object");
  });

  it("matches by id only when both sides really have one", () => {
    const r = resolveStagingServerUuid({
      service: { server_id: 7 },
      servers: [{ id: 3, uuid: "wrong" }, { id: 7, uuid: "right" }]
    });
    expect(r.uuid).toBe("right");
    expect(r.source).toBe("matched_by_id");
  });

  it("never treats server_id 0 as matching a server with no id", () => {
    // The precise trap: "0" must not pair up with an absent id.
    const r = resolveStagingServerUuid({
      service: { server_id: 0 },
      servers: [{ id: null, uuid: "srv-a" }, { id: null, uuid: "srv-b" }]
    });
    expect(r.uuid).toBe("");
    expect(r.source).toBe("unresolved");
  });

  it("refuses to guess between several servers, and says why", () => {
    const r = resolveStagingServerUuid({
      service: LIVE_SERVICE,
      servers: [{ uuid: "srv-a" }, { uuid: "srv-b" }]
    });
    expect(r.uuid).toBe("");
    expect(r.source).toBe("unresolved");
    expect(r.reason).toMatch(/did not say which/i);
    // Must not fail mute: the caller has to be able to explain this.
    expect(r.reason && r.reason.length).toBeGreaterThan(20);
  });

  it("explains an empty server list rather than returning a bare failure", () => {
    const r = resolveStagingServerUuid({ service: LIVE_SERVICE, servers: [] });
    expect(r.uuid).toBe("");
    expect(r.reason).toMatch(/no servers/i);
  });

  it("ignores server entries with no uuid when counting", () => {
    const r = resolveStagingServerUuid({
      service: LIVE_SERVICE,
      servers: [{ uuid: "" }, { uuid: "the-only-real-one" }, {}]
    });
    expect(r.uuid).toBe("the-only-real-one");
    expect(r.source).toBe("only_server");
  });

  it("tolerates a missing service payload", () => {
    expect(resolveStagingServerUuid({ service: null, servers: LIVE_SERVERS }).uuid).toBe(
      "nqhwfyhq4urgaoakhjiyu31u"
    );
    expect(resolveStagingServerUuid({ service: undefined, servers: [] }).uuid).toBe("");
  });
});
