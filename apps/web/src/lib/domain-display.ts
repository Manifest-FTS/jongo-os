/** How domain and charge states read in the dashboard. Pure. */

export type ChipTone = "healthy" | "degraded" | "error" | "unknown";

export const DOMAIN_STATUS: Record<string, { label: string; tone: ChipTone }> = {
  active: { label: "Active", tone: "healthy" },
  registering: { label: "Registering", tone: "degraded" },
  transfer_pending: { label: "Transfer in progress", tone: "degraded" },
  pending_payment: { label: "Awaiting payment", tone: "unknown" },
  failed: { label: "Failed", tone: "error" },
  expired: { label: "Expired", tone: "error" }
};

export const DNS_STATUS: Record<string, { label: string; tone: ChipTone }> = {
  active: { label: "DNS active", tone: "healthy" },
  pending: { label: "DNS pending", tone: "degraded" },
  error: { label: "DNS error", tone: "error" }
};

export const CHARGE_STATUS: Record<string, { label: string; tone: ChipTone }> = {
  pending_payment: { label: "Awaiting payment", tone: "unknown" },
  paid: { label: "Paid, ordering", tone: "degraded" },
  fulfilling: { label: "Ordering", tone: "degraded" },
  fulfilled: { label: "Completed", tone: "healthy" },
  refunded: { label: "Refunded", tone: "unknown" },
  failed: { label: "Failed", tone: "error" },
  expired: { label: "Checkout expired", tone: "unknown" }
};

export function statusOf(map: Record<string, { label: string; tone: ChipTone }>, key: string | null | undefined) {
  return (key && map[key]) || { label: key ? key.replace(/_/g, " ") : "—", tone: "unknown" as ChipTone };
}

/** Days until expiry (negative when past); null when unknown. */
export function daysUntil(date: Date | string | null | undefined, now: number = Date.now()): number | null {
  if (!date) return null;
  const time = new Date(date).getTime();
  return Number.isFinite(time) ? Math.floor((time - now) / 86_400_000) : null;
}

export function formatDate(date: Date | string | null | undefined): string {
  if (!date) return "—";
  return new Date(date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/**
 * Margin on a charge: what the client paid less what Namecheap actually took.
 * Falls back to the quoted wholesale cost until the order has been placed.
 */
export function chargeMargin(charge: { clientCents: number; wholesaleCents: number; registrarChargedCents: number | null; status: string }): {
  costCents: number;
  marginCents: number;
  costIsActual: boolean;
} {
  const costIsActual = charge.registrarChargedCents !== null;
  const costCents = costIsActual ? (charge.registrarChargedCents as number) : charge.wholesaleCents;
  return { costCents, marginCents: charge.clientCents - costCents, costIsActual };
}

/** Charges that count as money actually kept: paid and not refunded. */
export function isRevenue(status: string): boolean {
  return status === "fulfilled" || status === "paid" || status === "fulfilling";
}
