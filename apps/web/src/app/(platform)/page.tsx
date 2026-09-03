import { redirect } from "next/navigation";
import { auth } from "@/lib/auth.config";

/**
 * The root URL.
 *
 * Signed in, this is the app, so it goes to the dashboard as it always has.
 * Signed out, it is the front door: it goes to the public hosting page rather
 * than a login form, which is what an anonymous visitor arriving at the domain
 * should actually be shown.
 *
 * Middleware lets "/" through unauthenticated so this can make that decision —
 * it cannot be added to PUBLIC_PATHS, which is prefix-matched.
 */
export default async function HomePage() {
  const session = await auth();

  if (session?.user?.id) {
    redirect("/dashboard");
  }

  redirect("/hosting");
}
