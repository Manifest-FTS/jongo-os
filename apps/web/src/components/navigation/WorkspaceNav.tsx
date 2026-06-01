"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export type WorkspaceNavItem = {
  label: string;
  href: string;
  icon?: React.ReactNode;
};

type Props = {
  items: WorkspaceNavItem[];
};

export default function WorkspaceNav({ items }: Props) {
  const pathname = usePathname() ?? "";

  return (
    <nav className="workspace-nav">
      <div className="workspace-nav-inner">
        {items.map((item) => {
          const isActive =
            pathname === item.href ||
            (item.href !== "/" && pathname.startsWith(item.href));

          return (
            <Link
              key={item.href}
              href={item.href}
              className={`workspace-nav-item ${isActive ? "is-active" : ""}`}
            >
              {item.icon && <span className="workspace-nav-icon">{item.icon}</span>}
              <span>{item.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
