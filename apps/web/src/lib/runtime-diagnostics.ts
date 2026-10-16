import { auth } from "@/lib/auth.config";
import { isPlatformAdminUser } from "@/lib/rbac";
import { getRuntimeDiagnosticsSnapshot } from "@/lib/diagnostics";
import { getInventorySnapshot, listClientWorkspaces } from "@/lib/repositories";

export async function canAccessRuntimeDiagnostics(args: {
  userId?: string | null;
  bearerToken?: string;
}): Promise<boolean> {
  const configuredToken = process.env.OWNERSHIP_SYNC_TOKEN?.trim();
  const providedToken = args.bearerToken?.trim();
  if (configuredToken && providedToken && configuredToken === providedToken) {
    return true;
  }

  return isPlatformAdminUser(args.userId);
}

export async function runRuntimeDiagnosticsProbe() {
  const session = await auth();
  const viewer = {
    userId: session?.user?.id,
    email: session?.user?.email
  };

  await Promise.all([
    listClientWorkspaces(viewer),
    getInventorySnapshot(viewer)
  ]);

  return getRuntimeDiagnosticsSnapshot();
}
