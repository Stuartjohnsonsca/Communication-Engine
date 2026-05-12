import { redirect } from "next/navigation";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import {
  computeMemberFcgAdherence,
  type MemberFcgAdherence,
} from "@/lib/drafts";
import { revokeAccess, reauthoriseAccess, getMemberLifecycleState } from "@/lib/lifecycle";
import {
  SUPPORTED_LOCALES,
  LOCALE_LABELS,
  isSupportedLocale,
  getT,
  resolveLocale,
  type TFunction,
  type DictionaryPath,
} from "@/lib/i18n";
import { hasPermission } from "@/lib/rbac";
import {
  getEnrollmentStatus,
  initiateEnrollment,
  verifyEnrollment,
  verifyChallenge,
  consumeRecoveryCode,
  regenerateRecoveryCodes,
  disable as disableTotp,
  resolveCurrentSessionId,
} from "@/lib/auth/totp";
import {
  listSessionsForUser,
  revokeSession,
  revokeAllSessionsForUser,
  maskIp,
} from "@/lib/auth/sessions";
import { rateLimit } from "@/lib/ratelimit";
import {
  OPT_OUTABLE_KINDS,
  listPreferences,
  setEmailEnabled,
  type OptOutableKind,
} from "@/lib/notifications";
import { TwoFactorCard } from "./TwoFactorCard";

