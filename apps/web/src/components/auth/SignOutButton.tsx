"use client";

import { signOut } from "next-auth/react";

type Props = {
  className?: string;
  /** After signing out, log in again and come back to this exact page (resolved in the browser, never sent by the server). */
  returnHere?: boolean;
};

export default function SignOutButton({ className = "user-menu-link-button", returnHere = false }: Props) {
  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        const here = `${window.location.pathname}${window.location.search}`;
        signOut({ callbackUrl: returnHere ? `/auth/login?callbackUrl=${encodeURIComponent(here)}` : "/auth/login" });
      }}
    >
      Sign out
    </button>
  );
}
