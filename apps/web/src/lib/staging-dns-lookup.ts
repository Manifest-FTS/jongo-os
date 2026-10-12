import { Resolver } from "node:dns/promises";
import type { DnsObservation } from "@/lib/staging-dns-check";

/**
 * Looks a hostname up the way the world sees it: through public resolvers
 * (Cloudflare, Google), not the server's own cache, which could still hold an
 * old answer for minutes after the client fixed their record.
 *
 * The verdict is decided in lib/staging-dns-check.ts; this only observes.
 */

function resolver(): Resolver {
  const r = new Resolver({ timeout: 4000, tries: 2 });
  r.setServers(["1.1.1.1", "8.8.8.8"]);
  return r;
}

type DnsError = { code?: string };

function classify(error: unknown): DnsObservation["error"] | "empty" {
  const code = (error as DnsError)?.code ?? "";
  if (code === "ENODATA") return "empty";
  if (code === "ENOTFOUND" || code === "NXDOMAIN") return "nxdomain";
  if (code === "ETIMEOUT" || code === "ECONNREFUSED") return "timeout";
  return "servfail";
}

async function safe<T>(lookup: () => Promise<T[]>): Promise<{ values: T[]; error?: DnsObservation["error"] }> {
  try {
    return { values: await lookup() };
  } catch (error) {
    const kind = classify(error);
    return kind === "empty" ? { values: [] } : { values: [], error: kind };
  }
}

/** CNAME chain (up to 5 hops) plus the final A and AAAA records. */
export async function observeDns(hostname: string): Promise<DnsObservation> {
  const r = resolver();
  const cnames: string[] = [];
  let current = hostname;
  for (let hop = 0; hop < 5; hop += 1) {
    const step = await safe(() => r.resolveCname(current));
    if (step.error === "nxdomain" && hop === 0) {
      // Could still have A records only if the name exists; checked below.
      break;
    }
    const next = step.values[0];
    if (!next || cnames.includes(next)) break;
    cnames.push(next);
    current = next;
  }

  const [a, aaaa] = await Promise.all([safe(() => r.resolve4(hostname)), safe(() => r.resolve6(hostname))]);
  const error = cnames.length || a.values.length || aaaa.values.length ? undefined : (a.error ?? aaaa.error);
  return { cnames, a: a.values, aaaa: aaaa.values, ...(error ? { error } : {}) };
}

/** The server's public IPs, read from the fallback host itself (no config needed). */
export async function resolveTargetIps(fallbackHost: string): Promise<string[]> {
  const configured = (process.env.STAGING_TARGET_IPS || "")
    .split(/[,\s]+/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (configured.length) return configured;
  const { values } = await safe(() => resolver().resolve4(fallbackHost));
  return values;
}
