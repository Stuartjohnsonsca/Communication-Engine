import { redirect } from "next/navigation";
import Link from "next/link";
import { getTenantContext } from "@/lib/tenant";
import { signOut } from "@/lib/auth";
import { getDpiaStatus } from "@/lib/dpia/status";
import { hasPermission } from "@/lib/rbac";
import { getNavBadges } from "@/lib/notifications";
import { NavShell } from "@/components/NavShell";
import { LocaleProvider } from "@/lib/i18n/LocaleProvider";
import { getT, resolveLocale } from "@/lib/i18n";

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
          return (
            <Link
              key={n.href}
              href={n.href}
              className="flex items-center justify-between rounded px-2 py-1 hover:bg-ink/5"
            >
              <span>{n.label}</span>
              {badge > 0 && (
                <span className="ml-2 inline-flex min-w-[1.25rem] justify-center rounded-full bg-ink px-1.5 py-0.5 text-[10px] font-medium leading-none text-white">
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
