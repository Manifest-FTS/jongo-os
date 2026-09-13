/**
 * Plan limits for the usage meters.
 *
 * Returns null today: organisations are not assigned a plan yet, and a meter
 * against an invented limit would tell a client they are near a cap that does
 * not exist. The meters already render limits (see UsageMeter) — when plans are
 * stored per organisation, resolve them here and every usage page picks them up.
 * The placeholder tiers live in lib/public-plans.ts.
 */

export type UsageLimits = {
  memoryBytes: number | null;
  vcpuHours: number | null;
  egressBytes: number | null;
  storageBytes: number | null;
};

export async function getUsageLimits(_scope: { siteId: string }): Promise<UsageLimits | null> {
  return null;
}
