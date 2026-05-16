export type Role = "admin" | "collaborator";

const STALE_ROLE_MAP: Record<string, Role> = {
  owner: "admin",
  operator: "collaborator",
  member: "collaborator",
  viewer: "collaborator"
};

export function normalizeRole(value: unknown, fallback: Role = "collaborator"): Role {
  if (typeof value !== "string") {
    return fallback;
  }

  const candidate = value.trim().toLowerCase();
  if (candidate === "admin" || candidate === "collaborator") {
    return candidate;
  }

  return STALE_ROLE_MAP[candidate] ?? fallback;
}

export function isAdminRole(value: unknown): boolean {
  return normalizeRole(value) === "admin";
}