import { randomInt } from "node:crypto";
import NextAuth, { type NextAuthConfig } from "next-auth";
import { PrismaAdapter } from "@auth/prisma-adapter";
import EmailProvider from "next-auth/providers/nodemailer";
import { createTransport } from "nodemailer";
import { prisma } from "@/lib/db";

const useEmailProvider = !!process.env.EMAIL_SERVER && !!process.env.EMAIL_FROM;

/**
 * Custom send: short numeric OTP, NO clickable URL in the email body.
 * Robust against Microsoft Defender Safe Links and similar mail-scanner
 * single-fetch consumption of magic-link tokens.
 */
async function sendCodeEmail(opts: { identifier: string; token: string; from: string; server: string }) {
  const transport = createTransport(opts.server);
  await transport.sendMail({
    to: opts.identifier,
    from: opts.from,
    subject: `Acumon Communications sign-in code: ${opts.token}`,
    text:
      `Your Acumon Communications sign-in code is: ${opts.token}\n\n` +
      `Enter this code on the sign-in page. It expires in 10 minutes.\n\n` +
      `If you didn't request this, ignore this email.\n`,
    html: `<!doctype html><html><body style="font-family:system-ui,Segoe UI,Roboto,sans-serif;color:#111;background:#fafaf9;padding:32px">
      <h2 style="margin:0 0 16px;font-weight:600">Your sign-in code</h2>
      <p style="margin:0 0 12px">Enter this code on the Acumon Communications sign-in page:</p>
      <p style="font-size:36px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:0.25em;background:#fff;border:1px solid #e5e5e5;border-radius:8px;padding:16px 24px;display:inline-block;margin:8px 0">${opts.token}</p>
      <p style="margin:12px 0 0;color:#555">Expires in 10 minutes.</p>
      <p style="margin:24px 0 0;color:#888;font-size:12px">If you didn't request this, you can ignore this email.</p>
    </body></html>`,
  });
}

export const authConfig: NextAuthConfig = {
  adapter: PrismaAdapter(prisma),
  session: { strategy: "database" },
  pages: { signIn: "/login", verifyRequest: "/login/verify" },
  providers: useEmailProvider
    ? [
        EmailProvider({
          server: process.env.EMAIL_SERVER!,
          from: process.env.EMAIL_FROM!,
          maxAge: 10 * 60, // 10 minutes
          generateVerificationToken: () => String(randomInt(100_000, 1_000_000)),
          sendVerificationRequest: async ({ identifier, token, provider }) => {
            await sendCodeEmail({
              identifier,
              token,
              from: provider.from as string,
              server: provider.server as string,
            });
          },
        }),
      ]
    : [],
  trustHost: true,
  callbacks: {
    async session({ session, user }) {
      if (session.user) (session.user as { id: string }).id = user.id;
      return session;
    },
  },
};

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);
