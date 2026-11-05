import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { resolveOrganizationAccess } from "@/lib/tenant-route-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ organizationId: string }> };

/**
 * POST: set up this client's hosting project now (lib/organization-hosting.ts).
 * Safe to repeat: an existing project is kept, and one an earlier attempt made
 * is found and reused. Client admins only. Says why when hosting refuses.
 */
export async function POST(_request: Request, { params }: Params) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return NextResponse.json({ ok: false, message: "Sign in first." }, { status: 401 });
  const { organizationId } = await params;
  const access = await resolveOrganizationAccess(organizationId, userId);
  if (!access) return NextResponse.json({ ok: false, message: "Client not found." }, { status: 404 });
  if (!access.isAdmin) return NextResponse.json({ ok: false, message: "Only the client's admins can set up hosting." }, { status: 403 });

  // New hosting needs a paid plan (lib/hosting-entitlement.ts).
  {
    const { checkHostingEntitlement, paymentRequiredBody } = await import("@/lib/hosting-entitlement");
    const entitlement = await checkHostingEntitlement({ organizationId: organizationId, actorUserId: userId });
    if (!entitlement.ok) return NextResponse.json(paymentRequiredBody(entitlement), { status: 402 });
  }

  const { ensureOrganizationHostingProject } = await import("@/lib/organization-hosting");
  const result = await ensureOrganizationHostingProject(organizationId);
  if (!result.ok) {
    // The technical reason is for platform admins; clients get plain words.
    return NextResponse.json(
      {
        ok: false,
        message: access.isPlatformAdmin ? result.message : "Hosting couldn't be set up right now. Try again in a few minutes; it's also done automatically with this client's first app.",
        detail: access.isPlatformAdmin ? result.detail ?? null : null,
        reason: result.reason
      },
      { status: 503 }
    );
  }
  const { audit } = await import("@/lib/github-installations");
  if (result.created) await audit(organizationId, userId, "hosting_project_created", { manual: true }, organizationId);
  return NextResponse.json({ ok: true, created: result.created, message: result.created ? "Hosting is set up." : "Hosting was already set up." });
}
