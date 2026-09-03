/**
 * The two things that make a one-per-ten-seconds upstream survivable on a
 * public homepage.
 *
 * ## The problem
 *
 * Porkbun's `domain/checkDomain` allows ONE call every ten seconds, and the
 * limit is per API key — which means per Jongo, not per visitor. A domain
 * search box wired straight to it works perfectly for the developer testing it
 * and collapses the moment two people use the site at once: the second visitor
 * gets RATE_LIMIT_EXCEEDED. Ten simultaneous visitors would need a hundred
 * seconds to serve.
 *
 * Nothing can raise that ceiling. What these two pieces do is stop us wasting
 * any of it:
 *
 * - `SingleFlightCache` — two visitors searching "northfield.com" at the same
 *   moment make ONE upstream call and both get the answer; a third asking a
 *   minute later gets the cached one and makes none. On a domain search the
 *   duplicate rate is high (everyone checks the obvious name), so this is
 *   where most of the saving comes from.
 * - `MinIntervalGate` — serialises whatever is left so we approach the limit
 *   rather than trip it, and REFUSES rather than queues once the wait would be
 *   longer than a person will sit and watch.
 *
 * Both are deliberately in-memory and per-process. That is honest about what
 * this is: a way to be a good citizen of someone else's limit and to keep a
 * burst from turning into a wall of errors. It is not a distributed limiter —
 * two app instances have two gates and can together exceed the upstream limit,
 * at which point the upstream's own 429 is the backstop and is reported as
 * such. A shared limiter would need Redis and is worth doing if this ever runs
 * multi-instance; the type returned here already distinguishes "we declined"
 * from "they declined" so that change would not alter any caller.
 */

/** Injectable so tests do not sleep. */
export type Clock = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
};

/**
 * Coalesces concurrent requests for the same key and caches the result.
 *
 * A failure is NOT cached: an upstream blip should not be remembered as an
 * answer for the next five minutes. It is, however, still single-flighted, so
 * a hundred concurrent requests during an outage make one call, not a hundred.
 */
export class SingleFlightCache<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>();
  private readonly inFlight = new Map<string, Promise<T>>();

  constructor(
    private readonly ttlMs: number,
    private readonly clock: Clock = systemClock,
    /** Bounds memory on a public endpoint where the key space is user-supplied. */
    private readonly maxEntries = 5000
  ) {}

  /** A cached value, or undefined. Does not consider in-flight work. */
  peek(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.clock.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  async get(key: string, load: () => Promise<T>): Promise<{ value: T; cached: boolean }> {
    const cached = this.peek(key);
    if (cached !== undefined) return { value: cached, cached: true };

    const existing = this.inFlight.get(key);
    if (existing) return { value: await existing, cached: true };

    const promise = (async () => load())();
    this.inFlight.set(key, promise);
    try {
      const value = await promise;
      this.store(key, value);
      return { value, cached: false };
    } finally {
      this.inFlight.delete(key);
    }
  }

  /** Records a value without going through `load` — used to cache a fresh result. */
  store(key: string, value: T): void {
    if (this.entries.size >= this.maxEntries) {
      // Oldest-inserted first. Map preserves insertion order, and an
      // approximate eviction is fine for a cache whose only job is to spare a
      // rate limit.
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, { value, expiresAt: this.clock.now() + this.ttlMs });
  }

  invalidate(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
    this.inFlight.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

export type GateAdmission =
  | { admitted: true }
  /** We declined locally. Distinct from an upstream 429, which the caller reports differently. */
  | { admitted: false; retryAfterMs: number };

/**
 * Serialises calls so they are at least `intervalMs` apart, refusing rather
 * than queueing when the wait would exceed `maxWaitMs`.
 *
 * Refusing is the important half. A queue with no bound turns a traffic spike
 * into a set of requests that all eventually time out, having held a server
 * thread each — and answers a visitor who left ninety seconds ago. Telling the
 * fourth person in line "try again in a moment" is both cheaper and truer.
 */
export class MinIntervalGate {
  /** When the next call may go out. */
  private nextAvailableAt = 0;

  constructor(
    private readonly intervalMs: number,
    private readonly maxWaitMs: number,
    private readonly clock: Clock = systemClock
  ) {}

  /**
   * Reserve the next slot, waiting for it if that wait is short enough.
   *
   * The slot is claimed SYNCHRONOUSLY, before any awaiting, so two concurrent
   * callers cannot both decide the gate is free — the second sees the first's
   * reservation and waits for a slot after it.
   */
  async acquire(): Promise<GateAdmission> {
    const now = this.clock.now();
    const readyAt = Math.max(now, this.nextAvailableAt);
    const wait = readyAt - now;

    if (wait > this.maxWaitMs) {
      return { admitted: false, retryAfterMs: wait };
    }

    this.nextAvailableAt = readyAt + this.intervalMs;
    if (wait > 0) await this.clock.sleep(wait);
    return { admitted: true };
  }

  /**
   * Push the next slot out, after the upstream told us we were too early.
   *
   * Our interval is what we BELIEVE the limit to be; the upstream's
   * `ttlRemaining` is what it actually is. Trusting the server over our own
   * arithmetic is what stops a clock difference turning into a permanent
   * stream of 429s.
   */
  penalize(retryAfterMs: number): void {
    this.nextAvailableAt = Math.max(this.nextAvailableAt, this.clock.now() + retryAfterMs);
  }

  /** How long until a slot is free. 0 when one is available now. */
  waitMs(): number {
    return Math.max(0, this.nextAvailableAt - this.clock.now());
  }
}
