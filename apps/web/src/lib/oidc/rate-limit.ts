import { RateLimiter } from "@/lib/contact-request";

/**
 * Token-endpoint limits. Process-local like the contact-form limiter they reuse (resets on
 * deploy, not shared across instances); 256-bit secrets and codes make guessing infeasible
 * regardless, so this only blunts probing.
 */
const perClientAndIp = new RateLimiter(10, 60_000);
const perIp = new RateLimiter(60, 60_000);
const authorizePerUser = new RateLimiter(30, 60_000);

export type LimitDecision = { allowed: boolean; retryAfterSeconds: number };

function clip(value: string): string {
  return value.slice(0, 128);
}

export function checkTokenRate(clientKey: string, ip: string, now = Date.now()): LimitDecision {
  const ipDecision = perIp.check(`ip:${clip(ip)}`, now);
  if (!ipDecision.allowed) return ipDecision;
  return perClientAndIp.check(`${clip(clientKey)}|${clip(ip)}`, now);
}

export function checkAuthorizeRate(userId: string, now = Date.now()): LimitDecision {
  return authorizePerUser.check(`user:${clip(userId)}`, now);
}

/** Temporary lock after repeated failed client authentication. Never disables the client. */
export class FailureLock {
  private failures = new Map<string, number[]>();

  constructor(
    private readonly maxFailures: number,
    private readonly windowMs: number
  ) {}

  private recent(key: string, now: number): number[] {
    const list = (this.failures.get(key) ?? []).filter((at) => now - at < this.windowMs);
    if (list.length > 0) this.failures.set(key, list);
    else this.failures.delete(key);
    return list;
  }

  isLocked(key: string, now = Date.now()): boolean {
    return this.recent(key, now).length >= this.maxFailures;
  }

  recordFailure(key: string, now = Date.now()): void {
    const list = this.recent(key, now);
    list.push(now);
    this.failures.set(key, list);
    if (this.failures.size > 5000) {
      for (const k of this.failures.keys()) this.recent(k, now);
    }
  }

  reset(key: string): void {
    this.failures.delete(key);
  }
}

export const clientAuthFailures = new FailureLock(5, 15 * 60_000);
