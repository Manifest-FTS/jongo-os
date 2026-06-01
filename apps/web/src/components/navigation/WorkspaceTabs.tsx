"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export type WorkspaceTab = {
  name: string;
  href: string;
  match?: "exact" | "prefix";
};

function tabIsActive(pathname: string, tab: WorkspaceTab) {
  const mode = tab.match ?? "prefix";

  if (mode === "exact") {
    return pathname === tab.href;
  }

  return pathname === tab.href || pathname.startsWith(`${tab.href}/`);
}

export default function WorkspaceTabs({ tabs }: { tabs: WorkspaceTab[] }) {
  const pathname = usePathname() ?? "";

  return (
    <div className="tab-rail" role="tablist" aria-label="Workspace sections">
      {tabs.map((tab) => {
        const active = tabIsActive(pathname, tab);

        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={`tab-link${active ? " is-active" : ""}`}
            aria-current={active ? "page" : undefined}
          >
            {tab.name}
          </Link>
        );
      })}
    </div>
  );
}