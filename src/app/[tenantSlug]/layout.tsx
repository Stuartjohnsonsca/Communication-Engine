import { redirect } from "next/navigation";
import { headers } from "next/headers";
import Link from "next/link";
import { getTenantContext } from "@/lib/tenant";
import { signOut } from "@/lib/auth";
import { getDpiaStatus } from "@/lib/dpia/status";
import { getNavBadges, type NavBadges } from "@/lib/notifications";
import { NavShell } from "@/components/NavShell";
import { buildNavTree, type NavNode } from "@/lib/nav-tree";
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

  // Backlog item 112 — grouped sidebar. The schema + visibility gates
  // live in src/lib/nav-tree.ts so the sidebar and the per-group tile
  // landing pages always agree on what's visible.
  const navTree = buildNavTree(ctx, tenantSlug);
  const rolledBadges = rollUpBadges(navTree, badges);

  const sidebar = (
    <>
      <Link href={`/${tenantSlug}/dashboard`} className="block">
        <div className="text-sm font-semibold">{ctx.tenant.name}</div>
        <div className="text-xs text-ink/50">{ctx.tenant.jurisdiction}</div>
      </Link>
      <nav className="mt-6 space-y-1 text-sm">
        {navTree.map((n) => {
          const badge = rolledBadges.counts[n.id] ?? 0;
          const stale = rolledBadges.stale.has(n.id);
          const badgeCls = stale
            ? "ml-2 inline-flex min-w-[1.25rem] justify-center rounded-full bg-red-700 px-1.5 py-0.5 text-[10px] font-medium leading-none text-white"
            : "ml-2 inline-flex min-w-[1.25rem] justify-center rounded-full bg-ink px-1.5 py-0.5 text-[10px] font-medium leading-none text-white";
          return (
            <Link
              key={n.id}
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

/**
 * Backlog item 112 — roll per-leaf badge counts up to their parent
 * group for the condensed sidebar. A group's count is the sum of its
 * children's counts; if any child is `stale`, the parent is `stale`.
 * Leaves (Dashboard, Notifications, Help, Account) pass through.
 */
function rollUpBadges(
  tree: NavNode[],
  badges: NavBadges,
): { counts: Record<string, number>; stale: Set<string> } {
  const counts: Record<string, number> = {};
  const stale = new Set<string>();
  for (const node of tree) {
    const leafHrefs: string[] = [];
    if (node.sections) {
      for (const s of node.sections) leafHrefs.push(...s.items.map((i) => i.href));
    } else if (node.items) {
      leafHrefs.push(...node.items.map((i) => i.href));
    } else {
      leafHrefs.push(node.href);
    }
    let total = 0;
    for (const h of leafHrefs) {
      total += badges.byHref[h] ?? 0;
      if (badges.tones[h] === "stale") stale.add(node.id);
    }
    counts[node.id] = total;
  }
  return { counts, stale };
}
