import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { getDb } from "@/lib/db";
import { getSiteWorkspace } from "@/lib/repositories";
import type { SiteWorkspaceRecord } from "@/lib/repositories";
import { collectFromRestCredentials } from "@/lib/wordpress-telemetry-bridge-providers";
import { decryptSecret, encryptSecret } from "@/lib/wordpress-telemetry-secrets";
import { isAdminRole } from "@/lib/roles";

type Params = { params: Promise<{ siteId: string }> };

type WordPressConfigBody = {
  siteUrl?: string;
  username?: string;
  appPassword?: string;
};

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function buildIdentityMatchers(values: string[]) {
  return values.flatMap((value): Array<Record<string, string>> =>
    isUuid(value)
      ? [
          { id: value },
          { slug: value },
          { coolifyServiceUuid: value },
          { coolifyServiceId: value },
          { coolifyProjectId: value }
        ]
      : [
          { slug: value },
          { coolifyServiceUuid: value },
          { coolifyServiceId: value },
          { coolifyProjectId: value },
          { name: value }
        ]
  );
}

function normalizeEmail(value?: string | null): string {
  return value?.trim().toLowerCase() ?? "";
}

function hasBootstrapGlobalAccess(email?: string | null): boolean {
  const configured = normalizeEmail(process.env.BOOTSTRAP_ADMIN_EMAIL);
  const viewer = normalizeEmail(email);
  return Boolean(configured && viewer && configured === viewer);
}

function toSiteSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

async function ensureSiteRecordForWorkspace(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  workspace: SiteWorkspaceRecord,
  fallbackSiteId: string,
  ownerUserId?: string
): Promise<string | null> {
  let organization = await db.organization.findFirst({
    where: {
      deletedAt: null,
      OR: [
        { slug: workspace.clientId },
        { name: workspace.clientName },
        ...(workspace.coolifyProjectId ? [{ coolifyProjectId: workspace.coolifyProjectId }] : []),
        ...(workspace.coolifyProjectName ? [{ coolifyProjectName: workspace.coolifyProjectName }] : []),
        ...(workspace.coolifyProjectId
          ? [{ coolifyProjectLinks: { some: { coolifyProjectId: workspace.coolifyProjectId, deletedAt: null } } }]
          : []),
        ...(workspace.coolifyProjectName
          ? [{ coolifyProjectLinks: { some: { coolifyProjectName: workspace.coolifyProjectName, deletedAt: null } } }]
          : [])
      ]
    },
    select: { id: true }
  });

  if (!organization && ownerUserId) {
    const ownedOrgs = await db.organization.findMany({
      where: { deletedAt: null, ownerId: ownerUserId },
      select: { id: true },
      take: 2
    });

    if (ownedOrgs.length === 1) {
      organization = ownedOrgs[0];
    }
  }

  if (!organization) {
    return null;
  }

  const slug = toSiteSlug(workspace.slug ?? fallbackSiteId ?? workspace.name);

  const existing = await db.site.findFirst({
    where: {
      deletedAt: null,
      organizationId: organization.id,
      OR: [
        { slug },
        { coolifyServiceId: workspace.id },
        ...(workspace.coolifyServiceUuid ? [{ coolifyServiceUuid: workspace.coolifyServiceUuid }] : []),
        ...(workspace.deployTargetId ? [{ coolifyServiceId: workspace.deployTargetId }] : []),
        ...(workspace.coolifyProjectId ? [{ coolifyProjectId: workspace.coolifyProjectId }] : [])
      ]
    },
    select: { id: true }
  });

  if (existing?.id) {
    return existing.id;
  }

  const created = await db.site.create({
    data: {
      organizationId: organization.id,
      slug,
      name: workspace.name,
      coolifyServiceId: workspace.id || workspace.deployTargetId || null,
      coolifyServiceUuid:
        workspace.coolifyServiceUuid ||
        (isUuid(workspace.id) ? workspace.id : null) ||
        (workspace.deployTargetId && isUuid(workspace.deployTargetId) ? workspace.deployTargetId : null),
      coolifyProjectId: workspace.coolifyProjectId || null,
      coolifyProjectName: workspace.coolifyProjectName || null
    },
    select: { id: true }
  });

  return created.id;
}

