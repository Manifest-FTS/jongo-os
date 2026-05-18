import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { db } from "@/lib/db";
import { isAdminRole } from "@/lib/roles";

type Params = { params: Promise<{ organizationId: string }> };

type MappingRow = {
  coolifyProjectId: string;
  coolifyProjectName: string | null;
  isPrimary: boolean;
  createdAt: Date;
  updatedAt: Date;
};

function normalize(value?: string | null): string {
  return value?.trim().toLowerCase() ?? "";
}

function driftState(orgName: string, projectName?: string | null): "aligned" | "name_drift" | "unknown" {
  if (!projectName) {
    return "unknown";
  }

  return normalize(orgName) === normalize(projectName) ? "aligned" : "name_drift";
}

async function getAuthorizedOrg(organizationId: string, userId: string) {
  return db.organization.findFirst({
    where: {
      id: organizationId,
      deletedAt: null,
      OR: [
        { ownerId: userId },
        { collaborators: { some: { userId, deletedAt: null } } }
      ]
    },
    include: {
      collaborators: {
        where: { userId, deletedAt: null },
        select: { role: true }
      }
    }
  });
}

async function loadActiveMappings(organizationId: string): Promise<MappingRow[]> {
  return db.$queryRaw<MappingRow[]>`
    select
      l."coolifyProjectId",
      l."coolifyProjectName",
      l."isPrimary",
      l."createdAt",
      l."updatedAt"
    from "OrganizationCoolifyProjectLink" l
    where l."organizationId" = ${organizationId}
      and l."deletedAt" is null
    order by l."isPrimary" desc, l."createdAt" asc
  `;
}

async function buildMappingResponse(org: any) {
  const links = await loadActiveMappings(org.id);
  const conflictChecks = await Promise.all(
    links.map(async (row) => {
      const conflictRows = await db.$queryRaw<Array<{ orgCount: number }>>`
        select count(distinct l."organizationId")::int as "orgCount"
        from "OrganizationCoolifyProjectLink" l
        join "Organization" o on o.id = l."organizationId"
        where l."coolifyProjectId" = ${row.coolifyProjectId}
          and l."deletedAt" is null
          and o."deletedAt" is null
      `;

      return {
        coolifyProjectId: row.coolifyProjectId,
        hasConflict: (conflictRows[0]?.orgCount ?? 0) > 1
      };
    })
  );
  const conflictProjectIds = new Set(
    conflictChecks.filter((row) => row.hasConflict).map((row) => row.coolifyProjectId)
  );

  const linkedProjects = links.map((row) => ({
    coolifyProjectId: row.coolifyProjectId,
    coolifyProjectName: row.coolifyProjectName,
    isPrimary: row.isPrimary,
    driftState: driftState(org.name, row.coolifyProjectName),
    hasConflict: conflictProjectIds.has(row.coolifyProjectId)
  }));

  if (linkedProjects.length === 0 && org.coolifyProjectId) {
    linkedProjects.push({
      coolifyProjectId: org.coolifyProjectId,
      coolifyProjectName: org.coolifyProjectName,
      isPrimary: true,
      driftState: driftState(org.name, org.coolifyProjectName),
      hasConflict: false,
      source: "legacy"
    } as any);
  }

  return {
    organizationId: org.id,
    organizationName: org.name,
    legacy: {
      coolifyProjectId: org.coolifyProjectId,
      coolifyProjectName: org.coolifyProjectName
    },
    linkedProjects
  };
}

export async function GET(_request: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { organizationId } = await params;
  const org = await getAuthorizedOrg(organizationId, session.user.id);
  if (!org) {
    return NextResponse.json({ error: "Organization not found" }, { status: 404 });
  }

  const callerIsOwner = org.ownerId === session.user.id;
  const callerIsAdmin = callerIsOwner || isAdminRole(org.collaborators[0]?.role);
  if (!callerIsAdmin) {
    return NextResponse.json({ error: "Only admins can view mapping controls" }, { status: 403 });
  }

  return NextResponse.json(await buildMappingResponse(org));
}

