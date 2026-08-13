export function isUuid(value?: string | null): boolean {
  if (!value) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function buildSiteIdentityWhere(siteId?: string | null): Record<string, unknown> {
  const normalizedSiteId = decodeURIComponent(String(siteId ?? "")).trim();

  if (!normalizedSiteId) {
    return {
      slug: "",
      deletedAt: null
    };
  }

  if (isUuid(normalizedSiteId)) {
    return {
      OR: [
        { id: normalizedSiteId },
        { slug: normalizedSiteId },
        { coolifyServiceUuid: normalizedSiteId },
        { coolifyServiceId: normalizedSiteId },
        { coolifyProjectId: normalizedSiteId }
      ],
      deletedAt: null
    };
  }

  return {
    slug: normalizedSiteId,
    deletedAt: null
  };
}
