import NextAuth from "next-auth";
import { getServerSession } from "next-auth/next";
import CredentialsProvider from "next-auth/providers/credentials";
import { compare } from "bcryptjs";

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

        try {
          const { db } = await import("./db");
          const user = await db.user.findUnique({
            where: { email: credentials.email }
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
            email: user.email,
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
