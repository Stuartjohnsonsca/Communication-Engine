import NextAuth, { type NextAuthConfig } from "next-auth";
import { PrismaAdapter } from "@auth/prisma-adapter";
import EmailProvider from "next-auth/providers/nodemailer";
import { prisma } from "@/lib/db";

const useEmailProvider = !!process.env.EMAIL_SERVER && !!process.env.EMAIL_FROM;

export const authConfig: NextAuthConfig = {
  adapter: PrismaAdapter(prisma),
  session: { strategy: "database" },
  pages: { signIn: "/login" },
  providers: useEmailProvider
    ? [
        EmailProvider({
          server: process.env.EMAIL_SERVER!,
          from: process.env.EMAIL_FROM!,
        }),
      ]
    : [],
  trustHost: true,
  callbacks: {
    async session({ session, user }) {
      if (session.user) {
        (session.user as { id: string }).id = user.id;
      }
      return session;
    },
  },
};

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);
