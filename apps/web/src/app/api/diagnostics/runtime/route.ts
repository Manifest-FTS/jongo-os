import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { getRuntimeDiagnosticsSnapshot } from "@/lib/diagnostics";
import { canAccessRuntimeDiagnostics, runRuntimeDiagnosticsProbe } from "@/lib/runtime-diagnostics";

function bearerTokenFromAuthHeader(authHeader?: string | null): string | undefined {
  if (!authHeader) {
    return undefined;
  }

  const stripped = authHeader.replace(/^Bearer\s+/i, "").trim();
  return stripped.length > 0 ? stripped : undefined;
}

export async function GET(request: Request) {
  const session = await auth();
  const providedToken = bearerTokenFromAuthHeader(request.headers.get("authorization"));

  if (!canAccessRuntimeDiagnostics({ sessionEmail: session?.user?.email, bearerToken: providedToken })) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const shouldProbe = url.searchParams.get("probe") === "1";

  const diagnostics = shouldProbe
    ? await runRuntimeDiagnosticsProbe()
    : getRuntimeDiagnosticsSnapshot();

  return NextResponse.json(
    {
      ok: true,
      diagnostics
    },
    {
      status: 200,
      headers: {
        "Cache-Control": "no-store"
      }
    }
  );
}
