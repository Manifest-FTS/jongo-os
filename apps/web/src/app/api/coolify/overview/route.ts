import { NextResponse } from "next/server";
import { getCoolifyOverview } from "../../../../lib/coolify";

export async function GET() {
  const overview = await getCoolifyOverview();

  return NextResponse.json(overview, {
    status: 200,
    headers: {
      "Cache-Control": "no-store"
    }
  });
}
