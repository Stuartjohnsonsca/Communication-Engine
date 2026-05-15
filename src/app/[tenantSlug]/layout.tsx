import { redirect } from "next/navigation";
import { headers } from "next/headers";
import Link from "next/link";
import { getTenantContext } from "@/lib/tenant";
import { signOut } from "@/lib/auth";
import { getDpiaStatus } from "@/lib/dpia/status";
import { hasPermission } from "@/lib/rbac";
import { getNavBadges } from "@/lib/notifications";
import { NavShell } from "@/components/NavShell";
import { LocaleProvider } from "@/lib/i18n/LocaleProvider";
import { getT, resolveLocale } from "@/lib/i18n";
import { evaluateTotpGate, resolveCurrentSessionId } from "@/lib/auth/totp";
import {
  touchSession,
  observeSessionMetadata,
  ipFromHeaders,
  enforceSessionTimeout,
} from "@/lib/auth/sessions";
import { evaluateIpAllowlist } from "@/lib/auth/ip-allowlist";
import { detectAndNotify } from "@/lib/auth/anomaly";
import { reportError } from "@/lib/observability";

export default async function TenantLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");

  // Post-PRD hardening item 12 — 2FA gate. Allowlist the pages that must
  // remain reachable while a User is in the enroll-required or
  // verify-required state, otherwise the redirect loops (the redirect
  // target also runs this layout). The challenge page (/auth/2fa) handles
  // verification; /account hosts enrollment.
  const h = await headers();
  const requestPathname = h.get("x-pathname") ?? "";
  const sessionId = await resolveCurrentSessionId();
  // Post-PRD hardening item 13 — touch lastSeenAt + lazy-capture UA/IP on
  // every layout pass. Both calls are conditional UPDATEs (throttled to
  // 1/min for lastSeenAt; first-observation-wins for UA/IP) so the write
  // rate stays bounded even on hot tenant pages.
  if (sessionId) {
    // Post-PRD hardening item 15 — idle/absolute session timeout. Evaluate
    // BEFORE touching `lastSeenAt`, otherwise the touch would reset the
    // idle window using THIS request's arrival time and a User returning
    // after 65 minutes idle would pass the gate. Evaluate using the
    // pre-touch lastSeenAt, then touch only if not expired.
    const timeout = await enforceSessionTimeout(sessionId);
    if (timeout.expired) {
      redirect(`/login?timeout=${timeout.reason}`);
    }
    const ua = h.get("user-agent");
    const ip = ipFromHeaders(h);
    const [, observation] = await Promise.all([
      touchSession(sessionId),
      observeSessionMetadata(sessionId, ua, ip),
    ]);
    // Post-PRD hardening item 21 — sign-in anomaly detection. Fires exactly
    // once per session, on the very first layout pass that captures UA + IP.
    // Fire-and-forget under `reportError` — detection must never block a
    // legitimate User from reaching their tenant page.
    if (observation.firstObservation) {
      void detectAndNotify({
        sessionId,
        userId: ctx.user.id,
        userAgent: ua,
        ipAddress: ip,
      }).catch((err) =>
        reportError(err, { extra: { scope: "anomaly:detect", sessionId } }),
      );
    }
  }
  // Post-PRD hardening item 17 — tenant IP allowlist. Evaluated BEFORE
  // the TOTP gate so a misconfigured IP shows the same access-denied
  // page regardless of 2FA state. Allowlist `/access-denied` itself so
  // the denial page can render without re-tripping the check. Empty
  // allowlist is unrestricted (default for every tenant).
  const onAccessDeniedPage = requestPathname === `/${tenantSlug}/access-denied`;
  if (!onAccessDeniedPage) {
    const ipDecision = await evaluateIpAllowlist({
      tenantId: ctx.tenant.id,
      ip: ipFromHeaders(h) ?? "unknown",
      surface: "session",
      membershipId: ctx.membership.id,
    });
    if (!ipDecision.allowed) {
      redirect(`/${tenantSlug}/access-denied?reason=${encodeURIComponent(ipDecision.reason ?? "ip-not-allowed")}`);
    }
  }

  const gateAllowlist =
    requestPathname === `/${tenantSlug}/account` ||
    requestPathname.startsWith(`/${tenantSlug}/auth/2fa`) ||
    onAccessDeniedPage;
  if (!gateAllowlist) {
    const gate = await evaluateTotpGate({
      userId: ctx.user.id,
      sessionId,
      tenantRequireTotp: ctx.tenant.requireTotp,
    });
    if (gate === "enroll-required") {
      redirect(`/${tenantSlug}/account`);
    }
    if (gate === "verify-required") {
      const next = encodeURIComponent(requestPathname || `/${tenantSlug}/dashboard`);
      redirect(`/${tenantSlug}/auth/2fa?next=${next}`);
    }
  }

  const [dpia, badges] = await Promise.all([
    getDpiaStatus(ctx.tenant.id),
    getNavBadges({ tenantId: ctx.tenant.id, tenantSlug, membership: ctx.membership }),
  ]);

  const locale = resolveLocale({ membership: ctx.membership, tenant: ctx.tenant });
  const t = getT(locale);

  const nav = [
    { href: `/${tenantSlug}/dashboard`, label: t("nav.dashboard") },
    { href: `/${tenantSlug}/notifications`, label: t("nav.notifications") },
    { href: `/${tenantSlug}/fcg`, label: t("nav.fcg") },
    { href: `/${tenantSlug}/ucg`, label: t("nav.ucg") },
    { href: `/${tenantSlug}/drafts`, label: t("nav.drafts") },
    { href: `/${tenantSlug}/actions`, label: t("nav.actions") },
    { href: `/${tenantSlug}/meetings`, label: t("nav.meetings") },
    { href: `/${tenantSlug}/opportunities`, label: t("nav.opportunities") },
    { href: `/${tenantSlug}/sentiment`, label: t("nav.sentiment") },
    { href: `/${tenantSlug}/dashboards`, label: t("nav.adherence") },
    ...(hasPermission(ctx.membership.role, "adherence:read")
      ? [{ href: `/${tenantSlug}/adherence/escalations`, label: t("nav.adherenceEscalations") }]
      : []),
    { href: `/${tenantSlug}/dpia`, label: t("nav.dpia") },
    ...(hasPermission(ctx.membership.role, "processing-map:read")
      ? [{ href: `/${tenantSlug}/compliance/processing-map`, label: t("nav.processingMap") }]
      : []),
    ...(hasPermission(ctx.membership.role, "transfers:read")
      ? [{ href: `/${tenantSlug}/compliance/transfers`, label: t("nav.transfers") }]
      : []),
    ...(hasPermission(ctx.membership.role, "breach:read")
      ? [{ href: `/${tenantSlug}/compliance/breaches`, label: t("nav.breaches") }]
      : []),
    { href: `/${tenantSlug}/dsar`, label: t("nav.dsar") },
    { href: `/${tenantSlug}/roadmap`, label: t("nav.roadmap") },
    { href: `/${tenantSlug}/risks`, label: t("nav.risks") },
    { href: `/${tenantSlug}/switching`, label: t("nav.switching") },
    { href: `/${tenantSlug}/integrations`, label: t("nav.integrations") },
    ...(hasPermission(ctx.membership.role, "sla:read")
      ? [{ href: `/${tenantSlug}/sla`, label: t("nav.sla") }]
      : []),
    ...(hasPermission(ctx.membership.role, "accessibility:read")
      ? [{ href: `/${tenantSlug}/accessibility`, label: t("nav.accessibility") }]
      : []),
    ...(hasPermission(ctx.membership.role, "languages:read")
      ? [{ href: `/${tenantSlug}/languages`, label: t("nav.languages") }]
      : []),
    { href: `/${tenantSlug}/help`, label: t("nav.help") },
    { href: `/${tenantSlug}/account`, label: t("nav.account") },
    { href: `/${tenantSlug}/admin/adherence`, label: t("nav.firmAdherence") },
    { href: `/${tenantSlug}/admin/audit`, label: t("nav.auditLog") },
    { href: `/${tenantSlug}/admin/members`, label: t("nav.members") },
    { href: `/${tenantSlug}/admin/lifecycle`, label: t("nav.lifecycle") },
    { href: `/${tenantSlug}/admin/channels`, label: t("nav.channels") },
    { href: `/${tenantSlug}/admin/conflicts`, label: t("nav.ucgConflicts") },
    { href: `/${tenantSlug}/admin/sales-identifier`, label: t("nav.salesIdentifier") },
  ];
  if (hasPermission(ctx.membership.role, "billing:read")) {
    nav.push({ href: `/${tenantSlug}/admin/billing`, label: t("nav.billing") });
  }
  // Post-PRD hardening item 55 — LLM usage observability. Same posture
  // as billing: FIRM_ADMIN only, operational/commercial data.
  if (hasPermission(ctx.membership.role, "usage:read")) {
    nav.push({ href: `/${tenantSlug}/admin/usage`, label: t("nav.usage") });
  }
  // Post-PRD hardening item 56 — draft outcome rollup. FCT included
  // (governance signal: is the FCG producing on-promise drafts?);
  // no commercial data here so it's a wider gate than usage:read.
  if (hasPermission(ctx.membership.role, "drafts:read-rollup")) {
    nav.push({
      href: `/${tenantSlug}/admin/drafts`,
      label: t("nav.draftOutcomes"),
    });
  }
  // Post-PRD hardening item 12 — tenant-wide 2FA policy. Only FIRM_ADMINs
  // can flip the policy; the page itself is gated, but we also hide the
  // nav entry from everyone else to keep the sidebar tidy.
  if (hasPermission(ctx.membership.role, "tenant:configure-totp-policy")) {
    nav.push({ href: `/${tenantSlug}/admin/security`, label: t("nav.security") });
  }
  // Post-PRD hardening item 14 — outbound webhooks. FIRM_ADMIN configures;
  // FCT can read for governance oversight.
  if (hasPermission(ctx.membership.role, "webhooks:read")) {
    nav.push({ href: `/${tenantSlug}/admin/webhooks`, label: t("nav.webhooks") });
  }
  // Post-PRD hardening item 100 — per-tenant cron threshold overrides.
  // FIRM_ADMIN-only; same gate as the page handler.
  if (hasPermission(ctx.membership.role, "tenant:configure-cron-thresholds")) {
    nav.push({
      href: `/${tenantSlug}/admin/sensitivity`,
      label: t("nav.sensitivity"),
    });
  }
  // Post-PRD hardening item 101 — bring-your-own OAuth provider apps.
  // FIRM_ADMIN-only; same gate as the page handler. Surfaced before
  // /admin/channels in the sidebar order so a fresh tenant configures
  // their provider app first, then connects channels to it.
  if (hasPermission(ctx.membership.role, "tenant:configure-channel-oauth-app")) {
    nav.push({
      href: `/${tenantSlug}/admin/channels/oauth-apps`,
      label: t("nav.oauthApps"),
    });
  }
  // Post-PRD hardening item 110 — IMAP server config (sibling to
  // OAuth apps for legacy / on-prem mail servers without OAuth).
  // Same RBAC gate as channel CRUD.
  if (hasPermission(ctx.membership.role, "channels:write")) {
    nav.push({
      href: `/${tenantSlug}/admin/channels/imap-servers`,
      label: t("nav.imapServers"),
    });
  }
  // Post-PRD hardening item 16 — programmatic API keys. FIRM_ADMIN
  // creates / revokes; FCT can read (same posture as webhooks).
  if (hasPermission(ctx.membership.role, "apikeys:read")) {
    nav.push({ href: `/${tenantSlug}/admin/api-keys`, label: t("nav.apiKeys") });
  }
  // Post-PRD hardening item 22 — cron heartbeat monitoring. Acumon-side
  // only (cron schedules are platform-wide). The page handler also gates
  // on tenant.slug === "acumon" so even FIRM_ADMINs of other tenants
  // can't view operator infrastructure status. Hide the nav entry
  // entirely outside the operator tenant — there's nothing for non-Acumon
  // FIRM_ADMINs to do on this page.
  if (
    hasPermission(ctx.membership.role, "system:cron-health:read") &&
    ctx.tenant.slug === "acumon"
  ) {
    nav.push({ href: `/${tenantSlug}/admin/health`, label: t("nav.systemHealth") });
  }
  // PRD §14.2 Sandbox — only meaningful in production tenants. The page
  // itself short-circuits when accessed from inside a sandbox tenant.
  if (
    hasPermission(ctx.membership.role, "sandbox:read") &&
    !ctx.tenant.isSandbox
  ) {
    nav.push({ href: `/${tenantSlug}/admin/sandbox`, label: t("nav.sandbox") });
  }
  // PRD §14.1 onboarding. Surface for tenants still onboarding; hidden
  // once the tenant flips to LIVE (FIRM_ADMIN can still get there directly
  // via the URL if they want to revisit). Tenants that came in before this
  // module was added were back-filled to LIVE in migration 26.
  if (
    hasPermission(ctx.membership.role, "onboarding:read") &&
    ctx.tenant.onboardingPhase !== "LIVE"
  ) {
    nav.push({ href: `/${tenantSlug}/admin/onboarding`, label: t("nav.onboarding") });
  }
  // PRD §14.4 termination + §15.3 on-demand export. Visible to anyone who
  // can read the lifecycle status; the page gates manage actions separately.
  if (hasPermission(ctx.membership.role, "termination:read")) {
    nav.push({ href: `/${tenantSlug}/admin/termination`, label: t("nav.termination") });
  }
  // PRD §15.4 Terms and Conditions persistence. FCT can read for governance
  // oversight; FIRM_ADMIN records new versions.
  if (hasPermission(ctx.membership.role, "terms:read")) {
    nav.push({ href: `/${tenantSlug}/admin/terms`, label: t("nav.terms") });
  }
  // PRD §11 Cross-Client Learning. Visible to anyone with xcl:read in this
  // tenant (the page itself decides whether to render the curator console
  // based on the Acumon-tenant gate).
  if (hasPermission(ctx.membership.role, "xcl:read")) {
    nav.push({ href: `/${tenantSlug}/admin/xcl`, label: t("nav.xcl") });
  }
  // PRD §18 sign-off questions are per-tenant — every tenant has their own
  // copy and answers them for themselves. Visible to anyone with read
  // permission within this tenant.
  if (hasPermission(ctx.membership.role, "signoff:read")) {
    nav.push({ href: `/${tenantSlug}/sign-off`, label: t("nav.signoff") });
  }

  const sidebar = (
    <>
      <Link href={`/${tenantSlug}/dashboard`} className="block">
        <div className="text-sm font-semibold">{ctx.tenant.name}</div>
        <div className="text-xs text-ink/50">{ctx.tenant.jurisdiction}</div>
      </Link>
      <nav className="mt-6 space-y-1 text-sm">
        {nav.map((n) => {
          const badge = badges.byHref[n.href] ?? 0;
          // Items 82 + 94 — stale tone paints the badge red, signalling
          // "the count above includes work that has crossed the 4h
          // stale line." Emitted for /sentiment AND
          // /adherence/escalations from item 94 onwards.
          const stale = badges.tones[n.href] === "stale";
          const badgeCls = stale
            ? "ml-2 inline-flex min-w-[1.25rem] justify-center rounded-full bg-red-700 px-1.5 py-0.5 text-[10px] font-medium leading-none text-white"
            : "ml-2 inline-flex min-w-[1.25rem] justify-center rounded-full bg-ink px-1.5 py-0.5 text-[10px] font-medium leading-none text-white";
          return (
            <Link
              key={n.href}
              href={n.href}
              className="flex items-center justify-between rounded px-2 py-1 hover:bg-ink/5"
            >
              <span>{n.label}</span>
              {badge > 0 && (
                <span
                  className={badgeCls}
                  title={stale ? "Includes item(s) outstanding > 4h" : undefined}
                >
                  {badge > 99 ? "99+" : badge}
                </span>
              )}
            </Link>
          );
        })}
      </nav>
      <div className="mt-8 border-t border-ink/10 pt-4 text-xs text-ink/60">
        <div className="break-words">{ctx.user.email}</div>
        <div className="tag mt-1">{ctx.membership.role}</div>
        <form
          action={async () => {
            "use server";
            await signOut({ redirectTo: "/" });
          }}
          className="mt-3"
        >
          <button className="btn w-full text-xs" type="submit">
            {t("shell.signOut")}
          </button>
        </form>
      </div>
    </>
  );

  return (
    <LocaleProvider locale={locale}>
      <NavShell tenantSlug={tenantSlug} tenantName={ctx.tenant.name} sidebar={sidebar}>
        {dpia.banner && (
          <div
            className={`mb-6 rounded border px-3 py-2 text-sm ${
              dpia.banner.tone === "alert"
                ? "border-red-300 bg-red-50/60 text-red-800"
                : dpia.banner.tone === "warn"
                  ? "border-amber-300 bg-amber-50/60 text-amber-900"
                  : "border-sky-300 bg-sky-50/60 text-sky-900"
            }`}
          >
            <div className="flex flex-col gap-2 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
              <div>
                <span className="font-medium">{t("dpia.label")} · {dpia.state}.</span> {dpia.banner.message}
              </div>
              <Link
                href={`/${tenantSlug}/dpia`}
                className="shrink-0 underline decoration-dotted"
              >
                {t("dpia.open")}
              </Link>
            </div>
          </div>
        )}
        {children}
      </NavShell>
    </LocaleProvider>
  );
}
