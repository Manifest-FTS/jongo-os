import { readMarketingPublication } from "@/lib/cms/marketing-release-adapter";
import { MarketingDeliveryError } from "@/lib/cms/marketing-snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", Vary: "Authorization", "X-Content-Type-Options": "nosniff" };

export async function GET(request: Request, context: { params: Promise<{ datasetId: string }> }) {
  try {
    const { datasetId } = await context.params;
    const snapshot = await readMarketingPublication(datasetId, request.headers.get("authorization"));
    // Authentication, pointer and checksum validation run even on conditional reads.
    const etag = `"${snapshot.releaseId}:${snapshot.checksum}"`;
    if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { ...headers, ETag: etag } });
    return Response.json(snapshot, { headers: { ...headers, ETag: etag } });
  } catch (error) {
    const code = error instanceof MarketingDeliveryError ? error.code : "unavailable";
    const status = code === "unauthorized" ? 401 : code === "not_found" ? 404 : 503;
    return Response.json({ error: code === "unauthorized" ? "Unauthorized" : code === "not_found" ? "Not found" : "Content unavailable" }, {
      status, headers: { ...headers, ...(status === 401 ? { "WWW-Authenticate": "Bearer" } : {}) }
    });
  }
}