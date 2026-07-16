import { NextResponse } from "next/server";
import { SecurityService, ScanReportPayload } from "@/services/security/SecurityService";
import crypto from "crypto";

// Security Note: In production, the HMAC secret should be securely distributed to the Coolify job
const SCANNER_HMAC_SECRET = process.env.SCANNER_HMAC_SECRET || "dev-secret-key-change-me";

function verifySignature(payload: string, signature: string): boolean {
  if (!signature) return false;
  const hmac = crypto.createHmac("sha256", SCANNER_HMAC_SECRET);
  hmac.update(payload);
  const expectedSignature = hmac.digest("hex");
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
}

export async function POST(req: Request) {
  try {
    const rawBody = await req.text();
    const signature = req.headers.get("X-Scanner-Signature") || "";

    if (!verifySignature(rawBody, signature)) {
      return NextResponse.json({ error: "Unauthorized: Invalid signature" }, { status: 401 });
    }

    const payload: ScanReportPayload = JSON.parse(rawBody);

    // Validate timestamp TTL (prevent replay attacks > 5 minutes old)
    const MAX_TTL_MS = 5 * 60 * 1000;
    if (Date.now() - payload.timestamp > MAX_TTL_MS) {
      return NextResponse.json({ error: "Unauthorized: Payload expired" }, { status: 401 });
    }

    const securityService = new SecurityService();
    await securityService.processScanReport(payload);

    return NextResponse.json({ success: true, received: true });
  } catch (error: any) {
    console.error("Failed to process scan report:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
