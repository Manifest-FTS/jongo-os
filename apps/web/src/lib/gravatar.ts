import { createHash } from "node:crypto";

export function getGravatarUrl(email?: string | null, size = 160): string | null {
  const normalized = email?.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  const hash = createHash("md5").update(normalized).digest("hex");
  return `https://www.gravatar.com/avatar/${hash}?s=${size}&d=404`;
}