export async function POST(request: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { organizationId } = await params;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const action = typeof body.action === "string" ? body.action : "link";
  const coolifyProjectId = typeof body.coolifyProjectId === "string" ? body.coolifyProjectId.trim() : "";
  const coolifyProjectName = typeof body.coolifyProjectName === "string" ? body.coolifyProjectName.trim() : null;
  const setPrimary = body.isPrimary === true;

  if (!coolifyProjectId) {
    return NextResponse.json({ error: "coolifyProjectId is required" }, { status: 400 });
  }

  const org = await getAuthorizedOrg(organizationId, session.user.id);
  if (!org) {
    return NextResponse.json({ error: "Organization not found" }, { status: 404 });
  }

  const callerIsOwner = org.ownerId === session.user.id;
  const callerIsAdmin = callerIsOwner || isAdminRole(org.collaborators[0]?.role);
  if (!callerIsAdmin) {
    return NextResponse.json({ error: "Only admins can manage Coolify mapping" }, { status: 403 });
  }

  const existingOther = await db.$queryRaw<Array<{ organizationId: string; organizationName: string }>>`
    select l."organizationId", o.name as "organizationName"
    from "OrganizationCoolifyProjectLink" l
    join "Organization" o on o.id = l."organizationId"
    where l."coolifyProjectId" = ${coolifyProjectId}
      and l."deletedAt" is null
      and l."organizationId" <> ${organizationId}
      and o."deletedAt" is null
    limit 1
  `;

  if (existingOther.length > 0) {
    return NextResponse.json(
      {
        error: `Project is already linked to ${existingOther[0].organizationName}. Multi-org project links are not enabled yet.`
      },
      { status: 409 }
    );
  }

  if (action === "unlink") {
    await db.$executeRaw`
      update "OrganizationCoolifyProjectLink"
      set "deletedAt" = now(), "isPrimary" = false, "updatedAt" = now()
      where "organizationId" = ${organizationId}
        and "coolifyProjectId" = ${coolifyProjectId}
        and "deletedAt" is null
    `;

    const remaining = await loadActiveMappings(organizationId);
    if (remaining.length === 0) {
      await db.organization.update({
        where: { id: organizationId },
        data: {
          coolifyProjectId: null,
          coolifyProjectName: null
        }
      });
    } else {
      const primary = remaining.find((row) => row.isPrimary) ?? remaining[0];
      await db.$executeRaw`
        update "OrganizationCoolifyProjectLink"
        set "isPrimary" = false, "updatedAt" = now()
        where "organizationId" = ${organizationId}
          and "deletedAt" is null
      `;
      await db.$executeRaw`
        update "OrganizationCoolifyProjectLink"
        set "isPrimary" = true, "updatedAt" = now()
        where "organizationId" = ${organizationId}
          and "coolifyProjectId" = ${primary.coolifyProjectId}
          and "deletedAt" is null
      `;

      await db.organization.update({
        where: { id: organizationId },
        data: {
          coolifyProjectId: primary.coolifyProjectId,
          coolifyProjectName: primary.coolifyProjectName ?? null
        }
      });
    }

    return NextResponse.json(await buildMappingResponse(org));
  }

  const existingForOrg = await db.$queryRaw<Array<{ coolifyProjectId: string; deletedAt: Date | null }>>`
    select "coolifyProjectId", "deletedAt"
    from "OrganizationCoolifyProjectLink"
    where "organizationId" = ${organizationId}
      and "coolifyProjectId" = ${coolifyProjectId}
    limit 1
  `;

  if (existingForOrg.length > 0) {
    await db.$executeRaw`
      update "OrganizationCoolifyProjectLink"
      set
        "coolifyProjectName" = ${coolifyProjectName},
        "deletedAt" = null,
        "updatedAt" = now()
      where "organizationId" = ${organizationId}
        and "coolifyProjectId" = ${coolifyProjectId}
    `;
  } else {
    await db.$executeRaw`
      insert into "OrganizationCoolifyProjectLink" (
        id,
        "organizationId",
        "coolifyProjectId",
        "coolifyProjectName",
        "isPrimary",
        "createdAt",
        "updatedAt"
      )
      values (
        gen_random_uuid(),
        ${organizationId},
        ${coolifyProjectId},
        ${coolifyProjectName},
        false,
        now(),
        now()
      )
    `;
  }

  const activeLinks = await loadActiveMappings(organizationId);
  const shouldSetPrimary = setPrimary || activeLinks.every((row) => !row.isPrimary);
  if (shouldSetPrimary) {
    await db.$executeRaw`
      update "OrganizationCoolifyProjectLink"
      set "isPrimary" = false, "updatedAt" = now()
      where "organizationId" = ${organizationId}
        and "deletedAt" is null
    `;

    await db.$executeRaw`
      update "OrganizationCoolifyProjectLink"
      set "isPrimary" = true, "updatedAt" = now()
      where "organizationId" = ${organizationId}
        and "coolifyProjectId" = ${coolifyProjectId}
        and "deletedAt" is null
    `;

    await db.organization.update({
      where: { id: organizationId },
      data: {
        coolifyProjectId,
        coolifyProjectName: coolifyProjectName ?? null
      }
    });
  }

  return NextResponse.json(await buildMappingResponse(org));
}
