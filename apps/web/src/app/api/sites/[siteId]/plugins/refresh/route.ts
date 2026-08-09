import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { getSiteWorkspace } from "@/lib/repositories";
import { refreshPluginInventory } from "@/lib/wordpress-plugin-inventory";
import { toPluginInventory } from "@/lib/wordpress-plugin-probe";

// Shells out to ssh, so it needs the Node runtime.
export const runtime = "nodejs";

type Params = { params: Promise<{ siteId: string }> };

/**
 * POST /api/sites/[siteId]/plugins/refresh
 *
 * Re-read this app's plugin inventory from its container now, rather than waiting
 * for the hourly sweep. Read-only against the site: the probe runs WordPress with
 * SHORTINIT and only SELECTs.
 */
export async function POST(_request: Request, { params }: Params) {
  const { siteId } = await params;
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const workspace = await getSiteWorkspace(siteId, {
    userId: session.user.id,
    email: session.user.email
  });
  if (!workspace) {
    return NextResponse.json({ error: "Not found or insufficient permissions" }, { status: 404 });
  }

  // No extra permission gate: this reads inventory the page already displays to
  // anyone with access to the app, and changes nothing on the site.
  const resourceUuid = workspace.coolifyServiceUuid?.trim() ?? "";
  if (!resourceUuid) {
    return NextResponse.json(
      { ok: false, status: "no_containers", message: "This app is not linked to a Coolify resource." },
      { status: 409 }
    );
  }

  const collected = await refreshPluginInventory({ siteDbId: workspace.id, resourceUuid });
  const inventory = toPluginInventory(collected.plugins);

  if (collected.status === "ok") {
    return NextResponse.json({
      ok: true,
      status: collected.status,
      wpVersion: collected.wpVersion,
      installed: inventory.rows.length,
      active: inventory.activePlugins,
      updatesAvailable: inventory.updatesAvailable,
      message: `Read ${inventory.rows.length} plugins from this app's container.`
    });
  }

  if (collected.status === "deferred_deploy_in_progress") {
    return NextResponse.json({
      ok: false,
      status: collected.status,
      message: "A deploy is currently building on the host. The inventory will refresh once it finishes."
    });
  }

  return NextResponse.json(
    {
      ok: false,
      status: collected.status,
      message: collected.error ?? "The plugin inventory could not be read from this app's container."
    },
    { status: 502 }
  );
}