async function recoverTelemetryConfigForResolvedSite(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  resolvedSiteId: string,
  identityMatchers: Array<Record<string, string>>,
  organizationId?: string
): Promise<void> {
  const existing = await db.wordPressTelemetryConfig.findUnique({
    where: { siteId: resolvedSiteId },
    select: { id: true }
  });

  if (existing) {
    return;
  }

  const legacy = await db.wordPressTelemetryConfig.findFirst({
    where: {
      site: {
        deletedAt: null,
        ...(organizationId ? { organizationId } : {}),
        OR: identityMatchers as any,
        id: { not: resolvedSiteId }
      }
    },
    select: {
      siteUrl: true,
      username: true,
      passwordCiphertext: true,
      lastTestedAt: true,
      lastTestStatus: true,
      lastError: true
    }
  });

  if (!legacy) {
    return;
  }

  await db.wordPressTelemetryConfig.upsert({
    where: { siteId: resolvedSiteId },
    create: {
      siteId: resolvedSiteId,
      siteUrl: legacy.siteUrl,
      username: legacy.username,
      passwordCiphertext: legacy.passwordCiphertext,
      lastTestedAt: legacy.lastTestedAt,
      lastTestStatus: legacy.lastTestStatus,
      lastError: legacy.lastError
    },
    update: {
      siteUrl: legacy.siteUrl,
      username: legacy.username,
      passwordCiphertext: legacy.passwordCiphertext,
      lastTestedAt: legacy.lastTestedAt,
      lastTestStatus: legacy.lastTestStatus,
      lastError: legacy.lastError
    }
  });
}

function normalizeUrl(value: string): string {
  const normalized = value.trim();
  const parsed = new URL(normalized);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("WordPress site URL must start with http:// or https://");
  }

  let path = (parsed.pathname || "").replace(/\/+$/, "");
  path = path.replace(/\/wp-admin(?:\/.*)?$/i, "");
  path = path.replace(/\/wp-login\.php$/i, "");
  path = path.replace(/\/wp-json(?:\/.*)?$/i, "");

  const normalizedPath = path && path !== "/" ? path : "";
  return `${parsed.origin}${normalizedPath}`;
}

async function resolveAuthorizedSite(siteId: string) {
  const session = await auth();
  if (!session?.user?.id) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }

  const workspace = await getSiteWorkspace(siteId, {
    userId: session.user.id,
    email: session.user.email
  });
  const bootstrapGlobalAccess = hasBootstrapGlobalAccess(session.user.email);

  const db = await getDb();
  if (!db) {
    return { error: NextResponse.json({ error: "Database is not available" }, { status: 503 }) };
  }

  const identifiers = [
    siteId,
    workspace?.id,
    workspace?.slug,
    workspace?.coolifyServiceUuid,
    workspace?.coolifyProjectId,
    workspace?.name
  ]
    .map((value) => value?.trim() || "")
    .filter((value, index, arr) => value.length > 0 && arr.indexOf(value) === index);

  const identityMatchers = buildIdentityMatchers(identifiers);

  const site = await db.site.findFirst({
    where: {
      AND: [
        {
          deletedAt: null,
          OR: identityMatchers as any
        },
        ...(workspace?.organizationId ? [{ organizationId: workspace.organizationId }] : []),
        ...(bootstrapGlobalAccess
          ? []
          : [
              {
                OR: [
                  {
                    organization: {
                      deletedAt: null,
                      OR: [
                        { ownerId: session.user.id },
                        { collaborators: { some: { userId: session.user.id, deletedAt: null } } }
                      ]
                    }
                  },
                  { collaborators: { some: { userId: session.user.id, deletedAt: null } } }
                ]
              }
            ])
      ]
    },
    include: {
      organization: {
        select: {
          ownerId: true,
          collaborators: {
            where: { userId: session.user.id, deletedAt: null },
            select: { role: true }
          }
        }
      },
      collaborators: {
        where: { userId: session.user.id, deletedAt: null },
        select: { role: true }
      }
    }
  });

  const resolvedSiteId =
    site?.id ??
    (bootstrapGlobalAccess && workspace
      ? await ensureSiteRecordForWorkspace(db, workspace, siteId, session.user.id)
      : null);

  if (!resolvedSiteId) {
    return { error: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  }

  await recoverTelemetryConfigForResolvedSite(
    db,
    resolvedSiteId,
    identityMatchers,
    workspace?.organizationId
  );

  const orgAdmin = site?.organization
    ? site.organization.ownerId === session.user.id || isAdminRole(site.organization.collaborators[0]?.role)
    : false;
  const ownerAdmin = site?.organization?.ownerId === session.user.id;
  const siteAdmin = isAdminRole(site?.collaborators?.[0]?.role);
  const orgCollaboratorAdmin = isAdminRole(site?.organization?.collaborators?.[0]?.role);
  const canManage = Boolean(bootstrapGlobalAccess || orgAdmin || ownerAdmin || siteAdmin || orgCollaboratorAdmin);

  if (!canManage) {
    return { error: NextResponse.json({ error: "Only admins can manage WordPress telemetry connections" }, { status: 403 }) };
  }

  return { db, siteId: resolvedSiteId };
}

