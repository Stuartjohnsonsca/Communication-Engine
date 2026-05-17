import { createTransport } from "nodemailer";
import { reportError } from "@/lib/observability";
import { isGraphMailerConfigured, sendViaGraph } from "./graph-mailer";

/**
 * Notification mailer — sends transactional email to internal
 * recipients (User's work email or the FCT, never to a counterparty —
 * aligns with `feedback_drafts_only_post_send_check.md`).
 *
 * Transport precedence (item 111):
 *   1. Microsoft Graph if GRAPH_TENANT_ID + GRAPH_CLIENT_ID +
 *      GRAPH_CLIENT_SECRET + GRAPH_FROM are all set. Recommended for
 *      M365-shop tenants where Security Defaults / Conditional Access
 *      block SMTP AUTH.
 *   2. SMTP (nodemailer) if EMAIL_SERVER + EMAIL_FROM are set. The
 *      original transport — still works for non-M365 setups (Resend,
 *      Postmark, SendGrid, raw SMTP) and as a fallback during a
 *      Graph migration window.
 *   3. SKIPPED_NO_EMAIL_SERVER if neither is configured. Callers
 *      still write the NotificationDispatch + NotificationInbox rows
 *      so the in-app inbox is the fallback channel (local dev).
 *
 * Both transports return the same SendResult shape so callers don't
 * need to know which is in use. The decision is per-call (re-checks
 * env on each send) so a config change doesn't require a restart.
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

export function isSmtpMailerConfigured(): boolean {
  return !!process.env.EMAIL_SERVER && !!process.env.EMAIL_FROM;
}

/**
 * True if EITHER transport (Graph or SMTP) is configured. Callers
 * that need to know "will this email actually send?" check this.
 */
export function isMailerConfigured(): boolean {
  return isGraphMailerConfigured() || isSmtpMailerConfigured();
}

export async function sendNotificationEmail(input: SendInput): Promise<SendResult> {
  // Prefer Graph if configured — it's the recommended transport on
  // M365 tenants where SMTP AUTH is blocked.
  if (isGraphMailerConfigured()) {
    const html = input.html ?? renderDefaultHtml(input.subject, input.text);
    return sendViaGraph({ ...input, html });
  }
  if (!isSmtpMailerConfigured()) {
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
