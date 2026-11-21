/** Tenant membership only. Never add global super_admin here. */
export type Role = "admin" | "collaborator" | "viewer";

const STALE_ROLE_MAP: Record<string, Role> = {
  owner: "admin",
  operator: "collaborator",
  member: "collaborator"
};

export function normalizeRole(value: unknown, fallback: Role = "collaborator"): Role {
  if (typeof value !== "string") {
    return fallback;
  }

  const candidate = value.trim().toLowerCase();
  // Even an admin fallback must not turn an injected global role into membership admin.
  if (candidate === "super_admin") return "collaborator";
  // viewer: can see everything they're given, change nothing (lib/read-only-guard.ts).
  if (candidate === "admin" || candidate === "collaborator" || candidate === "viewer") {
    return candidate;
  }

  return Object.prototype.hasOwnProperty.call(STALE_ROLE_MAP, candidate) ? STALE_ROLE_MAP[candidate] : fallback;
}

export function isAdminRole(value: unknown): boolean {
  return normalizeRole(value) === "admin";
}
export function isViewerRole(value: unknown): boolean {
  return normalizeRole(value) === "viewer";
}
