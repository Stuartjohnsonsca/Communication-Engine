import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import { revokeAccess, reauthoriseAccess, getMemberLifecycleState } from "@/lib/lifecycle";
import {
  SUPPORTED_LOCALES,
  LOCALE_LABELS,
  isSupportedLocale,
  getT,
  resolveLocale,
} from "@/lib/i18n";
import { hasPermission } from "@/lib/rbac";

export default async function AccountPage({
  params,
}: {
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");

  const [member, channelAuths] = await Promise.all([
    superDb.membership.findUnique({
      where: { id: ctx.membership.id },
    }),
    superDb.channelAuth.findMany({
      where: { tenantId: ctx.tenant.id, membershipId: ctx.membership.id },
      include: { channel: { select: { kind: true } } },
      orderBy: { createdAt: "desc" },
    }),
  ]);
  if (!member) redirect("/login");

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
