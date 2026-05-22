import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { getDb } from "@/lib/db";
import { getSiteWorkspace } from "@/lib/repositories";
import { getWordPressTelemetrySnapshot } from "@/lib/wordpress-telemetry";
import { getWordPressTelemetrySnapshotFromCollector } from "@/lib/wordpress-telemetry-collector";
import type { SiteWorkspaceRecord } from "@/lib/repositories";

type Params = { params: Promise<{ siteId: string }> };

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function buildIdentityMatchers(values: string[]) {
  return values.flatMap((value) =>
    isUuid(value)
      ? [{ id: value }, { slug: value }, { coolifyServiceUuid: value }, { coolifyServiceId: value }]
      : [{ slug: value }, { coolifyServiceUuid: value }, { coolifyServiceId: value }]
  );
}

async function resolveAuthorizedSiteDbId(
  siteId: string,
  userId: string,
  workspace: SiteWorkspaceRecord
): Promise<string | null> {
  const db = await getDb();
  if (!db) {
    return null;
  }

  const identifiers = [
    siteId,
    workspace.id,
    workspace.slug,
    workspace.coolifyServiceUuid
  ]
    .map((value) => value?.trim() || "")
    .filter((value, index, arr) => value.length > 0 && arr.indexOf(value) === index);

  const identityMatchers = buildIdentityMatchers(identifiers);

  const site = await db.site.findFirst({
    where: {
      AND: [
        {
          deletedAt: null,
          OR: identityMatchers
        },
        {
          OR: [
            {
              organization: {
                deletedAt: null,
                OR: [
                  { ownerId: userId },
                  { collaborators: { some: { userId, deletedAt: null } } }
                ]
              }
            },
            { collaborators: { some: { userId, deletedAt: null } } }
          ]
        }
      ]
    },
    select: { id: true }
  });

  return site?.id ?? null;
}

/**
 * GET /api/sites/[siteId]/wordpress-telemetry
 * Read-only WordPress telemetry snapshot endpoint.
 */
export async function GET(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { siteId } = await params;

  try {
    const workspace = await getSiteWorkspace(siteId, {
      userId: session.user.id,
      email: session.user.email
    });

    if (!workspace) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const fallbackSnapshot = getWordPressTelemetrySnapshot({
      siteId: workspace.slug ?? workspace.id,
      isWordPress: workspace.siteType === "wordpress",
      hasCoolifyServiceUuid: Boolean(workspace.coolifyServiceUuid)
    });

    const collectorSnapshot = await getWordPressTelemetrySnapshotFromCollector({
      fallback: fallbackSnapshot,
      workspace,
      requestedSiteId: siteId,
      preferredSiteDbId: await resolveAuthorizedSiteDbId(siteId, session.user.id, workspace)
    });

    const snapshot = collectorSnapshot ?? fallbackSnapshot;

    return NextResponse.json(snapshot);
  } catch (error) {
    console.error("GET /api/sites/[siteId]/wordpress-telemetry error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}