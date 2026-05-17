"use client";

import { signOut } from "next-auth/react";

export default function SignOutButton() {
  return (
    <button
      type="button"
      className="user-menu-link-button"
      onClick={() => signOut({ callbackUrl: "/auth/login" })}
    >
      Sign out
    </button>
  );
}
