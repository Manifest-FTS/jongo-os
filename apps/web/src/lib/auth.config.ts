import NextAuth from "next-auth";
import { getServerSession } from "next-auth/next";
import CredentialsProvider from "next-auth/providers/credentials";
import { compare } from "bcryptjs";

function isUuid(value?: string | null): boolean {
  if (!value) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

declare module "next-auth" {
  interface User {
    id: string;
    email: string;
  }
  interface Session {
    user: {
      id: string;
      email: string;
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id: string;
    email: string;
  }
}

// This is the configuration used by NextAuth.js
export const authConfig = {
  pages: {
    signIn: "/auth/login",
    error: "/auth/error"
  },
  providers: [
    CredentialsProvider({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" }
      },
      async authorize(credentials: any) {
        if (!credentials?.email || !credentials?.password) {
          return null;
        }

        const normalizedEmail = normalizeEmail(String(credentials.email));

        const devAuthEmail = process.env.DEV_AUTH_EMAIL?.trim().toLowerCase();
        const devAuthPassword = process.env.DEV_AUTH_PASSWORD;
        const canUseDevCredentialFallback =
          process.env.NODE_ENV !== "production" && Boolean(devAuthEmail && devAuthPassword);

        if (
          canUseDevCredentialFallback &&
          normalizedEmail === devAuthEmail &&
          credentials.password === devAuthPassword
        ) {
          try {
            const { db } = await import("./db");
            const existingUser = await db.user.findUnique({
              where: { email: devAuthEmail },
              select: { id: true, email: true, fullName: true }
            });

            if (existingUser && isUuid(existingUser.id)) {
              return {
                id: existingUser.id,
                email: existingUser.email,
                name: existingUser.fullName ?? "Local Dev User"
              };
            }

            console.warn(
              "[auth] DEV_AUTH credentials matched but no UUID-backed DB user was found for DEV_AUTH_EMAIL."
            );
            return null;
          } catch (error) {
            console.warn("[auth] DEV_AUTH credential fallback failed to resolve DB user.", error);
            return null;
          }
        }

        // Credentials auth continues with normal DB password validation.
        try {
          const { db } = await import("./db");
          const user = await db.user.findFirst({
            where: {
              email: {
                equals: normalizedEmail,
                mode: "insensitive"
              },
              deletedAt: null
            },
            orderBy: {
              createdAt: "desc"
            }
          });

          if (!user?.passwordHash) {
            return null;
          }

          const passwordValid = await compare(credentials.password, user.passwordHash);

          if (!passwordValid) {
            return null;
          }

          return {
            id: user.id,
            email: normalizeEmail(user.email),
            name: user.fullName ?? undefined
          };
        } catch {
          console.warn("Authentication is waiting on a configured database.");
          return null;
        }
      }
    })
  ],
  callbacks: {
    async jwt({ token, user }: any) {
      if (user) {
        token.id = user.id;
        token.email = user.email;
      }
      return token;
    },
    async session({ session, token }: any) {
      if (session.user) {
        session.user.id = token.id as string;
        session.user.email = token.email as string;
      }
      return session;
    }
  },
  secret: process.env.NEXTAUTH_SECRET || "dev-secret-change-in-production"
};

export type AuthSession = {
  user: { id: string; email: string; name?: string | null };
} | null;

/**
 * Server-side session helper. Works in App Router Server Components,
 * Route Handlers, and middleware.
 *
 * Usage: const session = await auth();
 */
export async function auth(): Promise<AuthSession> {
  const raw = await getServerSession(authConfig as any);
  const session = raw as unknown as { user?: { id?: string; email?: string } } | null;
  if (session?.user?.id) {
    return session as unknown as AuthSession;
  }

  const isDev = process.env.NODE_ENV !== "production";
  const secret = process.env.NEXTAUTH_SECRET;
  const devAuthBypass = !secret || secret === "dev-secret-change-in-production";

  if (isDev && devAuthBypass) {
    try {
      const { db } = await import("./db");
      const preferredEmail = process.env.DEV_AUTH_EMAIL?.trim().toLowerCase();

      const devUser = preferredEmail
        ? await db.user.findFirst({
            where: { email: preferredEmail, deletedAt: null },
            select: { id: true, email: true, fullName: true }
          })
        : await db.user.findFirst({
            where: { deletedAt: null },
            orderBy: { createdAt: "asc" },
            select: { id: true, email: true, fullName: true }
          });

      if (devUser) {
        return {
          user: {
            id: devUser.id,
            email: devUser.email,
            name: devUser.fullName ?? null
          }
        };
      }
    } catch {
      return null;
    }
  }

  return null;
}
