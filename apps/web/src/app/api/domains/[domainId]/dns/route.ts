import { NextResponse } from "next/server";
import { createDnsRecord, listDnsRecords, CloudflareError } from "@/lib/cloudflare";
import { validateDnsRecord } from "@/lib/dns-record";
import { getDomainViewer, loadDomainForViewer } from "@/lib/domain-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ domainId: string }> };

export async function GET(_request: Request, { params }: Params) {
  const viewer = await getDomainViewer();
  if (!viewer) return NextResponse.json({ ok: false, message: "Sign in first." }, { status: 401 });
  const found = await loadDomainForViewer((await params).domainId, viewer);
  if (!found) return NextResponse.json({ ok: false, message: "Not found." }, { status: 404 });
  if (!found.domain.cloudflareZoneId) return NextResponse.json({ ok: true, records: [], zoneReady: false });
  try {
    return NextResponse.json({ ok: true, zoneReady: true, records: await listDnsRecords(found.domain.cloudflareZoneId) });
  } catch (error) {
    return NextResponse.json({ ok: false, message: error instanceof Error ? error.message : "Could not read DNS." }, { status: 502 });
  }
}

export async function POST(request: Request, { params }: Params) {
  const viewer = await getDomainViewer();
  if (!viewer) return NextResponse.json({ ok: false, message: "Sign in first." }, { status: 401 });
  const found = await loadDomainForViewer((await params).domainId, viewer);
  if (!found) return NextResponse.json({ ok: false, message: "Not found." }, { status: 404 });
  if (!found.canManage) return NextResponse.json({ ok: false, message: "Only the client's admins can change DNS." }, { status: 403 });
  if (!found.domain.cloudflareZoneId) return NextResponse.json({ ok: false, message: "DNS is not set up for this domain yet." }, { status: 409 });

  const validated = validateDnsRecord(await request.json().catch(() => ({})));
  if (!validated.ok) return NextResponse.json({ ok: false, message: "Check the record.", fieldErrors: validated.errors }, { status: 400 });
  try {
    const record = await createDnsRecord(found.domain.cloudflareZoneId, found.domain.name, validated.record);
    return NextResponse.json({ ok: true, record });
  } catch (error) {
    const status = error instanceof CloudflareError && error.status >= 400 && error.status < 500 ? 400 : 502;
    return NextResponse.json({ ok: false, message: error instanceof Error ? error.message : "Cloudflare refused the record." }, { status });
  }
}
