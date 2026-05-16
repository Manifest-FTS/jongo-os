import { auth } from "@/lib/auth.config";
import { getCoolifyOverview } from "@/lib/coolify";
import { getRuntimeDiagnosticsSnapshot } from "@/lib/diagnostics";
import { listClientWorkspaces, listSiteDirectory } from "@/lib/repositories";

function normalizeEmail(value?: string | null): string {
  return value?.trim().toLowerCase() ?? "";
}

export function canAccessRuntimeDiagnostics(args: {
  sessionEmail?: string | null;
  bearerToken?: string;
}): boolean {
  const isDev = process.env.NODE_ENV !== "production";
  if (isDev) {
    return true;
  }

  const bootstrapAdmin = normalizeEmail(process.env.BOOTSTRAP_ADMIN_EMAIL);
  const requestEmail = normalizeEmail(args.sessionEmail);
  if (bootstrapAdmin && requestEmail && bootstrapAdmin === requestEmail) {
    return true;
  }

  const configuredToken = process.env.OWNERSHIP_SYNC_TOKEN?.trim();
  const providedToken = args.bearerToken?.trim();
  if (configuredToken && providedToken && configuredToken === providedToken) {
    return true;
  }

  return false;
}

export async function runRuntimeDiagnosticsProbe() {
  const session = await auth();
  const viewer = {
    userId: session?.user?.id,
    email: session?.user?.email
  };

  await Promise.all([
    listClientWorkspaces(viewer),
    listSiteDirectory(viewer),
    getCoolifyOverview()
  ]);

  return getRuntimeDiagnosticsSnapshot();
}
