import { db } from "@/lib/db";
import { coolifyMutate } from "@/lib/coolify";

export class SecuritySchedulerWorker {
  private pollIntervalMs = 60 * 1000; // Poll every minute
  private isRunning = false;

  async start() {
    console.log("[SecuritySchedulerWorker] Starting worker...");
    this.isRunning = true;
    while (this.isRunning) {
      try {
        await this.pollAndDispatch();
      } catch (error) {
        console.error("[SecuritySchedulerWorker] Error during polling:", error);
      }
      await this.sleep(this.pollIntervalMs);
    }
  }

  stop() {
    this.isRunning = false;
  }

  private async pollAndDispatch() {
    // 1. Fetch sites that have security scanning enabled
    // Note: Assuming `scanFrequency` exists on Site or we have a settings relation
    // For this implementation, we will query all sites and check a hypothetical `securitySettings` JSON or relation
    
    // As a placeholder, we're fetching all sites that haven't been scanned in the last 24h
    // This query would ideally check the site's specific scan frequency setting.
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const pendingSites = await db.site.findMany({
      where: {
        // Pseudo-logic: find sites that have NO completed scans in the last 24 hours
        // In a real system, you'd use a left join or a separate ScanSchedule table
      }
    });

    // Mocking the dispatch for demonstration
    // if (pendingSites.length > 0) {
    //   for (const site of pendingSites) {
    //     await this.triggerCoolifyScanJob(site.id, site.coolifyServiceUuid);
    //   }
    // }
  }

  private async triggerCoolifyScanJob(siteId: string, coolifyServiceUuid: string) {
    console.log(`[SecuritySchedulerWorker] Dispatching scan job for site ${siteId} to Coolify...`);
    
    // In Coolify, we can execute a command inside a running container using the API:
    // POST /api/v1/services/{uuid}/execute
    const command = `/usr/local/bin/jongo-security-scan.sh --type malware --site ${siteId}`;
    
    try {
      await coolifyMutate(`/api/v1/services/${coolifyServiceUuid}/execute`, "POST", {
        command
      });
      console.log(`[SecuritySchedulerWorker] Successfully dispatched scan for ${siteId}`);
    } catch (error) {
      console.error(`[SecuritySchedulerWorker] Failed to dispatch scan for ${siteId}:`, error);
    }
  }

  private sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// If run directly
if (require.main === module) {
  const worker = new SecuritySchedulerWorker();
  worker.start();
}
