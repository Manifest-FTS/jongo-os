import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";

function hasOpsToken(req: Request): boolean {
  const configured = process.env.OWNERSHIP_SYNC_TOKEN?.trim() || "";
  const authHeader = req.headers.get("authorization") ?? "";
  const provided = authHeader.replace(/^Bearer\s+/i, "").trim();
  return Boolean(configured && provided && configured === provided);
}

type Scope = "linked" | "all" | "staging-enabled";
type StagingTargetRow = {
  id: string;
  slug: string | null;
  name: string;
  stagingEnabled: boolean;
  coolifyServiceUuid: string | null;
};

function resolveScope(value: string | null): Scope {
  if (value === "all") return "all";
  if (value === "staging-enabled") return "staging-enabled";
  return "linked";
}

export async function GET(req: Request) {
  const session = await auth();
  const authorizedByToken = hasOpsToken(req);

  if (!session?.user?.id && !authorizedByToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const scope = resolveScope(new URL(req.url).searchParams.get("scope"));
  const { db } = await import("@/lib/db");

  const scopeFilter =
    scope === "staging-enabled"
      ? { stagingEnabled: true }
      : scope === "linked"
        ? { coolifyServiceUuid: { not: null as string | null } }
        : {};

  const accessFilter = authorizedByToken
    ? {}
    : {
        OR: [
          {
            organization: {
              deletedAt: null,
              OR: [
                { ownerId: session!.user!.id },
                { collaborators: { some: { userId: session!.user!.id, deletedAt: null } } }
              ]
            }
          },
          { collaborators: { some: { userId: session!.user!.id, deletedAt: null } } }
        ]
      };

  const rows = await db.site.findMany({
    where: {
      deletedAt: null,
      isStagingResource: false,
      ...scopeFilter,
      ...accessFilter
    },
    select: {
      id: true,
      slug: true,
      name: true,
      stagingEnabled: true,
      coolifyServiceUuid: true
    },
    orderBy: { createdAt: "asc" }
  });

  const sites = (rows as StagingTargetRow[]).map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    stagingEnabled: row.stagingEnabled,
    linked: Boolean(row.coolifyServiceUuid),
    recommendedId: row.slug || row.id
  }));

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    scope,
    count: sites.length,
    sites
  });
}
