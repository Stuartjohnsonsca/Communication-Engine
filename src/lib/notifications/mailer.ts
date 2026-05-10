import { createTransport } from "nodemailer";
import { reportError } from "@/lib/observability";

/**
 * Notification mailer — uses the same EMAIL_SERVER + EMAIL_FROM env vars as
 * NextAuth's sign-in code email so deploys that are already configured for
 * passwordless auth get notification emails for free. When the env isn't
 * set we return SKIPPED_NO_EMAIL_SERVER so callers can still write the
 * NotificationDispatch row + the NotificationInbox row — the in-app inbox
 * is the fallback channel when SMTP isn't configured (eg. local dev).
 *
 * Internal-only — these messages go to the User's own work email or the
 * FCT, never to a counterparty. Aligns with the no-send-to-counterparty
 * invariant (`feedback_drafts_only_post_send_check.md`).
 */

export type SendInput = {
  to: string;
  subject: string;
  text: string;
  html?: string;
};

export type SendResult =
  | { status: "DISPATCHED"; messageId?: string }
  | { status: "FAILED"; errorMessage: string }
  | { status: "SKIPPED_NO_EMAIL_SERVER" };

export function isMailerConfigured(): boolean {
  return !!process.env.EMAIL_SERVER && !!process.env.EMAIL_FROM;
}

export async function sendNotificationEmail(input: SendInput): Promise<SendResult> {
  if (!isMailerConfigured()) {
    return { status: "SKIPPED_NO_EMAIL_SERVER" };
  }
  try {
    const transport = createTransport(process.env.EMAIL_SERVER!);
    const info = await transport.sendMail({
      to: input.to,
      from: process.env.EMAIL_FROM!,
      subject: input.subject,
      text: input.text,
      html: input.html ?? renderDefaultHtml(input.subject, input.text),
    });
    return { status: "DISPATCHED", messageId: info?.messageId };
  } catch (err) {
    reportError(err, {
      route: "notifications.mailer",
      tags: { subject: input.subject },
    });
    return {
      status: "FAILED",
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Minimal-style HTML wrapper — same visual idiom as the sign-in email so
 * recipients recognise the sender. Inline styles only (mail clients).
 */
function renderDefaultHtml(subject: string, text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const paragraphs = escaped
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 12px">${p.replace(/\n/g, "<br>")}</p>`)
    .join("\n");
  return `<!doctype html><html><body style="font-family:system-ui,Segoe UI,Roboto,sans-serif;color:#111;background:#fafaf9;padding:32px">
    <h2 style="margin:0 0 16px;font-weight:600">${subject.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</h2>
    ${paragraphs}
    <p style="margin:24px 0 0;color:#888;font-size:12px">Acumon Communications. You're receiving this because you have an active membership.</p>
  </body></html>`;
}
