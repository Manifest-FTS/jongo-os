"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useId, useState, type SVGProps } from "react";
import { BellIcon, BuildingOfficeIcon, ChartBarIcon, ChevronDownIcon, DashboardIcon, GlobeIcon, ServerIcon, SettingsIcon } from "@/components/JongoIcons";
import styles from "./PlatformPrimaryNav.module.css";

type NavItem = {
  href: string;
  label: string;
  icon: React.ComponentType<SVGProps<SVGSVGElement>>;
  match: "exact" | "prefix";
  billingOnly?: boolean;
  children?: NavItem[];
};

const navItems: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: DashboardIcon, match: "exact" },
  { href: "/clients", label: "Clients", icon: BuildingOfficeIcon, match: "prefix" },
  { href: "/apps", label: "Apps", icon: ServerIcon, match: "prefix" },
  { href: "/my-domains", label: "Domains", icon: GlobeIcon, match: "prefix", children: [
    { href: "/my-domains", label: "My domains", icon: GlobeIcon, match: "prefix" },
    { href: "/managed-domains", label: "Managed domains", icon: GlobeIcon, match: "prefix" }
  ] },
  { href: "/usage", label: "Usage", icon: ChartBarIcon, match: "prefix" },
  { href: "/settings", label: "Settings", icon: SettingsIcon, match: "prefix", children: [
    { href: "/settings", label: "Profile", icon: SettingsIcon, match: "prefix" },
    { href: "/notifications", label: "Notifications", icon: BellIcon, match: "prefix" },
    { href: "/client-billing", label: "Client billing", icon: ChartBarIcon, match: "prefix", billingOnly: true },
    { href: "/super-admin/access", label: "Users & access", icon: BuildingOfficeIcon, match: "prefix", billingOnly: true }
  ] }
];

function isItemActive(pathname: string, item: NavItem) {
  if (item.match === "exact") {
    return pathname === item.href;
  }

  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

export default function PlatformPrimaryNav({ canViewBilling = false }: { canViewBilling?: boolean }) {
  const pathname = usePathname() ?? "";
  const id = useId();
  // Route changes reveal the current branch, but a user can collapse it until
  // the next navigation. Unrelated renders must not force it open again.
  const [disclosure, setDisclosure] = useState<{ pathname: string; overrides: Record<string, boolean> }>({ pathname, overrides: {} });
  const overrides = disclosure.pathname === pathname ? disclosure.overrides : {};
  const setExpanded = (href: string, expanded: boolean) => {
    setDisclosure((previous) => ({
      pathname,
      overrides: { ...(previous.pathname === pathname ? previous.overrides : {}), [href]: expanded }
    }));
  };

  return (
    <nav className={`app-nav card ${styles.root}`} aria-label="Primary navigation">
      <ul className={`app-nav-items ${styles.items}`}>
        {navItems.map((item) => {
          const children = item.children?.filter((child) => !child.billingOnly || canViewBilling);
          const childActive = children?.some((child) => isItemActive(pathname, child)) ?? false;
          const active = isItemActive(pathname, item) || childActive;
          const expanded = overrides[item.href] ?? active;
          const panelId = `${id}-${item.label.toLowerCase()}-children`;

          return (
            <li key={item.href} className={styles.branch} onKeyDown={(event) => {
              if (event.key === "Escape" && children?.length && expanded) {
                event.preventDefault();
                event.stopPropagation();
                setExpanded(item.href, false);
                event.currentTarget.querySelector<HTMLButtonElement>("button")?.focus();
              }
            }}>
              <div className={styles.row}>
                <Link
                  href={item.href}
                  className={`app-nav-item ${styles.branchLink}${active ? " is-active" : ""}`}
                  data-active={active}
                  aria-current={active && !childActive ? "page" : undefined}
                >
                  <item.icon className="sidebar-icon" aria-hidden="true" />
                  <span className="app-nav-label">{item.label}</span>
                </Link>
                {!!children?.length && (
                  <button type="button" className={styles.toggle}
                    aria-label={`${expanded ? "Collapse" : "Expand"} ${item.label}`}
                    aria-expanded={expanded} aria-controls={panelId}
                    onClick={() => setExpanded(item.href, !expanded)}>
                    <ChevronDownIcon className={styles.chevron} aria-hidden="true" />
                  </button>
                )}
              </div>
              {!!children?.length && (
                <ul id={panelId} className={styles.children} aria-label={`${item.label} navigation`} hidden={!expanded}>
                  {children.map((child) => {
                    const current = isItemActive(pathname, child);
                    return (
                      <li key={child.href}>
                        <Link href={child.href}
                          className={`app-nav-item ${styles.branchLink}${current ? " is-active" : ""}`}
                          data-active={current} aria-current={current ? "page" : undefined}>
                          <span className="app-nav-label">{child.label}</span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}