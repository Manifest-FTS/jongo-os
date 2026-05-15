"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { SVGProps } from "react";
import { BuildingOfficeIcon, DashboardIcon, ServerIcon, SettingsIcon } from "@/components/JongoIcons";

type NavItem = {
  href: string;
  label: string;
  icon: React.ComponentType<SVGProps<SVGSVGElement>>;
  match: "exact" | "prefix";
};

const navItems: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: DashboardIcon, match: "exact" },
  { href: "/organizations", label: "Clients", icon: BuildingOfficeIcon, match: "prefix" },
  { href: "/sites", label: "Sites", icon: ServerIcon, match: "prefix" },
  { href: "/settings", label: "Settings", icon: SettingsIcon, match: "prefix" }
];

function isItemActive(pathname: string, item: NavItem) {
  if (item.match === "exact") {
    return pathname === item.href;
  }

  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

export default function PlatformPrimaryNav() {
  const pathname = usePathname();

  return (
    <nav className="app-nav card" aria-label="Primary navigation">
      <div className="app-nav-items">
        {navItems.map((item) => {
          const active = isItemActive(pathname, item);

          return (
            <Link
              key={item.href}
              href={item.href}
              className={`app-nav-item${active ? " is-active" : ""}`}
              aria-current={active ? "page" : undefined}
            >
              <item.icon className="sidebar-icon" />
              <span className="app-nav-label">{item.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}