"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import { btnPrimary, cx } from "@/lib/public-ui";

const LINKS = [
  { href: "/domains", label: "Domains" },
  { href: "/pricing", label: "Pricing" },
  { href: "/contact", label: "Contact" }
];

/**
 * The header on every public page (home, domains, transfer, pricing, contact).
 *
 * Sign-in state is read in the browser, so the pages around it can stay
 * static. While it is still loading, the account buttons are left out rather
 * than showing "Sign in" to someone who is signed in.
 */
export default function PublicSiteHeader() {
  const pathname = usePathname() ?? "/";
  const { status } = useSession();

  return (
    <header className="hosting-nav">
      <Link href="/" className="hosting-brand" aria-label="Jongo home">
        <img src="/assets/images/jongo-logomark-color.png" alt="" width={30} height={30} />
        <span>Jongo</span>
      </Link>
      <nav className="hosting-nav__actions" aria-label="Main">
        {LINKS.map((link) => {
          const active = pathname === link.href || pathname.startsWith(`${link.href}/`);
          return (
            <Link
              key={link.href}
              href={link.href}
              className={cx("hosting-nav__signin", active && "text-[#2f5d3a] underline underline-offset-[6px]")}
              aria-current={active ? "page" : undefined}
            >
              {link.label}
            </Link>
          );
        })}
        {status === "authenticated" ? (
          <Link href="/dashboard" className={cx(btnPrimary, "px-4 py-[9.5px] text-[14.5px]")}>
            Dashboard
          </Link>
        ) : status === "unauthenticated" ? (
          <>
            {/* Not .hosting-nav__signin: that class is hidden on phones, which
                left signed-out mobile visitors no way to sign in. */}
            <Link href="/auth/login" className="text-[14.5px] font-semibold px-3 py-[9px] no-underline text-inherit whitespace-nowrap">
              Sign in
            </Link>
            <Link href="/auth/register" className={cx(btnPrimary, "px-4 py-[9.5px] text-[14.5px]")}>
              Get started
            </Link>
          </>
        ) : (
          // Holds the button's width so the header does not jump once the session loads.
          <span className="inline-block w-[112px] h-[38px]" aria-hidden />
        )}
      </nav>
    </header>
  );
}
