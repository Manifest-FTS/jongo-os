import { cookies, headers } from "next/headers";
import { getWordPressTelemetrySnapshot, type WordPressTelemetrySnapshot } from "@/lib/wordpress-telemetry";

type WordPressTelemetrySnapshotInput = {
  siteId: string;
  isWordPress: boolean;
  hasCoolifyServiceUuid: boolean;
};

export async function getWordPressTelemetrySnapshotForRequest(
  input: WordPressTelemetrySnapshotInput
): Promise<WordPressTelemetrySnapshot> {
  const fallback = getWordPressTelemetrySnapshot(input);
  const cookieHeader = (await cookies()).toString();
  if (!cookieHeader) {
    return fallback;
  }

  const headerStore = await headers();
  const host = headerStore.get("x-forwarded-host") ?? headerStore.get("host");
  if (!host) {
    return fallback;
  }

  const proto = headerStore.get("x-forwarded-proto") ?? "https";
  const origin = `${proto}://${host}`;

  try {
    const response = await fetch(`${origin}/api/sites/${encodeURIComponent(input.siteId)}/wordpress-telemetry`, {
      headers: { cookie: cookieHeader },
      cache: "no-store"
    });

    if (!response.ok) {
      return fallback;
    }

    const snapshot = (await response.json()) as Partial<WordPressTelemetrySnapshot>;
    if (!snapshot || typeof snapshot !== "object" || !snapshot.policy) {
      return fallback;
    }

    return {
      siteId: snapshot.siteId ?? fallback.siteId,
      checkedAt: snapshot.checkedAt ?? fallback.checkedAt,
      source: snapshot.source ?? fallback.source,
      policy: snapshot.policy
    };
  } catch {
    return fallback;
  }
}