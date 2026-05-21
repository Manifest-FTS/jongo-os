import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { getDb } from "@/lib/db";
import { getSiteWorkspace, isClientAdmin } from "@/lib/repositories";
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

function buildSiteIdentityWhere(siteId: string) {
  if (isUuid(siteId)) {
    return {
      OR: [{ id: siteId }, { slug: siteId }, { coolifyServiceUuid: siteId }, { coolifyServiceId: siteId }],
      deletedAt: null
    };
  }

  return {
    OR: [{ slug: siteId }, { coolifyServiceUuid: siteId }, { coolifyServiceId: siteId }],
    deletedAt: null
  };
}

function normalizeUrl(value: string): string {
  const normalized = value.trim();
  const parsed = new URL(normalized);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("WordPress site URL must start with http:// or https://");
  }
  return parsed.toString().replace(/\/+$/, "");
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

  if (!workspace) {
    return { error: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  }

  const db = await getDb();
  if (!db) {
    return { error: NextResponse.json({ error: "Database is not available" }, { status: 503 }) };
  }

  const site = await db.site.findFirst({
    where: buildSiteIdentityWhere(siteId),
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

  if (!site) {
    return { error: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  }

  const orgAdmin = workspace.organizationId
    ? await isClientAdmin(workspace.organizationId, session.user.id)
    : false;
  const ownerAdmin = site.organization?.ownerId === session.user.id;
  const siteAdmin = isAdminRole(site.collaborators[0]?.role);
  const orgCollaboratorAdmin = isAdminRole(site.organization?.collaborators[0]?.role);
  const canManage = Boolean(orgAdmin || ownerAdmin || siteAdmin || orgCollaboratorAdmin);

  if (!canManage) {
    return { error: NextResponse.json({ error: "Only admins can manage WordPress telemetry connections" }, { status: 403 }) };
  }

  return { db, workspace, site };
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
    where: { siteId: resolved.site.id },
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
    where: { siteId: resolved.site.id },
    create: {
      siteId: resolved.site.id,
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
      where: { siteId: resolved.site.id },
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
    where: { siteId: resolved.site.id },
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
        error: "Connection test failed. Verify URL, user, and WordPress application password.",
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
    where: { siteId: resolved.site.id }
  });

  return NextResponse.json({ ok: true });
}
