import { redirect } from "next/navigation";
import Link from "next/link";
import { getTenantContext } from "@/lib/tenant";
import { signOut } from "@/lib/auth";
import { getDpiaStatus } from "@/lib/dpia/status";
import { hasPermission } from "@/lib/rbac";
import { getNavBadges } from "@/lib/notifications";
import { NavShell } from "@/components/NavShell";

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

  const nav = [
    { href: `/${tenantSlug}/dashboard`, label: "Dashboard" },
    { href: `/${tenantSlug}/notifications`, label: "Notifications" },
    { href: `/${tenantSlug}/fcg`, label: "Firm Culture Guide" },
    { href: `/${tenantSlug}/ucg`, label: "My Culture Guide" },
    { href: `/${tenantSlug}/drafts`, label: "Drafts" },
    { href: `/${tenantSlug}/actions`, label: "Actions" },
    { href: `/${tenantSlug}/meetings`, label: "Meetings" },
    { href: `/${tenantSlug}/opportunities`, label: "Opportunities" },
    { href: `/${tenantSlug}/sentiment`, label: "Sentiment" },
    { href: `/${tenantSlug}/dashboards`, label: "Adherence" },
    ...(hasPermission(ctx.membership.role, "adherence:read")
      ? [{ href: `/${tenantSlug}/adherence/escalations`, label: "Adherence escalations" }]
      : []),
    { href: `/${tenantSlug}/dpia`, label: "DPIA" },
    ...(hasPermission(ctx.membership.role, "processing-map:read")
      ? [{ href: `/${tenantSlug}/compliance/processing-map`, label: "Controller / Processor" }]
      : []),
    ...(hasPermission(ctx.membership.role, "transfers:read")
      ? [{ href: `/${tenantSlug}/compliance/transfers`, label: "Cross-border transfer" }]
      : []),
    ...(hasPermission(ctx.membership.role, "breach:read")
      ? [{ href: `/${tenantSlug}/compliance/breaches`, label: "Breach notifications" }]
      : []),
    { href: `/${tenantSlug}/dsar`, label: "DSAR" },
    { href: `/${tenantSlug}/roadmap`, label: "Roadmap" },
    { href: `/${tenantSlug}/risks`, label: "Risks" },
    { href: `/${tenantSlug}/switching`, label: "Switching posture" },
    { href: `/${tenantSlug}/integrations`, label: "Integrations" },
    ...(hasPermission(ctx.membership.role, "sla:read")
      ? [{ href: `/${tenantSlug}/sla`, label: "Service levels" }]
      : []),
    ...(hasPermission(ctx.membership.role, "accessibility:read")
      ? [{ href: `/${tenantSlug}/accessibility`, label: "Accessibility" }]
      : []),
    ...(hasPermission(ctx.membership.role, "languages:read")
      ? [{ href: `/${tenantSlug}/languages`, label: "Languages" }]
      : []),
    { href: `/${tenantSlug}/account`, label: "My account" },
    { href: `/${tenantSlug}/admin/adherence`, label: "Firm adherence" },
    { href: `/${tenantSlug}/admin/audit`, label: "Audit log" },
    { href: `/${tenantSlug}/admin/members`, label: "Members" },
    { href: `/${tenantSlug}/admin/lifecycle`, label: "Lifecycle" },
    { href: `/${tenantSlug}/admin/channels`, label: "Channels" },
    { href: `/${tenantSlug}/admin/conflicts`, label: "UCG conflicts" },
    { href: `/${tenantSlug}/admin/sales-identifier`, label: "Sales Identifier" },
  ];
  if (hasPermission(ctx.membership.role, "billing:read")) {
    nav.push({ href: `/${tenantSlug}/admin/billing`, label: "Billing" });
  }
  // PRD §14.2 Sandbox — only meaningful in production tenants. The page
  // itself short-circuits when accessed from inside a sandbox tenant.
  if (
    hasPermission(ctx.membership.role, "sandbox:read") &&
    !ctx.tenant.isSandbox
  ) {
    nav.push({ href: `/${tenantSlug}/admin/sandbox`, label: "Sandbox" });
  }
  // PRD §14.1 onboarding. Surface for tenants still onboarding; hidden
  // once the tenant flips to LIVE (FIRM_ADMIN can still get there directly
  // via the URL if they want to revisit). Tenants that came in before this
  // module was added were back-filled to LIVE in migration 26.
  if (
    hasPermission(ctx.membership.role, "onboarding:read") &&
    ctx.tenant.onboardingPhase !== "LIVE"
  ) {
    nav.push({ href: `/${tenantSlug}/admin/onboarding`, label: "Onboarding" });
  }
  // PRD §14.4 termination + §15.3 on-demand export. Visible to anyone who
  // can read the lifecycle status; the page gates manage actions separately.
  if (hasPermission(ctx.membership.role, "termination:read")) {
    nav.push({ href: `/${tenantSlug}/admin/termination`, label: "Termination" });
  }
  // PRD §15.4 Terms and Conditions persistence. FCT can read for governance
  // oversight; FIRM_ADMIN records new versions.
  if (hasPermission(ctx.membership.role, "terms:read")) {
    nav.push({ href: `/${tenantSlug}/admin/terms`, label: "Terms" });
  }
  // PRD §11 Cross-Client Learning. Visible to anyone with xcl:read in this
  // tenant (the page itself decides whether to render the curator console
  // based on the Acumon-tenant gate).
  if (hasPermission(ctx.membership.role, "xcl:read")) {
    nav.push({ href: `/${tenantSlug}/admin/xcl`, label: "Cross-Client Learning" });
  }
  // PRD §18 sign-off questions are per-tenant — every tenant has their own
  // copy and answers them for themselves. Visible to anyone with read
  // permission within this tenant.
  if (hasPermission(ctx.membership.role, "signoff:read")) {
    nav.push({ href: `/${tenantSlug}/sign-off`, label: "Sign-off questions" });
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
            Sign out
          </button>
        </form>
      </div>
    </>
  );

  return (
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
              <span className="font-medium">DPIA · {dpia.state}.</span> {dpia.banner.message}
            </div>
            <Link
              href={`/${tenantSlug}/dpia`}
              className="shrink-0 underline decoration-dotted"
            >
              Open DPIA →
            </Link>
          </div>
        </div>
      )}
      {children}
    </NavShell>
  );
}