async function parseBody(req: Request): Promise<WordPressConfigBody | NextResponse> {
  try {
    return await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
}

function toSummary(config: {
  siteUrl: string;
  username: string;
  lastTestedAt: Date | null;
  lastTestStatus: string | null;
  lastError: string | null;
} | null) {
  return {
    connected: Boolean(config),
    siteUrl: config?.siteUrl ?? null,
    username: config?.username ?? null,
    hasPassword: Boolean(config),
    lastTestedAt: config?.lastTestedAt?.toISOString() ?? null,
    lastTestStatus: config?.lastTestStatus ?? null,
    lastError: config?.lastError ?? null
  };
}

export async function GET(_req: Request, { params }: Params) {
  const { siteId } = await params;
  const resolved = await resolveAuthorizedSite(siteId);
  if (resolved.error) {
    return resolved.error;
  }

  const config = await resolved.db.wordPressTelemetryConfig.findUnique({
    where: { siteId: resolved.siteId },
    select: {
      siteUrl: true,
      username: true,
      lastTestedAt: true,
      lastTestStatus: true,
      lastError: true
    }
  });

  return NextResponse.json(toSummary(config));
}

export async function PUT(req: Request, { params }: Params) {
  const { siteId } = await params;
  const resolved = await resolveAuthorizedSite(siteId);
  if (resolved.error) {
    return resolved.error;
  }

  const body = await parseBody(req);
  if (body instanceof NextResponse) {
    return body;
  }

  const siteUrlRaw = body.siteUrl?.trim() || "";
  const username = body.username?.trim() || "";
  const appPassword = body.appPassword?.trim() || "";

  if (!siteUrlRaw || !username || !appPassword) {
    return NextResponse.json({ error: "siteUrl, username, and appPassword are required" }, { status: 400 });
  }

  let siteUrl = "";
  try {
    siteUrl = normalizeUrl(siteUrlRaw);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid siteUrl" }, { status: 400 });
  }

  const passwordCiphertext = encryptSecret(appPassword);

  const saved = await resolved.db.wordPressTelemetryConfig.upsert({
    where: { siteId: resolved.siteId },
    create: {
      siteId: resolved.siteId,
      siteUrl,
      username,
      passwordCiphertext,
      lastTestedAt: null,
      lastTestStatus: null,
      lastError: null
    },
    update: {
      siteUrl,
      username,
      passwordCiphertext,
      lastTestedAt: null,
      lastTestStatus: null,
      lastError: null
    },
    select: {
      siteUrl: true,
      username: true,
      lastTestedAt: true,
      lastTestStatus: true,
      lastError: true
    }
  });

  return NextResponse.json(toSummary(saved));
}

export async function POST(req: Request, { params }: Params) {
  const { siteId } = await params;
  const resolved = await resolveAuthorizedSite(siteId);
  if (resolved.error) {
    return resolved.error;
  }

  const body = await parseBody(req);
  if (body instanceof NextResponse) {
    return body;
  }

  let siteUrl = body.siteUrl?.trim() || "";
  let username = body.username?.trim() || "";
  let appPassword = body.appPassword?.trim() || "";

  if (!siteUrl || !username || !appPassword) {
    const saved = await resolved.db.wordPressTelemetryConfig.findUnique({
      where: { siteId: resolved.siteId },
      select: {
        siteUrl: true,
        username: true,
        passwordCiphertext: true
      }
    });

    if (!saved) {
      return NextResponse.json({ error: "No saved connection found for this app" }, { status: 400 });
    }

    siteUrl = saved.siteUrl;
    username = saved.username;

    try {
      appPassword = decryptSecret(saved.passwordCiphertext);
    } catch {
      return NextResponse.json({ error: "Saved secret could not be decrypted" }, { status: 500 });
    }
  }

  try {
    siteUrl = normalizeUrl(siteUrl);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid siteUrl" }, { status: 400 });
  }

  const snapshot = await collectFromRestCredentials(
    {
      siteUrl,
      username,
      appPassword
    },
    "collector_rest_manual_test"
  );

  const lastTestedAt = new Date();
  const success = Boolean(snapshot);

  await resolved.db.wordPressTelemetryConfig.updateMany({
    where: { siteId: resolved.siteId },
    data: {
      lastTestedAt,
      lastTestStatus: success ? "connected" : "failed",
      lastError: success ? null : "Unable to reach WordPress plugins REST endpoint with supplied credentials"
    }
  });

  if (!success) {
    return NextResponse.json(
      {
        ok: false,
        error: "Connection test failed. Use the site base URL (not /wp-admin) and a WordPress application password (not your normal login password).",
        testedAt: lastTestedAt.toISOString()
      },
      { status: 400 }
    );
  }

  return NextResponse.json({
    ok: true,
    testedAt: lastTestedAt.toISOString(),
    source: snapshot?.source ?? "collector_rest_manual_test",
    siteUrl: snapshot?.siteUrl ?? siteUrl,
    pluginCount: snapshot?.pluginInventory?.length ?? 0
  });
}

export async function DELETE(_req: Request, { params }: Params) {
  const { siteId } = await params;
  const resolved = await resolveAuthorizedSite(siteId);
  if (resolved.error) {
    return resolved.error;
  }

  await resolved.db.wordPressTelemetryConfig.deleteMany({
      where: { siteId: resolved.siteId }
  });

  return NextResponse.json({ ok: true });
}
