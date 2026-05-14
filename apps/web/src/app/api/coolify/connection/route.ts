import { NextResponse } from "next/server";
import { getCoolifyConnectionStatus } from "@/lib/coolify";

export async function GET() {
  const status = await getCoolifyConnectionStatus();
  const httpStatus = status.reachable || !status.configured ? 200 : 502;
  return NextResponse.json(status, { status: httpStatus });
}
