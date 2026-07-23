export function splitFullName(fullName?: string | null): { firstName: string; lastName: string } {
  const normalized = fullName?.trim() ?? "";
  if (!normalized) {
    return { firstName: "", lastName: "" };
  }

  const parts = normalized.split(/\s+/).filter(Boolean);
  if (parts.length === 1) {
    return { firstName: parts[0], lastName: "" };
  }

  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(" ")
  };
}

export function buildFullName(firstName?: string | null, lastName?: string | null): string | null {
  const fullName = [firstName?.trim(), lastName?.trim()].filter(Boolean).join(" ").trim();
  return fullName || null;
}

export function getInitials(fullName?: string | null, email?: string | null): string {
  const source = fullName?.trim() || email?.trim() || "User";
  const parts = source.split(/\s+/).filter(Boolean);

  if (parts.length >= 2) {
    return `${parts[0].charAt(0)}${parts[1].charAt(0)}`.toUpperCase();
  }

  const compact = source.replace(/[^a-z0-9]/gi, "");
  if (compact.length >= 2) {
    return compact.slice(0, 2).toUpperCase();
  }

  return source.charAt(0).toUpperCase();
}

export function normalizeUsername(value?: string | null): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "")
    .slice(0, 32);
}
