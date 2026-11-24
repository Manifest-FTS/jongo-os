import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { getSiteWorkspace } from "@/lib/repositories";
import { decryptSecret } from "@/lib/secret-box";
import { describeInstallProblem } from "@/lib/wordpress-install";
import { readOnlyDenial } from "@/lib/read-only-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ siteId: string }> };

/**
 * First-time WordPress setup for a site Jongo created.
 *
 *   GET    — state, admin username, login address, and the admin password
 *            while Jongo still holds it
 *   POST   — finish (or retry) the setup; streams progress when asked
 *   DELETE — "I've saved it": forget the admin password
 *
 * Open to anyone with access to the site: whoever created it needs the login,
 * and the password is only held until someone confirms it's saved.
 */

const NO_STORE = { "Cache-Control": "no-store" };

async function load(siteId: string) {
  const session = await auth();
  if (!session?.user?.id) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) } as const;
  const workspace = await getSiteWorkspace(siteId, { userId: session.user.id, email: session.user.email });
  if (!workspace) return { error: NextResponse.json({ error: "Not found" }, { status: 404 }) } as const;
  const { getDb } = await import("@/lib/db");
  const db = await getDb();
  if (!db) return { error: NextResponse.json({ error: "Not available right now." }, { status: 503 }) } as const;
  return { db, siteId: workspace.id as string } as const;
}

async function present(db: any, siteId: string) {
  const site = await db.site.findUnique({
    where: { id: siteId },
    select: { wpInstallState: true, wpInstallError: true, wpInstalledAt: true, wpInstallConfig: true, wpAdminPasswordEnc: true }
  });
  const config = (site?.wpInstallConfig ?? null) as { url?: string; adminUser?: string; adminEmail?: string } | null;
  let password: string | null = null;
  let passwordUnreadable = false;
  if (site?.wpAdminPasswordEnc) {
    try {
      password = decryptSecret(site.wpAdminPasswordEnc);
    } catch {
      passwordUnreadable = true;
    }
  }
  return {
    ok: true,
    state: site?.wpInstallState ?? null,
    problem: site?.wpInstallState === "failed" ? describeInstallProblem(String(site.wpInstallError ?? "")) : null,
    installedAt: site?.wpInstalledAt ?? null,
    adminUser: config?.adminUser ?? null,
    adminEmail: config?.adminEmail ?? null,
    loginUrl: config?.url ? `${config.url}/wp-admin/` : null,
    // Shown only once setup succeeded: before then it doesn't open anything.
    password: site?.wpInstallState === "installed" ? password : null,
    passwordUnreadable
  };
}

export async function GET(_request: Request, { params }: Params) {
  const loaded = await load((await params).siteId);
  if ("error" in loaded) return loaded.error;
  return NextResponse.json(await present(loaded.db, loaded.siteId), { headers: NO_STORE });
}

export async function POST(request: Request, { params }: Params) {
  const readOnly = await readOnlyDenial({ params });
  if (readOnly) return readOnly;
  const loaded = await load((await params).siteId);
  if ("error" in loaded) return loaded.error;
  const { db, siteId } = loaded;

  const run = async () => {
    const { runSiteWordPressInstall } = await import("@/lib/wordpress-install-run");
    const outcome = await runSiteWordPressInstall(db, siteId);
    const body = await present(db, siteId);
    return NextResponse.json({ ...body, ok: outcome.state !== "failed", message: outcome.message }, {
      status: outcome.state === "failed" ? 502 : 200,
      headers: NO_STORE
    });
  };

  const { progressResponse, wantsProgress } = await import("@/lib/progress");
  if (wantsProgress(request)) return progressResponse(run);
  return run();
}

export async function DELETE(_request: Request, { params }: Params) {
  const readOnly = await readOnlyDenial({ params });
  if (readOnly) return readOnly;
  const loaded = await load((await params).siteId);
  if ("error" in loaded) return loaded.error;
  await loaded.db.site.update({ where: { id: loaded.siteId }, data: { wpAdminPasswordEnc: null } });
  return NextResponse.json(await present(loaded.db, loaded.siteId), { headers: NO_STORE });
}
