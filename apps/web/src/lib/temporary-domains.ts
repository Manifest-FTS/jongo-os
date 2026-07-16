export const TEMPORARY_DOMAIN_SUFFIX_OPTIONS = ["mfts.link", "manifest-fts.com"] as const;

export const DEFAULT_TEMPORARY_DOMAIN_SUFFIX = TEMPORARY_DOMAIN_SUFFIX_OPTIONS[0];

export type TemporaryDomainSuffix = (typeof TEMPORARY_DOMAIN_SUFFIX_OPTIONS)[number];

export function normalizeTemporaryDomainSlug(value?: string | null): string {
  if (!value) {
    return "";
  }

  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function resolveTemporaryDomainSuffix(value?: string | null): TemporaryDomainSuffix {
  const normalized = value?.trim().toLowerCase();
  return (TEMPORARY_DOMAIN_SUFFIX_OPTIONS as readonly string[]).includes(normalized ?? "")
    ? (normalized as TemporaryDomainSuffix)
    : DEFAULT_TEMPORARY_DOMAIN_SUFFIX;
}

export function buildTemporaryProductionDomain(options: {
  slug?: string | null;
  suffix?: string | null;
}): string | undefined {
  const slug = normalizeTemporaryDomainSlug(options.slug);
  if (!slug) {
    return undefined;
  }

  const suffix = resolveTemporaryDomainSuffix(options.suffix);
  return `${slug}.${suffix}`;
}
