import { redirect } from "next/navigation";
import Link from "next/link";
import { getTenantContext } from "@/lib/tenant";
import { signOut } from "@/lib/auth";
import { getDpiaStatus } from "@/lib/dpia/status";
import { hasPermission } from "@/lib/rbac";

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

  const dpia = await getDpiaStatus(ctx.tenant.id);

  const nav = [
    { href: `/${tenantSlug}/dashboard`, label: "Dashboard" },
    { href: `/${tenantSlug}/fcg`, label: "Firm Culture Guide" },
    { href: `/${tenantSlug}/ucg`, label: "My Culture Guide" },
    { href: `/${tenantSlug}/drafts`, label: "Drafts" },
    { href: `/${tenantSlug}/actions`, label: "Actions" },
    { href: `/${tenantSlug}/meetings`, label: "Meetings" },
    { href: `/${tenantSlug}/opportunities`, label: "Opportunities" },
    { href: `/${tenantSlug}/sentiment`, label: "Sentiment" },
    { href: `/${tenantSlug}/dashboards`, label: "Adherence" },
    { href: `/${tenantSlug}/dpia`, label: "DPIA" },
    { href: `/${tenantSlug}/dsar`, label: "DSAR" },
    { href: `/${tenantSlug}/roadmap`, label: "Roadmap" },
    { href: `/${tenantSlug}/risks`, label: "Risks" },
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
  // PRD §18 sign-off questions are Acumon-internal — only surface the link
  // when the user is operating from the Acumon tenant. The page handler
  // enforces the same gate; this just keeps Client tenants from seeing it
  // in the sidebar.
  if (
    ctx.tenant.slug === "acumon" &&
    hasPermission(ctx.membership.role, "signoff:read")
  ) {
    nav.push({ href: `/${tenantSlug}/sign-off`, label: "Sign-off questions" });
  }

  return (
    <div className="min-h-screen flex">
      <aside className="w-60 shrink-0 border-r border-ink/10 bg-white p-4">
        <Link href={`/${tenantSlug}/dashboard`} className="block">
          <div className="text-sm font-semibold">{ctx.tenant.name}</div>
          <div className="text-xs text-ink/50">{ctx.tenant.jurisdiction}</div>
        </Link>
        <nav className="mt-6 space-y-1 text-sm">
          {nav.map((n) => (
            <Link key={n.href} href={n.href} className="block rounded px-2 py-1 hover:bg-ink/5">
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="mt-8 border-t border-ink/10 pt-4 text-xs text-ink/60">
          <div>{ctx.user.email}</div>
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
      </aside>
      <main className="flex-1 overflow-y-auto p-8">
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
            <div className="flex items-baseline justify-between gap-3">
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
      </main>
    </div>
  );
}
