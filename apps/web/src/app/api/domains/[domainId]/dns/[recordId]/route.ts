import { NextResponse } from "next/server";
import { deleteDnsRecord, updateDnsRecord, CloudflareError } from "@/lib/cloudflare";
import { validateDnsRecord } from "@/lib/dns-record";
import { getDomainViewer, loadDomainForViewer } from "@/lib/domain-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ domainId: string; recordId: string }> };

async function managedZone(params: Params["params"]) {
  const viewer = await getDomainViewer();
  if (!viewer) return { error: NextResponse.json({ ok: false, message: "Sign in first." }, { status: 401 }) };
  const { domainId, recordId } = await params;
  const found = await loadDomainForViewer(domainId, viewer);
  if (!found) return { error: NextResponse.json({ ok: false, message: "Not found." }, { status: 404 }) };
  if (!found.canManage) return { error: NextResponse.json({ ok: false, message: "Only the client's admins can change DNS." }, { status: 403 }) };
  if (!found.domain.cloudflareZoneId || !/^[a-f0-9]{32}$/i.test(recordId)) {
    return { error: NextResponse.json({ ok: false, message: "Not found." }, { status: 404 }) };
  }
  return { zoneId: found.domain.cloudflareZoneId as string, zoneName: found.domain.name as string, recordId };
}

function failure(error: unknown) {
  const status = error instanceof CloudflareError && error.status >= 400 && error.status < 500 ? 400 : 503;
  return NextResponse.json({ ok: false, message: error instanceof Error ? error.message : "Cloudflare refused the change." }, { status });
}

export async function PUT(request: Request, { params }: Params) {
  const target = await managedZone(params);
  if ("error" in target) return target.error;
  const validated = validateDnsRecord(await request.json().catch(() => ({})));
  if (!validated.ok) return NextResponse.json({ ok: false, message: "Check the record.", fieldErrors: validated.errors }, { status: 400 });
  try {
    return NextResponse.json({ ok: true, record: await updateDnsRecord(target.zoneId, target.zoneName, target.recordId, validated.record) });
  } catch (error) {
    return failure(error);
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  const target = await managedZone(params);
  if ("error" in target) return target.error;
  try {
    await deleteDnsRecord(target.zoneId, target.recordId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return failure(error);
  }
}
