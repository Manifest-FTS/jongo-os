import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  getDb: vi.fn(),
  findUser: vi.fn(),
  findUsername: vi.fn(),
  createUser: vi.fn(),
  createOrganization: vi.fn(),
  transaction: vi.fn()
}));

vi.mock("@/lib/db", () => ({ getDb: m.getDb }));
vi.mock("bcryptjs", () => ({ hash: vi.fn(async () => "hashed-password") }));

import { POST } from "./route";

const body = {
  firstName: "  Ada ",
  lastName: " Lovelace  ",
  username: "  Ada.L  ",
  email: " ADA@example.test ",
  password: "a-secure-password"
};
const request = (payload: unknown) => new Request("https://jongo.test/api/auth/register", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload)
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("ENABLE_SELF_REGISTRATION", "true");
  m.getDb.mockResolvedValue({
    user: { findUnique: m.findUser },
    userProfileSettings: { findUnique: m.findUsername },
    $transaction: m.transaction
  });
  m.findUser.mockResolvedValue(null);
  m.findUsername.mockResolvedValue(null);
  m.createUser.mockResolvedValue({ id: "user-1", email: "ada@example.test", fullName: "Ada Lovelace" });
  m.createOrganization.mockResolvedValue({ id: "org-1" });
  m.transaction.mockImplementation((callback) => callback({
    user: { create: m.createUser },
    organization: { create: m.createOrganization }
  }));
});

describe("POST /api/auth/register", () => {
  it("requires first name, last name, username, email, and password", async () => {
    const response = await POST(request({ ...body, username: "" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("username") });
    expect(m.findUser).not.toHaveBeenCalled();
  });

  it("validates username shape before creating an account", async () => {
    const response = await POST(request({ ...body, username: "not valid" }));
    expect(response.status).toBe(400);
    expect(m.findUser).not.toHaveBeenCalled();
  });

  it("rejects an already claimed username", async () => {
    m.findUsername.mockResolvedValue({ id: "existing-profile" });
    const response = await POST(request(body));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("username") });
    expect(m.createUser).not.toHaveBeenCalled();
  });

  it("normalizes identity fields and creates the profile and owner workspace transactionally", async () => {
    const response = await POST(request(body));
    expect(response.status).toBe(201);
    expect(m.findUser).toHaveBeenCalledWith({ where: { email: "ada@example.test" } });
    expect(m.findUsername).toHaveBeenCalledWith({ where: { username: "ada.l" }, select: { id: true } });
    expect(m.createUser).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        email: "ada@example.test",
        fullName: "Ada Lovelace",
        profileSettings: { create: { username: "ada.l" } }
      })
    }));
    expect(m.createOrganization).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ name: "Ada Lovelace", ownerId: "user-1" })
    }));
  });
});