export default async function AccountPage({
  params,
}: {
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");

  const currentSessionId = await resolveCurrentSessionId();
  const [member, channelAuths, totpStatus, sessions, notificationPrefs, adherence] = await Promise.all([
    superDb.membership.findUnique({
      where: { id: ctx.membership.id },
    }),
    superDb.channelAuth.findMany({
      where: { tenantId: ctx.tenant.id, membershipId: ctx.membership.id },
      include: { channel: { select: { kind: true } } },
      orderBy: { createdAt: "desc" },
    }),
    getEnrollmentStatus(ctx.user.id),
    listSessionsForUser({ userId: ctx.user.id, currentSessionId, includeRevoked: false }),
    listPreferences(ctx.membership.id),
    computeMemberFcgAdherence({
      tenantId: ctx.tenant.id,
      membershipId: ctx.membership.id,
      windowDays: 30,
    }),
  ]);
  if (!member) redirect("/login");

  // Post-PRD hardening item 21 — surface which sessions were flagged as
  // new-device by the anomaly detector. Audit events land on the User's
  // primary tenant chain; we don't care which tenant chain emitted them
  // here — the User owns the session globally.
  const newDeviceSessionIds = new Set<string>(
    sessions.length === 0
      ? []
      : (
          await superDb.auditEvent.findMany({
            where: {
              eventType: "SIGN_IN_NEW_DEVICE",
              subjectType: "Session",
              subjectId: { in: sessions.map((s) => s.id) },
            },
            select: { subjectId: true },
          })
        ).map((e) => e.subjectId),
  );

  const state = getMemberLifecycleState(member);

  async function revokeAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    const note = (formData.get("note") as string | null)?.trim() || null;
    await revokeAccess({
      tenantId: inner.tenant.id,
      membershipId: inner.membership.id,
      actorMembershipId: inner.membership.id,
      note,
    });
    revalidatePath(`/${tenantSlug}/account`);
    revalidatePath(`/${tenantSlug}/admin/lifecycle`);
  }

  async function reauthAction() {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    await reauthoriseAccess({
      tenantId: inner.tenant.id,
      membershipId: inner.membership.id,
      actorMembershipId: inner.membership.id,
    });
    revalidatePath(`/${tenantSlug}/account`);
    revalidatePath(`/${tenantSlug}/admin/lifecycle`);
  }

  const liveAuths = channelAuths.filter((a) => !a.revokedAt);
  const revokedAuths = channelAuths.filter((a) => a.revokedAt);

  const effectiveLocale = resolveLocale({ membership: member, tenant: ctx.tenant });
  const t = getT(effectiveLocale);
  const canManageTenantDefault = hasPermission(ctx.membership.role, "tenant:configure-locale");

  async function setMyLocaleAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    const raw = (formData.get("locale") as string | null) ?? "";
    const next: string | null = raw === "" ? null : raw;
    if (next !== null && !isSupportedLocale(next)) throw new Error("unsupported locale");
    await superDb.membership.update({
      where: { id: inner.membership.id },
      data: { locale: next },
    });
    revalidatePath(`/${tenantSlug}/account`);
    revalidatePath(`/${tenantSlug}`, "layout");
  }

  async function initiateTotpAction() {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (!hasPermission(inner.membership.role, "auth:configure-totp")) {
      throw new Error("forbidden");
    }
    return initiateEnrollment({ userId: inner.user.id, accountEmail: inner.user.email });
  }

  async function confirmTotpAction(code: string) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (!hasPermission(inner.membership.role, "auth:configure-totp")) {
      throw new Error("forbidden");
    }
    const rl = await rateLimit({
      identity: { kind: "membership", value: inner.membership.id },
      scope: "totp-enroll",
      limit: 10,
      windowSeconds: 60,
      tenantId: inner.tenant.id,
      membershipId: inner.membership.id,
    });
    if (!rl.allowed) return { ok: false, reason: "rate-limited" as const };
    const cleaned = code.replace(/\s+/g, "").slice(0, 6);
    const res = await verifyEnrollment({ userId: inner.user.id, code: cleaned });
    if (res.ok) {
      const sessionId = await resolveCurrentSessionId();
      if (sessionId) {
        await superDb.session.update({
          where: { id: sessionId },
          data: { totpVerifiedAt: new Date() },
        });
      }
      revalidatePath(`/${tenantSlug}/account`);
      revalidatePath(`/${tenantSlug}`, "layout");
      return { ok: true as const };
    }
    return { ok: false as const, reason: res.reason };
  }

  async function regenerateRecoveryAction(code: string) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (!hasPermission(inner.membership.role, "auth:configure-totp")) {
      throw new Error("forbidden");
    }
    const rl = await rateLimit({
      identity: { kind: "membership", value: inner.membership.id },
      scope: "totp-regen-recovery",
      limit: 6,
      windowSeconds: 60,
      tenantId: inner.tenant.id,
      membershipId: inner.membership.id,
    });
    if (!rl.allowed) return { ok: false as const, reason: "rate-limited" as const };
    const sessionId = await resolveCurrentSessionId();
    if (!sessionId) return { ok: false as const, reason: "no-session" as const };
    const cleaned = code.replace(/\s+/g, "").slice(0, 6);
    const res = await regenerateRecoveryCodes({
      userId: inner.user.id,
      sessionId,
      code: cleaned,
    });
    if (!res.ok) return { ok: false as const, reason: res.reason };
    revalidatePath(`/${tenantSlug}/account`);
    return { ok: true as const, recoveryCodes: res.recoveryCodes };
  }

  async function disableTotpAction(code: string) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (!hasPermission(inner.membership.role, "auth:configure-totp")) {
      throw new Error("forbidden");
    }
    const rl = await rateLimit({
      identity: { kind: "membership", value: inner.membership.id },
      scope: "totp-disable",
      limit: 10,
      windowSeconds: 60,
      tenantId: inner.tenant.id,
      membershipId: inner.membership.id,
    });
    if (!rl.allowed) return { ok: false as const, reason: "rate-limited" as const };
    const sessionId = await resolveCurrentSessionId();
    if (!sessionId) return { ok: false as const, reason: "no-session" as const };
    // Require a current TOTP code OR a recovery code before disabling.
    // Prevents an attacker with cookie-only access from turning 2FA off.
    const cleaned = code.replace(/\s+/g, "");
    let verified = false;
    if (/^\d{6}$/.test(cleaned)) {
      const r = await verifyChallenge({ userId: inner.user.id, sessionId, code: cleaned });
      verified = r.ok;
    } else {
      const r = await consumeRecoveryCode({ userId: inner.user.id, sessionId, code: cleaned });
      verified = r.ok;
    }
    if (!verified) return { ok: false as const, reason: "bad-code" as const };
    await disableTotp({ userId: inner.user.id, actorTenantId: inner.tenant.id });
    revalidatePath(`/${tenantSlug}/account`);
    revalidatePath(`/${tenantSlug}`, "layout");
    return { ok: true as const };
  }

  async function revokeOwnSessionAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (!hasPermission(inner.membership.role, "auth:revoke-own-sessions")) {
      throw new Error("forbidden");
    }
    const sessionId = (formData.get("sessionId") as string | null)?.trim();
    if (!sessionId) throw new Error("missing sessionId");
    // Refuse to revoke a session that doesn't belong to the actor — the
    // shared revoke path enforces it too, but a tight ownership check here
    // is cheaper than a row read inside revokeSession.
    const owner = await superDb.session.findUnique({
      where: { id: sessionId },
      select: { userId: true },
    });
    if (!owner || owner.userId !== inner.user.id) throw new Error("forbidden");
    await revokeSession({
      sessionId,
      reason: "user-self",
      ctx: {
        tenantId: inner.tenant.id,
        actorMembershipId: inner.membership.id,
        actorUserId: inner.user.id,
      },
    });
    revalidatePath(`/${tenantSlug}/account`);
  }

  async function revokeAllOtherSessionsAction() {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (!hasPermission(inner.membership.role, "auth:revoke-own-sessions")) {
      throw new Error("forbidden");
    }
    const keepSessionId = await resolveCurrentSessionId();
    await revokeAllSessionsForUser({
      targetUserId: inner.user.id,
      reason: "user-self",
      ctx: {
        tenantId: inner.tenant.id,
        actorMembershipId: inner.membership.id,
        actorUserId: inner.user.id,
      },
      excludeSessionId: keepSessionId,
    });
    revalidatePath(`/${tenantSlug}/account`);
  }

  async function setNotificationPrefAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    const kind = String(formData.get("kind") ?? "");
    const emailEnabled = formData.get("emailEnabled") === "on";
    // ValidationError surfaces "kind is mandatory" if the form was
    // tampered with — defence in depth on top of the UI showing only
    // opt-outable kinds.
    await setEmailEnabled({
      tenantId: inner.tenant.id,
      membershipId: inner.membership.id,
      actorMembershipId: inner.membership.id,
      kind,
      emailEnabled,
    });
    revalidatePath(`/${tenantSlug}/account`);
  }

  async function setTenantDefaultLocaleAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (!hasPermission(inner.membership.role, "tenant:configure-locale")) {
      throw new Error("forbidden");
    }
    const raw = (formData.get("defaultLocale") as string | null) ?? "";
    if (!isSupportedLocale(raw)) throw new Error("unsupported locale");
    await superDb.tenant.update({
      where: { id: inner.tenant.id },
      data: { defaultLocale: raw },
    });
    revalidatePath(`/${tenantSlug}/account`);
    revalidatePath(`/${tenantSlug}`, "layout");
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">My account</h1>
        <p className="mt-1 text-sm text-ink/70">
          PRD §14.3 — you can revoke source-system access at any time. While revoked,
          drafting halts for you and your User Culture Guide is frozen. Re-authorise within
          30 days to resume; otherwise the UCG is anonymised and your membership is
          suspended.
        </p>
      </div>

      <LifecycleBanner state={state} />

      <div className="card space-y-3">
        <h2 className="text-base font-medium">Identity</h2>
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs uppercase tracking-wider text-ink/50">Email</dt>
            <dd>{ctx.user.email}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wider text-ink/50">Role</dt>
            <dd>
              <span className="tag">{member.role}</span>
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wider text-ink/50">Joined</dt>
            <dd>{member.joinedAt.toISOString().slice(0, 10)}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wider text-ink/50">Membership status</dt>
            <dd>{member.status}</dd>
          </div>
        </dl>
      </div>

      <MyAdherenceCard tenantSlug={tenantSlug} adherence={adherence} />

      <form action={setMyLocaleAction} className="card space-y-3">
        <h2 className="text-base font-medium">{t("account.localeHeading")}</h2>
        <p className="text-sm text-ink/70">{t("account.localeDescription")}</p>
        <div>
          <label className="label" htmlFor="locale">
            {t("account.localeHeading")}
          </label>
          <select
            id="locale"
            name="locale"
            defaultValue={member.locale ?? ""}
            className="input"
          >
            <option value="">
              {t("account.inheritFromTenant", { locale: ctx.tenant.defaultLocale })}
            </option>
            {SUPPORTED_LOCALES.map((code) => (
              <option key={code} value={code}>
                {LOCALE_LABELS[code].nativeName} ({code})
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center justify-between gap-3 text-xs text-ink/50">
          <span>
            Effective: <span className="font-medium text-ink/80">{effectiveLocale}</span>
          </span>
          <button type="submit" className="btn text-xs">
            {t("account.save")}
          </button>
        </div>
      </form>

      {canManageTenantDefault && (
        <form action={setTenantDefaultLocaleAction} className="card space-y-3">
          <h2 className="text-base font-medium">Tenant default interface language</h2>
          <p className="text-sm text-ink/70">
            Sets the locale that Memberships in this tenant inherit when they have not
            chosen one of their own. Visible to Firm Administrators only.
          </p>
          <div>
            <label className="label" htmlFor="defaultLocale">
              Tenant default
            </label>
            <select
              id="defaultLocale"
              name="defaultLocale"
              defaultValue={ctx.tenant.defaultLocale}
              className="input"
            >
              {SUPPORTED_LOCALES.map((code) => (
                <option key={code} value={code}>
                  {LOCALE_LABELS[code].nativeName} ({code})
                </option>
              ))}
            </select>
          </div>
          <div className="flex justify-end">
            <button type="submit" className="btn text-xs">
              {t("account.save")}
            </button>
          </div>
        </form>
      )}

      <TwoFactorCard
        status={totpStatus}
        tenantRequireTotp={ctx.tenant.requireTotp}
        actions={{
          initiate: initiateTotpAction,
          confirm: confirmTotpAction,
          disable: disableTotpAction,
          regenerateRecovery: regenerateRecoveryAction,
        }}
        copy={{
          heading: t("twofa.accountHeading"),
          enrolledDescription: t("twofa.enrolledDescription"),
          notEnrolledDescription: t("twofa.notEnrolledDescription"),
          enforcedNote: t("twofa.enforcedNote"),
          enrolledOn: t("twofa.enrolledOn"),
          lastUsed: t("twofa.lastUsed"),
          recoveryRemaining: t("twofa.recoveryRemaining"),
          enableButton: t("twofa.enableButton"),
          disableButton: t("twofa.disableButton"),
          cancel: t("twofa.cancel"),
          secretLabel: t("twofa.secretLabel"),
          otpauthLabel: t("twofa.otpauthLabel"),
          enterCodeLabel: t("twofa.enterCodeLabel"),
          submitCode: t("twofa.submitCode"),
          recoveryHeading: t("twofa.recoveryHeading"),
          recoveryWarning: t("twofa.recoveryWarning"),
          enrollFailed: t("twofa.enrollFailed"),
          disableConfirm: t("twofa.disableConfirm"),
          disableFailed: t("twofa.disableFailed"),
          never: t("twofa.never"),
          regenerateButton: t("twofa.regenerateButton"),
          regenerateDescription: t("twofa.regenerateDescription"),
          regenerateHeading: t("twofa.regenerateHeading"),
          regenerateSuccess: t("twofa.regenerateSuccess"),
          regenerateFailed: t("twofa.regenerateFailed"),
        }}
      />

      <div className="card space-y-3">
        <h2 className="text-base font-medium">{t("sessions.heading")}</h2>
        <p className="text-sm text-ink/70">{t("sessions.description")}</p>
        {sessions.length === 0 ? (
          <p className="text-sm text-ink/60">{t("sessions.none")}</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {sessions.map((s) => (
              <li
                key={s.id}
                className="flex flex-col gap-2 border-t border-ink/5 pt-2 first:border-0 first:pt-0 sm:flex-row sm:items-start sm:justify-between"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium">{s.device.label}</span>
                    {s.isCurrent && (
                      <span className="tag bg-emerald-50 text-emerald-800">
                        {t("sessions.thisDevice")}
                      </span>
                    )}
                    {s.totpVerifiedAt && (
                      <span className="tag bg-sky-50 text-sky-800">
                        {t("sessions.twofaVerified")}
                      </span>
                    )}
                    {newDeviceSessionIds.has(s.id) && (
                      <span
                        className="tag bg-amber-50 text-amber-800"
                        title={t("sessions.newDeviceDescription")}
                      >
                        {t("sessions.newDevice")}
                      </span>
                    )}
                  </div>
                  <div className="mt-1 text-xs text-ink/60">
                    {t("sessions.signedIn")} {s.createdAt.toISOString().slice(0, 16).replace("T", " ")}
                    {" · "}
                    {t("sessions.lastSeen")} {s.lastSeenAt.toISOString().slice(0, 16).replace("T", " ")}
                    {" · "}
                    IP {maskIp(s.ipAddress)}
                  </div>
                </div>
                {!s.isCurrent && (
                  <form action={revokeOwnSessionAction}>
                    <input type="hidden" name="sessionId" value={s.id} />
                    <button type="submit" className="btn text-xs">
                      {t("sessions.revoke")}
                    </button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
        {sessions.filter((s) => !s.isCurrent).length > 0 && (
          <form action={revokeAllOtherSessionsAction} className="flex justify-end pt-1">
            <button type="submit" className="btn text-xs">
              {t("sessions.revokeOthers")}
            </button>
          </form>
        )}
      </div>

      <NotificationPreferencesCard
        prefs={notificationPrefs}
        action={setNotificationPrefAction}
        t={t}
      />

      <div className="card space-y-3">
        <h2 className="text-base font-medium">Channel authorisations</h2>
        {liveAuths.length === 0 && revokedAuths.length === 0 ? (
          <p className="text-sm text-ink/60">No channels authorised yet.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {liveAuths.map((a) => (
              <li key={a.id} className="flex items-baseline justify-between border-t border-ink/5 pt-1 first:border-0 first:pt-0">
                <span>
                  <span className="tag mr-2">{a.channel.kind}</span>
                  {a.scope ?? "default scope"}
                </span>
                <span className="text-xs text-ink/50">
                  authorised {a.createdAt.toISOString().slice(0, 10)}
                </span>
              </li>
            ))}
            {revokedAuths.map((a) => (
              <li key={a.id} className="flex items-baseline justify-between border-t border-ink/5 pt-1 text-ink/50">
                <span>
                  <span className="tag mr-2 bg-ink/5">{a.channel.kind}</span>
                  revoked
                </span>
                <span className="text-xs">
                  {a.revokedAt!.toISOString().slice(0, 10)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {state.kind === "active" && (
        <form action={revokeAction} className="card space-y-3 border-amber-200 bg-amber-50/30">
          <h2 className="text-base font-medium">Revoke access</h2>
          <p className="text-sm text-ink/70">
            This pulls the platform&apos;s access to your communication channels and halts
            drafting for you immediately. Your UCG is preserved (frozen) for 30 days. The
            Firm Culture Team is notified via the lifecycle console and audit log.
          </p>
          <div>
            <label className="label">Optional note for FCT (visible in lifecycle console)</label>
            <textarea name="note" rows={2} className="input" maxLength={500} />
          </div>
          <button
            type="submit"
            className="btn btn-primary text-sm"
            // Server actions don't support browser confirm; the FCT-visible
            // audit + 30-day reversibility is the recovery path. Wording is
            // chosen to make the destructive nature explicit.
          >
            Revoke source-system access
          </button>
        </form>
      )}

      {(state.kind === "revoked_grace" || state.kind === "revoked_expired") && (
        <form action={reauthAction} className="card space-y-3 border-emerald-200 bg-emerald-50/30">
          <h2 className="text-base font-medium">Re-authorise access</h2>
          <p className="text-sm text-ink/70">
            {state.kind === "revoked_grace"
              ? `${state.daysLeft} day${state.daysLeft === 1 ? "" : "s"} remain in your re-authorisation window.`
              : "Your re-authorisation window has expired. The lifecycle sweep will suspend the membership at next run."}
            {" "}Re-authorising restores your UCG and resumes drafting.
          </p>
          <button type="submit" className="btn btn-primary text-sm" disabled={state.kind === "revoked_expired"}>
            Re-authorise
          </button>
        </form>
      )}

      {state.kind === "leaver_grace" && (
        <div className="card space-y-2 border-red-200 bg-red-50/30">
          <h2 className="text-base font-medium">Marked as leaver</h2>
          <p className="text-sm text-ink/70">
            Your Firm Administrator has marked you as a leaver. Drafting is halted. Your
            User Culture Guide is preserved until {state.deadline.toISOString().slice(0, 10)}
            ({state.daysLeft} day{state.daysLeft === 1 ? "" : "s"} from now), after which it
            will be anonymised. Reversal is a Firm Administrator action.
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * Post-PRD hardening item 69 — first-person FCG-window adherence card.
 *
 * Mirrors the firm-admin top-drafters row (item 67) for the Member's
 * own data. Same exclusions: bypassed-synth and no-deadline drafts
 * don't count. Renders "no deadlined sends yet" when there's nothing
 * to score, NOT "0%" — the rate is null in that case and a 0% display
 * would falsely accuse a Member who hasn't had a deadlined message
 * arrive yet.
 */
function MyAdherenceCard({
  tenantSlug,
  adherence,
}: {
  tenantSlug: string;
  adherence: MemberFcgAdherence;
}) {
  const hasData = adherence.sentWithDeadline > 0 || adherence.openOverdue > 0;
  const ratePct =
    adherence.withinWindowRate === null
      ? null
      : Math.round(adherence.withinWindowRate * 100);
  return (
    <div className="card space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-base font-medium">My FCG-window adherence</h2>
        <span className="text-xs text-ink/50">last {adherence.windowDays} days</span>
      </div>
      <p className="text-sm text-ink/70">
        Of the drafts the engine produced for you with an FCG response deadline,
        how many you sent on or before the deadline. Bypassed-synth drafts and
        drafts without a deadline aren&apos;t counted — see your full inbox on{" "}
        <Link className="underline decoration-dotted" href={`/${tenantSlug}/drafts`}>
          /drafts
        </Link>
        .
      </p>
      {!hasData ? (
        <p className="text-sm text-ink/60">
          No deadlined drafts yet. Connect a channel to start receiving engine-
          produced drafts with FCG response windows.
        </p>
      ) : (
        <dl className="grid gap-3 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs uppercase tracking-wider text-ink/50">Within window</dt>
            <dd className="font-medium">
              {ratePct === null ? "—" : `${ratePct}%`}
              {adherence.sentWithDeadline > 0 && (
                <span className="ml-1 text-[11px] font-normal text-ink/50">
                  ({adherence.sentWithinWindow}/{adherence.sentWithDeadline})
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wider text-ink/50">Sent after window</dt>
            <dd className={adherence.sentAfterWindow > 0 ? "font-medium text-amber-800" : "font-medium"}>
              {adherence.sentAfterWindow}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wider text-ink/50">Open + overdue</dt>
            <dd className={adherence.openOverdue > 0 ? "font-medium text-red-900" : "font-medium"}>
              {adherence.openOverdue}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wider text-ink/50">Deadlined sends</dt>
            <dd className="font-medium">{adherence.sentWithDeadline}</dd>
          </div>
        </dl>
      )}
    </div>
  );
}

function LifecycleBanner({ state }: { state: ReturnType<typeof getMemberLifecycleState> }) {
  if (state.kind === "active") {
    return (
      <div className="rounded border border-emerald-200 bg-emerald-50/60 p-3 text-sm text-emerald-900">
        Your account is active. Drafting is enabled.
      </div>
    );
  }
  if (state.kind === "revoked_grace") {
    return (
      <div className="rounded border border-amber-300 bg-amber-50/60 p-3 text-sm text-amber-900">
        Access revoked on {state.revokedAt.toISOString().slice(0, 10)}. Drafting is halted.
        Re-authorise by {state.deadline.toISOString().slice(0, 10)} to resume — otherwise
        your UCG is anonymised on the next sweep.
      </div>
    );
  }
  if (state.kind === "revoked_expired") {
    return (
      <div className="rounded border border-red-300 bg-red-50/60 p-3 text-sm text-red-900">
        Re-authorisation window expired on {state.deadline.toISOString().slice(0, 10)}.
        Membership will be suspended at the next lifecycle sweep.
      </div>
    );
  }
  if (state.kind === "leaver_grace") {
    return (
      <div className="rounded border border-red-300 bg-red-50/60 p-3 text-sm text-red-900">
        Marked as leaver on {state.markedAt.toISOString().slice(0, 10)}. Anonymisation due
        {" "}{state.deadline.toISOString().slice(0, 10)}.
      </div>
    );
  }
  return null;
}

/**
 * Opt-outable kinds get a toggle each; mandatory kinds are listed in a
 * secondary "Always sent" block so the user can see what they cannot
 * mute and why. Per-kind copy lives in i18n
 * (`notifications.kinds.<key>`), so a translator sees them together.
 */
const OPT_OUTABLE_COPY: Record<
  OptOutableKind,
  { labelKey: DictionaryPath; descriptionKey: DictionaryPath }
> = {
  weekly_digest: {
    labelKey: "notifications.kinds.weeklyDigestLabel",
    descriptionKey: "notifications.kinds.weeklyDigestDescription",
  },
  sign_in_new_device: {
    labelKey: "notifications.kinds.signInNewDeviceLabel",
    descriptionKey: "notifications.kinds.signInNewDeviceDescription",
  },
};

const MANDATORY_COPY: Array<{ labelKey: DictionaryPath; reasonKey: DictionaryPath }> = [
  {
    labelKey: "notifications.kinds.sentimentEscalationLabel",
    reasonKey: "notifications.kinds.sentimentEscalationAlways",
  },
  {
    labelKey: "notifications.kinds.adherenceEscalationLabel",
    reasonKey: "notifications.kinds.adherenceEscalationAlways",
  },
  {
    labelKey: "notifications.kinds.breachAckRequiredLabel",
    reasonKey: "notifications.kinds.breachAckRequiredAlways",
  },
  {
    labelKey: "notifications.kinds.auditChainTamperedLabel",
    reasonKey: "notifications.kinds.auditChainTamperedAlways",
  },
  {
    labelKey: "notifications.kinds.subprocessorChangeLabel",
    reasonKey: "notifications.kinds.subprocessorChangeAlways",
  },
  {
    labelKey: "notifications.kinds.cronStalledLabel",
    reasonKey: "notifications.kinds.cronStalledAlways",
  },
  {
    labelKey: "notifications.kinds.totpResetByAdminLabel",
    reasonKey: "notifications.kinds.totpResetByAdminAlways",
  },
];

function NotificationPreferencesCard({
  prefs,
  action,
  t,
}: {
  prefs: Record<OptOutableKind, boolean>;
  action: (fd: FormData) => Promise<void>;
  t: TFunction;
}) {
  return (
    <div className="card space-y-4">
      <div>
        <h2 className="text-base font-medium">
          {t("account.notificationPrefsHeading")}
        </h2>
        <p className="mt-1 text-sm text-ink/70">
          {t("account.notificationPrefsDescription")}
        </p>
      </div>

      <ul className="divide-y divide-ink/5">
        {OPT_OUTABLE_KINDS.map((kind) => {
          const enabled = prefs[kind];
          const copy = OPT_OUTABLE_COPY[kind];
          return (
            <li
              key={kind}
              className="flex flex-col gap-2 py-3 first:pt-0 sm:flex-row sm:items-start sm:justify-between"
            >
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{t(copy.labelKey)}</div>
                <p className="mt-0.5 text-xs text-ink/60">{t(copy.descriptionKey)}</p>
              </div>
              <form action={action} className="flex shrink-0 items-center gap-2">
                <input type="hidden" name="kind" value={kind} />
                {/* Submit the inverse — clicking the button toggles the bit. */}
                <input
                  type="hidden"
                  name="emailEnabled"
                  value={enabled ? "off" : "on"}
                />
                <span
                  className={`tag text-xs ${
                    enabled ? "bg-emerald-50 text-emerald-800" : "bg-ink/5 text-ink/60"
                  }`}
                >
                  {enabled
                    ? t("account.notificationPrefsToggleEnable")
                    : t("account.notificationPrefsToggleDisable")}
                </span>
                <button type="submit" className="btn text-xs">
                  {enabled
                    ? t("account.notificationPrefsToggleDisable")
                    : t("account.notificationPrefsToggleEnable")}
                </button>
              </form>
            </li>
          );
        })}
      </ul>

      <div className="rounded border border-ink/5 bg-ink/3 p-3">
        <div className="text-xs font-medium uppercase tracking-wider text-ink/60">
          {t("account.notificationPrefsAlwaysSentHeading")}
        </div>
        <p className="mt-1 text-xs text-ink/60">
          {t("account.notificationPrefsAlwaysSentDescription")}
        </p>
        <ul className="mt-2 space-y-1 text-xs">
          {MANDATORY_COPY.map((m) => (
            <li
              key={m.labelKey}
              className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between"
            >
              <span className="font-medium">{t(m.labelKey)}</span>
              <span className="text-ink/50">{t(m.reasonKey)}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
