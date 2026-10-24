import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ auth: vi.fn(), isSuperAdminUser: vi.fn(), sendBroadcastTest: vi.fn() }));
vi.mock("@/lib/auth.config", () => ({ auth: m.auth }));
vi.mock("@/lib/rbac", () => ({ isSuperAdminUser: m.isSuperAdminUser }));
vi.mock("@/lib/notifications", async () => {
  const actual = await vi.importActual<typeof import("@/lib/notifications")>("@/lib/notifications");
  return { ...actual, sendBroadcastTest: m.sendBroadcastTest };
});

import { POST } from "./route";

const request = (payload: unknown) => new Request("https://jongo.test/api/notifications/broadcast/test", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload)
});

beforeEach(() => {
  vi.resetAllMocks();
  m.auth.mockResolvedValue({ user: { id: "super-1", email: "devkev@manifestfts.com" } });
  m.isSuperAdminUser.mockResolvedValue(true);
  m.sendBroadcastTest.mockResolvedValue({ broadcastId: "broadcast-1", emailSentCount: 1, emailFailedCount: 0 });
});

describe("POST /api/notifications/broadcast/test", () => {
  it("requires an authenticated super-admin", async () => {
    m.isSuperAdminUser.mockResolvedValue(false);
    const response = await POST(request({ subject: "Preview", message: "Hello" }));
    expect(response.status).toBe(403);
    expect(m.sendBroadcastTest).not.toHaveBeenCalled();
  });

  it("ignores any audience fields and targets the authenticated user only", async () => {
    const response = await POST(request({
      subject: " Preview ",
      message: "Hello {{recipient_name}}",
      scope: "all",
      userIds: ["client-user"],
      actionLinkLabel: "Read notice",
      actionLinkUrl: "https://example.com/security"
    }));
    expect(response.status).toBe(200);
    expect(m.sendBroadcastTest).toHaveBeenCalledWith({
      createdBy: "super-1",
      subject: "Preview",
      message: "Hello {{recipient_name}}",
      actionLinkLabel: "Read notice",
      actionLinkUrl: "https://example.com/security"
    });
  });

  it("rejects partial or unsafe action buttons before sending", async () => {
    const response = await POST(request({
      subject: "Preview",
      message: "Hello",
      actionLinkLabel: "Open",
      actionLinkUrl: "javascript:alert(1)"
    }));
    expect(response.status).toBe(400);
    expect(m.sendBroadcastTest).not.toHaveBeenCalled();
  });
});