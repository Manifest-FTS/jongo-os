import NextAuth from "next-auth";
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

        // TODO: Call database to fetch user
        // const user = await db.user.findUnique({
        //   where: { email: credentials.email }
        // });

        // if (!user?.passwordHash) {
        //   return null;
        // }

        // const passwordValid = await compare(credentials.password, user.passwordHash);
        // if (!passwordValid) {
        //   return null;
        // }

        // return {
        //   id: user.id,
        //   email: user.email,
        //   name: user.fullName
        // };

        console.warn(
          "🚨 Authentication not yet wired to database. Add db integration in providers/auth.ts"
        );
        return null;
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
