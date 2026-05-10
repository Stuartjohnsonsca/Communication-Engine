import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import { getT, resolveLocale } from "@/lib/i18n";
import {
  verifyChallenge,
  consumeRecoveryCode,
  getEnrollmentStatus,
  resolveCurrentSessionId,
} from "@/lib/auth/totp";
import { rateLimit } from "@/lib/ratelimit";

/**
 * Post-sign-in 2FA challenge. The tenant layout redirects to this page
 * when the User has a verified UserTotp but the active NextAuth session
 * has no `totpVerifiedAt` stamp. Submitting a valid 6-digit code or a
 * recovery code stamps the session and redirects to `?next=` (default
 * back to the tenant dashboard).
 */

const PROTECTED_NEXT_PREFIXES = ["/", "/."];

function sanitiseNext(raw: string | undefined, tenantSlug: string): string {
  if (!raw) return `/${tenantSlug}/dashboard`;
  if (!raw.startsWith("/")) return `/${tenantSlug}/dashboard`;
  // Block protocol-relative redirects (`//evil.com`) and javascript: URIs.
  if (raw.startsWith("//") || raw.includes(":") || PROTECTED_NEXT_PREFIXES.some((p) => raw === p)) {
    return `/${tenantSlug}/dashboard`;
  }
  return raw;
}

export default async function TwoFactorChallengePage({
  params,
  searchParams,
}: {
  params: Promise<{ tenantSlug: string }>;
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { tenantSlug } = await params;
  const sp = await searchParams;
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");

  const totp = await getEnrollmentStatus(ctx.user.id);
  if (!totp.enrolled) redirect(`/${tenantSlug}/account`);

  const sessionId = await resolveCurrentSessionId();
  if (sessionId) {
    const session = await superDb.session.findUnique({
      where: { id: sessionId },
      select: { totpVerifiedAt: true },
    });
    if (session?.totpVerifiedAt) redirect(sanitiseNext(sp.next, tenantSlug));
  }

  const locale = resolveLocale({ membership: ctx.membership, tenant: ctx.tenant });
  const t = getT(locale);
  const safeNext = sanitiseNext(sp.next, tenantSlug);

  async function verifyAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) redirect("/login");
    const rawCode = ((formData.get("code") as string | null) ?? "").trim();
    const rawNext = (formData.get("next") as string | null) ?? "";
    const safe = sanitiseNext(rawNext, tenantSlug);

    const rl = await rateLimit({
      identity: { kind: "membership", value: inner.membership.id },
      scope: "totp-challenge",
      limit: 10,
      windowSeconds: 60,
      tenantId: inner.tenant.id,
      membershipId: inner.membership.id,
    });
    if (!rl.allowed) {
      redirect(`/${tenantSlug}/auth/2fa?error=rate-limited&next=${encodeURIComponent(safe)}`);
    }

    const sid = await resolveCurrentSessionId();
    if (!sid) redirect("/login");

    const cleaned = rawCode.replace(/\s+/g, "");
    let ok = false;
    if (/^\d{6}$/.test(cleaned)) {
      const r = await verifyChallenge({ userId: inner.user.id, sessionId: sid, code: cleaned });
      ok = r.ok;
    } else if (cleaned.length > 0) {
      const r = await consumeRecoveryCode({ userId: inner.user.id, sessionId: sid, code: cleaned });
      ok = r.ok;
    }

    if (!ok) {
      redirect(`/${tenantSlug}/auth/2fa?error=bad-code&next=${encodeURIComponent(safe)}`);
    }

    revalidatePath(`/${tenantSlug}`, "layout");
    redirect(safe);
  }

  return (
    <div className="mx-auto max-w-md space-y-6 py-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("twofa.challengeHeading")}</h1>
        <p className="mt-1 text-sm text-ink/70">{t("twofa.challengeDescription")}</p>
      </div>

      {sp.error === "bad-code" && (
        <div className="rounded border border-red-300 bg-red-50/60 px-3 py-2 text-sm text-red-900">
          {t("twofa.badCodeError")}
        </div>
      )}
      {sp.error === "rate-limited" && (
        <div className="rounded border border-amber-300 bg-amber-50/60 px-3 py-2 text-sm text-amber-900">
          {t("twofa.rateLimitedError")}
        </div>
      )}

      <form action={verifyAction} className="card space-y-3">
        <input type="hidden" name="next" value={safeNext} />
        <div>
          <label className="label" htmlFor="totp-code">
            {t("twofa.enterCodeLabel")}
          </label>
          <input
            id="totp-code"
            name="code"
            className="input"
            inputMode="text"
            autoComplete="one-time-code"
            autoFocus
            required
            maxLength={20}
            pattern=".{6,}"
            aria-describedby="totp-help"
          />
          <p id="totp-help" className="mt-1 text-xs text-ink/60">
            {t("twofa.challengeHelp")}
          </p>
        </div>
        <div className="flex items-center justify-between gap-3 text-xs text-ink/50">
          <span>{ctx.user.email}</span>
          <button type="submit" className="btn btn-primary text-sm">
            {t("twofa.continueButton")}
          </button>
        </div>
      </form>
    </div>
  );
}
