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

  // Not a UUID: a slug, or a hosting resource id (Coolify's are not UUIDs, like
  // dt0v391xre5rgtp50062tunm). Matching only the slug sent apps reached by
  // their hosting id — including every app renamed in hosting, which the
  // directory links to through that id — to "not found". Callers always add
  // their own access check, so this widens nothing.
  return {
    OR: [{ slug: normalizedSiteId }, { coolifyServiceUuid: normalizedSiteId }, { coolifyServiceId: normalizedSiteId }],
    deletedAt: null
  };
}
