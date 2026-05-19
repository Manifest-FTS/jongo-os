import { AppBackupInventory } from "@/lib/coolify";

function hasSuccessfulBackup(inventory: AppBackupInventory): boolean {
  return inventory.recentExecutions.some((item) => item.status === "success" && Boolean(item.finishedAt));
}

export function getDeployLockReason(inventory: AppBackupInventory | null, appUuid?: string): string | null {
  if (!appUuid) {
    return "Deploy actions are locked until this app is linked to a Coolify UUID in Settings.";
  }

  if (!inventory || inventory.source !== "live") {
    return "Deploy actions are locked until live backup telemetry is available from Coolify.";
  }

  if (!inventory.configured) {
    return "Deploy actions are locked until automated backups are configured.";
  }

  if (!hasSuccessfulBackup(inventory)) {
    return "Deploy actions are locked until at least one successful backup is recorded.";
  }

  return null;
}