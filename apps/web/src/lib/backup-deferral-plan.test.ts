import { describe, expect, it } from "vitest";
import { classifyDeferral, planDeferral } from "./backup-deferral";

const now = new Date("2026-11-19T12:00:00Z");
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);

describe("what a deferred backup means", () => {
  it("classifies the script's tokens", () => {
    expect(classifyDeferral("deferred_no_containers")).toBe("app_stopped");
    expect(classifyDeferral("deferred_backup_in_progress")).toBe("server_busy");
    expect(classifyDeferral("deferred_repo_locked")).toBe("server_busy");
    expect(classifyDeferral("deferred_deploy_in_progress")).toBe("server_busy");
    expect(classifyDeferral("deferred_something_new")).toBe("other");
  });

  it("pauses a stopped app quietly, however long it has been", () => {
    expect(planDeferral({ token: "deferred_no_containers", trigger: "scheduled", lastSuccessAt: hoursAgo(500), now })).toEqual({ action: "pause", kind: "app_stopped" });
    expect(planDeferral({ token: "deferred_no_containers", trigger: "scheduled", lastSuccessAt: null, now }).action).toBe("pause");
  });

  it("retries a busy server, then alerts admins (never the owner) past the limit", () => {
    expect(planDeferral({ token: "deferred_backup_in_progress", trigger: "scheduled", lastSuccessAt: hoursAgo(3), now }).action).toBe("retry");
    const late = planDeferral({ token: "deferred_backup_in_progress", trigger: "scheduled", lastSuccessAt: hoursAgo(268), now });
    expect(late).toMatchObject({ action: "retry_and_alert_admins", kind: "server_busy" });
  });

  it("tells the person who clicked Back up now why it didn't run", () => {
    expect(planDeferral({ token: "deferred_backup_in_progress", trigger: "manual", lastSuccessAt: hoursAgo(1), now })).toMatchObject({
      action: "report_to_requester",
      message: expect.stringMatching(/Another backup/)
    });
    expect(planDeferral({ token: "deferred_no_containers", trigger: "promote", lastSuccessAt: null, now })).toMatchObject({
      action: "report_to_requester",
      message: expect.stringMatching(/isn't running/)
    });
  });

  it("still escalates an unknown reason that persists", () => {
    expect(planDeferral({ token: "deferred_mystery", trigger: "scheduled", lastSuccessAt: hoursAgo(100), now }).action).toBe("escalate");
    expect(planDeferral({ token: "deferred_mystery", trigger: "scheduled", lastSuccessAt: hoursAgo(1), now }).action).toBe("retry");
  });
});
