type DirectoryCandidate = {
  name: string;
  slug?: string;
  source: "db" | "coolify";
};

function normalized(value?: string): string {
  return value?.trim().toLowerCase() ?? "";
}

export function chooseCanonicalDirectoryCandidate<T extends DirectoryCandidate>(
  current: T,
  candidate: T,
  liveName?: string,
  canonicalSlug?: string
): T {
  if (current.source === "coolify" && candidate.source === "db") {
    return candidate;
  }
  if (current.source !== "db" || candidate.source !== "db") {
    return current;
  }

  const liveNameKey = normalized(liveName);
  const currentNameMatches = Boolean(liveNameKey && normalized(current.name) === liveNameKey);
  const candidateNameMatches = Boolean(liveNameKey && normalized(candidate.name) === liveNameKey);
  if (candidateNameMatches !== currentNameMatches) {
    return candidateNameMatches ? candidate : current;
  }

  const canonicalSlugKey = normalized(canonicalSlug);
  const currentSlugMatches = Boolean(canonicalSlugKey && normalized(current.slug) === canonicalSlugKey);
  const candidateSlugMatches = Boolean(canonicalSlugKey && normalized(candidate.slug) === canonicalSlugKey);
  if (candidateSlugMatches !== currentSlugMatches) {
    return candidateSlugMatches ? candidate : current;
  }

  return current;
}

export function resolveLiveWorkspaceIdentity(input: {
  storedName: string;
  storedSlug?: string;
  storedTemporaryDomainSlug?: string;
  liveName?: string;
  liveCanonicalSlug?: string;
}): { name: string; slug?: string; temporaryDomainSlug?: string } {
  const liveName = input.liveName?.trim();
  if (!liveName || normalized(liveName) === normalized(input.storedName)) {
    return {
      name: input.storedName,
      slug: input.storedSlug,
      temporaryDomainSlug: input.storedTemporaryDomainSlug
    };
  }

  const canonicalSlug = input.liveCanonicalSlug?.trim() || input.storedSlug;
  return {
    name: liveName,
    slug: canonicalSlug,
    temporaryDomainSlug: canonicalSlug
  };
}
