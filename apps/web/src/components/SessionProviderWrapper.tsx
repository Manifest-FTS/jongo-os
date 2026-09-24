"use client";

import { SessionProvider } from "next-auth/react";

/**
 * Every other auth touchpoint in this app (signIn/signOut, server `auth()`)
 * works without React context. `useSession()` is the one hook that doesn't —
 * it throws if there's no <SessionProvider> ancestor, which crashed static
 * prerendering of /pricing the moment it started using it.
 */
export default function SessionProviderWrapper({ children }: { children: React.ReactNode }) {
  return <SessionProvider>{children}</SessionProvider>;
}
