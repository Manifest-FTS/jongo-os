import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForStagingCapabilityToClear } from "./staging-capability-clear";

describe("waitForStagingCapabilityToClear", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries while Coolify still reports the old staging target during disable/re-enable churn", async () => {
    vi.useFakeTimers();

    const sequence = [
      { detected: true, applicationUuid: "stale-uuid", status: "healthy" },
      { detected: true, applicationUuid: "stale-uuid", status: "healthy" },
      { detected: false, note: "no_staging_environment_in_project" }
    ];

    const probe = vi.fn();
    sequence.forEach((value) => probe.mockResolvedValueOnce(value));

    const promise = waitForStagingCapabilityToClear(probe, 3, 1000);

    await vi.runAllTimersAsync();
    await expect(promise).resolves.toMatchObject({ detected: false, note: "no_staging_environment_in_project" });
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it("returns the last capability when the staging target never clears", async () => {
    vi.useFakeTimers();

    const lastCapability = { detected: true, applicationUuid: "still-there", status: "healthy" };
    const probe = vi.fn().mockResolvedValue(lastCapability);

    const promise = waitForStagingCapabilityToClear(probe, 2, 200);

    await vi.runAllTimersAsync();
    await expect(promise).resolves.toMatchObject({ applicationUuid: "still-there" });
    expect(probe).toHaveBeenCalledTimes(2);
  });
});
