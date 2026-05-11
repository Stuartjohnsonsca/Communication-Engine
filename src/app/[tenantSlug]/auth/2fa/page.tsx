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
  recordStepUpVerified,
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
  searchParams: Promise<{ next?: string; error?: string; stepUp?: string; op?: string }>;
}) {
  const { tenantSlug } = await params;
  const sp = await searchParams;
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");

  const totp = await getEnrollmentStatus(ctx.user.id);
  if (!totp.enrolled) redirect(`/${tenantSlug}/account`);

  // Post-PRD hardening item 18 — step-up mode. When `?stepUp=1` is set
  // we ALWAYS re-prompt, even if `Session.totpVerifiedAt` is already
  // stamped. This is the freshness-window challenge for sensitive
  // operations (IP allowlist edits, API key creation, etc.). Regular
  // post-sign-in challenges still short-circuit when already verified.
  const isStepUp = sp.stepUp === "1";
  const opKey = sp.op?.trim() || "";
  const sessionId = await resolveCurrentSessionId();
  if (sessionId && !isStepUp) {
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
    const innerStepUp = (formData.get("stepUp") as string | null) === "1";
    const innerOpKey = ((formData.get("op") as string | null) ?? "").trim();
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
      const qs = innerStepUp
        ? `?stepUp=1&op=${encodeURIComponent(innerOpKey)}&error=rate-limited&next=${encodeURIComponent(safe)}`
        : `?error=rate-limited&next=${encodeURIComponent(safe)}`;
      redirect(`/${tenantSlug}/auth/2fa${qs}`);
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
      const qs = innerStepUp
        ? `?stepUp=1&op=${encodeURIComponent(innerOpKey)}&error=bad-code&next=${encodeURIComponent(safe)}`
        : `?error=bad-code&next=${encodeURIComponent(safe)}`;
      redirect(`/${tenantSlug}/auth/2fa${qs}`);
    }

    // Successful step-up — write a STEP_UP_VERIFIED audit row so an
    // audit reviewer can scan for sensitive-operation step-ups
    // specifically (distinct from a regular post-sign-in
    // TOTP_VERIFIED). Best-effort; failure here MUST NOT prevent the
    // User from proceeding to their gated operation.
    if (innerStepUp) {
      try {
        await recordStepUpVerified({
          tenantId: inner.tenant.id,
          actorMembershipId: inner.membership.id,
          opKey: innerOpKey || "unspecified",
        });
      } catch {
        // intentionally swallowed — see comment above.
      }
    }

    revalidatePath(`/${tenantSlug}`, "layout");
    redirect(safe);
  }

  return (
    <div className="mx-auto max-w-md space-y-6 py-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {isStepUp ? t("twofa.stepUpHeading") : t("twofa.challengeHeading")}
        </h1>
        <p className="mt-1 text-sm text-ink/70">
          {isStepUp ? t("twofa.stepUpDescription") : t("twofa.challengeDescription")}
        </p>
        {isStepUp && opKey && (
          <p className="mt-1 text-xs text-ink/50">
            <code className="rounded bg-ink/5 px-1 py-0.5 font-mono">{opKey}</code>
          </p>
        )}
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
        {isStepUp && <input type="hidden" name="stepUp" value="1" />}
        {isStepUp && opKey && <input type="hidden" name="op" value={opKey} />}
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
