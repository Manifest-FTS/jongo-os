import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canManageInfrastructure, canViewInfrastructure, type RbacPrincipal } from "./rbac";

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => "/dashboard" }));
vi.mock("next/link", () => ({ default: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props}>{children}</a> }));
import PlatformPrimaryNav from "@/components/navigation/PlatformPrimaryNav";

describe("financial navigation and infrastructure policy", () => {
  // Existing Vitest JSX transform is classic; Next uses the automatic runtime.
  beforeEach(() => vi.stubGlobal("React", React));
  afterEach(() => vi.unstubAllGlobals());
  it("omits billing navigation by default while retaining technical domains", () => {
    const html = renderToStaticMarkup(<PlatformPrimaryNav />);
    expect(html).not.toContain('href="/client-billing"');
    expect(html).toContain('href="/managed-domains"');
    expect(html).toContain('href="/my-domains"');
  });
  it("renders billing navigation only with the server-resolved capability", () => {
    expect(renderToStaticMarkup(<PlatformPrimaryNav canViewBilling />)).toContain('href="/client-billing"');
  });
  it("requires resource scope for a collaborator", () => {
    const user: RbacPrincipal = { userId: "user", email: "user@example.com", role: "collaborator", isPlatformAdmin: false };
    expect(canManageInfrastructure(user)).toBe(false);
    expect(canViewInfrastructure(user)).toBe(false);
    expect(canViewInfrastructure(user, true)).toBe(true);
    expect(canViewInfrastructure(null, true)).toBe(false);
    expect(canManageInfrastructure({ ...user, role: "admin", isPlatformAdmin: true })).toBe(true);
  });
});