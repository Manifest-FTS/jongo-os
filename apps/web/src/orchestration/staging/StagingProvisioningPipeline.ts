import { coolifyMutate, coolifyFetch, resolveCoolifyServiceApplicationNames } from "../../lib/coolify";
import { StagingPipelineContext, StagingPipelineResult, StagingState } from "./types";

const activeDeployLocks = new Set<string>();

export class StagingProvisioningPipeline {
  private context: StagingPipelineContext;
  private readonly maxRetries = 30; // 60 seconds with 2s delay
  private readonly delayMs = 2000;

  constructor(context: StagingPipelineContext) {
    this.context = context;
  }

  private async sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  public async execute(): Promise<StagingPipelineResult> {
    if (activeDeployLocks.has(this.context.serviceUuid)) {
      return { success: false, state: StagingState.FAILED, error: "Concurrent staging update already in progress for this service." };
    }
    
    activeDeployLocks.add(this.context.serviceUuid);
    
    try {
      // Phase 1: DESIRED_STATE (Service exists, apply domain)
      const applied = await this.applyDesiredDomain();
      if (!applied) {
        return { success: false, state: StagingState.FAILED, error: "Failed to apply desired domain via PATCH" };
      }

      // Phase 2: APPLIED_STATE (Wait for Coolify to confirm state matches with stability window)
      const confirmed = await this.waitForCoolifyConfirmation();
      if (!confirmed) {
        return { success: false, state: StagingState.FAILED, error: "Coolify failed to confirm stable state convergence" };
      }

      // Phase 3: DEPLOYED_STATE (Trigger deploy and confirm status)
      const deployTriggered = await this.triggerDeploy();
      if (!deployTriggered) {
        return { success: false, state: StagingState.FAILED, error: "Failed to trigger deployment" };
      }

      const deployConfirmed = await this.confirmDeploymentStatus();
      if (!deployConfirmed) {
        return { success: false, state: StagingState.FAILED, error: "Deployment failed to reach healthy state" };
      }

      return { success: true, state: StagingState.DEPLOYED_STATE };
    } catch (error: any) {
      return { success: false, state: StagingState.FAILED, error: error.message || "Unknown error" };
    } finally {
      activeDeployLocks.delete(this.context.serviceUuid);
    }
  }

  private async applyDesiredDomain(): Promise<boolean> {
    const { serviceUuid, desiredDomain } = this.context;
    const names = await resolveCoolifyServiceApplicationNames(serviceUuid);
    const containerName = names.length > 0 ? names[0] : "default";

    // Strictly send the PATCH request with NO instant_deploy
    return await coolifyMutate(`/api/v1/services/${encodeURIComponent(serviceUuid)}`, "PATCH", {
      urls: [{ name: containerName, url: desiredDomain }],
      force_domain_override: true,
      instant_deploy: false
    });
  }

  private async waitForCoolifyConfirmation(): Promise<boolean> {
    const { serviceUuid, desiredDomain } = this.context;
    let consecutiveMatches = 0;
    const requiredConsecutiveMatches = 2;
    
    for (let i = 0; i < this.maxRetries; i++) {
      try {
        // 1. Verify FQDN is assigned
        const servicePayload = await coolifyFetch(`/api/v1/services/${encodeURIComponent(serviceUuid)}`) as any;
        const applications = servicePayload?.applications || [];
        const fqdnMatch = applications.some((app: any) => app.fqdn && app.fqdn.includes(desiredDomain));

        // 2. Verify env vars are assigned
        const envsPayload = await coolifyFetch(`/api/v1/services/${encodeURIComponent(serviceUuid)}/envs`) as any;
        const envsList = Array.isArray(envsPayload) ? envsPayload : (envsPayload?.data || []);
        const envMatch = envsList.some((env: any) => env.value && env.value.includes(desiredDomain));

        if (fqdnMatch && envMatch) {
          consecutiveMatches++;
          if (consecutiveMatches >= requiredConsecutiveMatches) {
            return true; // APPLIED_STATE confirmed over stability window
          }
        } else {
          consecutiveMatches = 0; // Reset on any divergence
        }
      } catch (e) {
        consecutiveMatches = 0;
        // Ignore fetch errors during polling, but it resets stability window
      }
      
      await this.sleep(this.delayMs);
    }
    return false;
  }

  private async triggerDeploy(): Promise<boolean> {
    const { serviceUuid } = this.context;
    return (await coolifyMutate(`/api/v1/services/${encodeURIComponent(serviceUuid)}/start`, "POST")) as boolean;
  }

  private async confirmDeploymentStatus(): Promise<boolean> {
    const { serviceUuid } = this.context;
    
    // Deployment takes longer, increase retries for this phase
    for (let i = 0; i < this.maxRetries * 3; i++) {
      try {
        const servicePayload = await coolifyFetch(`/api/v1/services/${encodeURIComponent(serviceUuid)}`) as any;
        if (servicePayload?.status === "healthy" || servicePayload?.status === "running") {
          return true;
        }
      } catch (e) {
        // Ignore fetch errors during polling
      }
      await this.sleep(this.delayMs);
    }
    return false;
  }
}
