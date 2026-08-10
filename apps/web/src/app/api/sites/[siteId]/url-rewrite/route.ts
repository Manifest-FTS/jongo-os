import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { getSiteWorkspace } from "@/lib/repositories";
import { resolveSitePermissionSnapshot } from "@/lib/permissions";
import { runUrlRewrite } from "@/lib/wp-url-rewrite-run";
import { summarizeRewriteReport } from "@/lib/wp-url-rewrite";

// Shells out to ssh.
export const runtime = "nodejs";

type Params = { params: Promise<{ siteId: string }> };

/**
 * POST /api/sites/[siteId]/url-rewrite
 * Body: { fromUrl: string; toUrl: string; apply?: boolean }
 *
 * Find/replace a site's URLs across its whole database — for an imported site
 * still carrying its old host, or one that has been renamed.
 *
 * Defaults to a DRY RUN. This rewrites a live customer database and there is no
 * undo beyond a backup, so the write has to be asked for explicitly rather than
 * arrived at by omitting a flag.
 */
export async function POST(request: Request, { params }: Params) {
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

  let body: { fromUrl?: string; toUrl?: string; apply?: boolean };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const fromUrl = body.fromUrl?.trim() ?? "";
  const toUrl = body.toUrl?.trim() ?? "";
  if (!fromUrl || !toUrl) {
    return NextResponse.json({ error: "fromUrl and toUrl are required." }, { status: 400 });
  }

  const apply = body.apply === true;

  // Editing every URL in the database is a domain-level change, so it is gated
  // on the same permission as editing domains rather than on read access.
  if (apply) {
    const permissionSnapshot = await resolveSitePermissionSnapshot({
      siteId,
      workspace,
      viewer: { userId: session.user.id, email: session.user.email }
    });
    if (!permissionSnapshot.canEditDomains) {
      return NextResponse.json(
        { error: "You do not have permission to rewrite this app's URLs." },
        { status: 403 }
      );
    }
  }

  const resourceUuid = workspace.coolifyServiceUuid?.trim() ?? "";
  const report = await runUrlRewrite({ resourceUuid, fromUrl, toUrl, apply });

  if (!report.ok) {
    return NextResponse.json(
      { ok: false, dryRun: report.dryRun, error: report.error, message: summarizeRewriteReport(report) },
      { status: 502 }
    );
  }

  if (apply) {
    try {
      const { db } = await import("@/lib/db");
      await db.auditLog.create({
        data: {
          organizationId: workspace.organizationId!,
          actorId: session.user.id,
          action: "site_updated",
          resourceType: "site",
          resourceId: workspace.id,
          details: {
            actionType: "site_url_rewritten",
            fromUrl,
            toUrl,
            pairs: report.pairs,
            rowsChanged: report.rowsChanged,
            skippedUnserializable: report.skippedUnserializable,
            tables: report.tables
          },
          ipAddress: request.headers.get("x-forwarded-for") ?? "unknown",
          userAgent: request.headers.get("user-agent") ?? undefined
        }
      });
    } catch (error) {
      // The rewrite already happened; failing the response now would invite a
      // retry that rewrites nothing and reads as a failure.
      console.error("[jongo] url-rewrite: audit log failed", error);
    }
  }

  return NextResponse.json({
    ok: true,
    dryRun: report.dryRun,
    pairs: report.pairs,
    rowsChanged: report.rowsChanged,
    skippedUnserializable: report.skippedUnserializable,
    tables: report.tables,
    message: summarizeRewriteReport(report)
  });
}
