import { createHash } from "node:crypto";

export function getGravatarUrl(email?: string | null, size = 160): string | null {
  const normalized = email?.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  const hash = createHash("md5").update(normalized).digest("hex");
  // d=blank: no Gravatar returns a transparent 200 PNG instead of a 404, so
  // UserAvatar's initials (drawn underneath) show through with no failed
  // request in the console and no dependence on onError firing after hydration.
  return `https://www.gravatar.com/avatar/${hash}?s=${size}&d=blank`;
}
