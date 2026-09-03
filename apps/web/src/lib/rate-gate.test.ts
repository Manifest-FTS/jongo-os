import { describe, expect, it } from "vitest";
import { MinIntervalGate, SingleFlightCache, type Clock } from "./rate-gate";

/** A clock that only moves when a test moves it, so nothing actually sleeps. */
function fakeClock(): Clock & { advance: (ms: number) => void; sleeps: number[] } {
  let current = 1_000_000;
  const sleeps: number[] = [];
  return {
    now: () => current,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      current += ms;
    },
    advance: (ms: number) => {
      current += ms;
    },
    sleeps
  };
}

describe("SingleFlightCache", () => {
  it("calls the loader once for concurrent requests on the same key", async () => {
    const clock = fakeClock();
    const cache = new SingleFlightCache<string>(60_000, clock);
    let calls = 0;
    const load = async () => {
      calls += 1;
      return "answer";
    };

    const [a, b, c] = await Promise.all([
      cache.get("k", load),
      cache.get("k", load),
      cache.get("k", load)
    ]);

    expect(calls).toBe(1);
    expect([a.value, b.value, c.value]).toEqual(["answer", "answer", "answer"]);
  });

  it("serves a later request from cache without calling the loader", async () => {
    const clock = fakeClock();
    const cache = new SingleFlightCache<string>(60_000, clock);
    let calls = 0;
    const load = async () => {
      calls += 1;
      return "answer";
    };

    const first = await cache.get("k", load);
    const second = await cache.get("k", load);

    expect(calls).toBe(1);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
  });

  it("calls the loader again once the entry expires", async () => {
    const clock = fakeClock();
    const cache = new SingleFlightCache<string>(60_000, clock);
    let calls = 0;
    const load = async () => {
      calls += 1;
      return `answer-${calls}`;
    };

    await cache.get("k", load);
    clock.advance(60_001);
    const again = await cache.get("k", load);

    expect(calls).toBe(2);
    expect(again.value).toBe("answer-2");
  });

  it("keeps different keys separate", async () => {
    const cache = new SingleFlightCache<string>(60_000, fakeClock());
    const a = await cache.get("a", async () => "A");
    const b = await cache.get("b", async () => "B");
    expect([a.value, b.value]).toEqual(["A", "B"]);
  });

  it("does not cache a failure, but does still coalesce it", async () => {
    const cache = new SingleFlightCache<string>(60_000, fakeClock());
    let calls = 0;
    const failing = async () => {
      calls += 1;
      throw new Error("upstream down");
    };

    // Concurrent failures share one call...
    await expect(Promise.all([
      cache.get("k", failing).catch(() => "rejected"),
      cache.get("k", failing).catch(() => "rejected")
    ])).resolves.toEqual(["rejected", "rejected"]);
    expect(calls).toBe(1);

    // ...but the failure is not remembered as an answer.
    await cache.get("k", async () => "recovered");
    expect(cache.peek("k")).toBe("recovered");
  });

  it("evicts to stay within maxEntries, since the key space is user-supplied", async () => {
    const cache = new SingleFlightCache<string>(60_000, fakeClock(), 3);
    for (const key of ["a", "b", "c", "d"]) {
      await cache.get(key, async () => key);
    }
    expect(cache.size).toBeLessThanOrEqual(3);
    expect(cache.peek("d")).toBe("d");
  });

  it("peek reports nothing once an entry is stale", async () => {
    const clock = fakeClock();
    const cache = new SingleFlightCache<string>(1000, clock);
    await cache.get("k", async () => "v");
    expect(cache.peek("k")).toBe("v");
    clock.advance(1001);
    expect(cache.peek("k")).toBeUndefined();
  });
});

describe("MinIntervalGate", () => {
  it("admits the first call immediately", async () => {
    const gate = new MinIntervalGate(10_000, 3000, fakeClock());
    expect(await gate.acquire()).toEqual({ admitted: true });
  });

  it("makes a second caller wait for the interval when the wait is tolerable", async () => {
    const clock = fakeClock();
    const gate = new MinIntervalGate(2000, 5000, clock);

    await gate.acquire();
    const second = await gate.acquire();

    expect(second).toEqual({ admitted: true });
    expect(clock.sleeps).toEqual([2000]);
  });

  it("refuses rather than queueing once the wait exceeds the bound", async () => {
    const clock = fakeClock();
    const gate = new MinIntervalGate(10_000, 3000, clock);

    expect(await gate.acquire()).toEqual({ admitted: true });
    const refused = await gate.acquire();

    expect(refused.admitted).toBe(false);
    if (!refused.admitted) expect(refused.retryAfterMs).toBe(10_000);
    // Nothing slept: refusing is meant to be immediate.
    expect(clock.sleeps).toEqual([]);
  });

  it("claims its slot synchronously, so concurrent callers cannot both pass", async () => {
    const clock = fakeClock();
    const gate = new MinIntervalGate(10_000, 0, clock);

    // Both start before either awaits anything.
    const [a, b] = await Promise.all([gate.acquire(), gate.acquire()]);

    const admitted = [a, b].filter((entry) => entry.admitted).length;
    expect(admitted).toBe(1);
  });

  it("spaces a run of callers by the interval", async () => {
    const clock = fakeClock();
    const gate = new MinIntervalGate(1000, 60_000, clock);

    for (let i = 0; i < 4; i += 1) {
      expect((await gate.acquire()).admitted).toBe(true);
    }

    // First is free; each subsequent one waits a full interval.
    expect(clock.sleeps).toEqual([1000, 1000, 1000]);
  });

  it("trusts the upstream's retry window over its own arithmetic", async () => {
    const clock = fakeClock();
    const gate = new MinIntervalGate(1000, 0, clock);

    await gate.acquire();
    clock.advance(1000); // our interval says a slot is free
    expect(gate.waitMs()).toBe(0);

    gate.penalize(8000); // the upstream says otherwise
    expect(gate.waitMs()).toBe(8000);
    expect((await gate.acquire()).admitted).toBe(false);
  });

  it("reports the wait remaining", async () => {
    const clock = fakeClock();
    const gate = new MinIntervalGate(5000, 0, clock);
    await gate.acquire();
    expect(gate.waitMs()).toBe(5000);
    clock.advance(2000);
    expect(gate.waitMs()).toBe(3000);
    clock.advance(4000);
    expect(gate.waitMs()).toBe(0);
  });
});
