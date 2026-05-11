import { redirect } from "next/navigation";
import Link from "next/link";
import { AuditEventType } from "@prisma/client";
import { getTenantContext } from "@/lib/tenant";
import { hasPermission } from "@/lib/rbac";
import { listAuditEvents, resolveAuditActor, type AuditListFilters } from "@/lib/audit";
import { getT, resolveLocale } from "@/lib/i18n";
import VerifyChainButton from "./VerifyChainButton";
import AuditRow from "./AuditRow";

type SearchParams = {
  event?: string;
  actor?: string;
  subject_type?: string;
  subject_id?: string;
  since?: string;
  until?: string;
  before?: string;
  size?: string;
};

const PAGE_SIZE_DEFAULT = 50;
const PAGE_SIZE_OPTIONS = [25, 50, 100, 200];

/** All AuditEventType enum values, sorted alphabetically for the dropdown. */
const EVENT_TYPE_OPTIONS = Object.values(AuditEventType).sort();

function parseDate(value: string | undefined, kind: "since" | "until"): Date | null {
  if (!value) return null;
  // <input type="date"> emits YYYY-MM-DD. Construct as UTC midnight so the
  // bounds are deterministic regardless of server timezone. For "until" we
  // add one day so the filter is calendar-inclusive (the lib applies `<`).
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const [, y, mo, d] = m;
  const ts = Date.UTC(Number(y), Number(mo) - 1, Number(d));
  if (Number.isNaN(ts)) return null;
  return new Date(kind === "until" ? ts + 24 * 60 * 60 * 1000 : ts);
}

function parseBigInt(value: string | undefined): bigint | null {
  if (!value) return null;
  try {
    const b = BigInt(value);
    return b > 0n ? b : null;
  } catch {
    return null;
  }
}

function parseEventType(value: string | undefined): AuditEventType | null {
  if (!value) return null;
  return EVENT_TYPE_OPTIONS.includes(value as AuditEventType)
    ? (value as AuditEventType)
    : null;
}

function buildQuery(params: Record<string, string | null | undefined>) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v) sp.set(k, v);
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export default async function AuditPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenantSlug: string }>;
  searchParams?: Promise<SearchParams>;
}) {
  const { tenantSlug } = await params;
  const sp = (await searchParams) ?? {};
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");
  if (!hasPermission(ctx.membership.role, "audit:read")) {
    return (
      <p className="text-sm text-ink/60">
        You don&apos;t have permission to view the audit log.
      </p>
    );
  }

  const locale = resolveLocale({ membership: ctx.membership, tenant: ctx.tenant });
  const t = getT(locale);

  const event = parseEventType(sp.event);
  const since = parseDate(sp.since, "since");
  const until = parseDate(sp.until, "until");
  const actorToken = (sp.actor ?? "").trim();
  const subjectType = (sp.subject_type ?? "").trim();
  const subjectId = (sp.subject_id ?? "").trim();
  const before = parseBigInt(sp.before);
  const sizeRaw = Number.parseInt(sp.size ?? "", 10);
  const size = PAGE_SIZE_OPTIONS.includes(sizeRaw) ? sizeRaw : PAGE_SIZE_DEFAULT;

  // Resolve actor token to a membership id (accepts email or id). An
  // unresolved token forces an impossible filter so the page renders empty
  // rather than silently ignoring the filter.
  let actorMembershipId: string | null = null;
  let actorResolutionMiss = false;
  if (actorToken) {
    actorMembershipId = await resolveAuditActor(ctx.tenant.id, actorToken);
    actorResolutionMiss = actorMembershipId === null;
  }

  const filters: AuditListFilters = {
    eventTypes: event ? [event] : undefined,
    actorMembershipId: actorResolutionMiss ? "__no_match__" : actorMembershipId,
    subjectType: subjectType || null,
    subjectId: subjectId || null,
    since,
    until,
  };

  const result = await listAuditEvents({
    tenantId: ctx.tenant.id,
    filters,
    before,
    limit: size,
  });

  const filterQuery = {
    event: event ?? "",
    actor: actorToken || null,
    subject_type: subjectType || null,
    subject_id: subjectId || null,
    since: sp.since ?? null,
    until: sp.until ?? null,
    size: size === PAGE_SIZE_DEFAULT ? null : String(size),
  };
  const nextHref = result.nextCursor
    ? `/${tenantSlug}/admin/audit${buildQuery({ ...filterQuery, before: result.nextCursor })}`
    : null;
  const firstPageHref = `/${tenantSlug}/admin/audit${buildQuery(filterQuery)}`;
  const hasFilters =
    !!event || !!actorToken || !!subjectType || !!subjectId || !!sp.since || !!sp.until;
  const resetHref = `/${tenantSlug}/admin/audit`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t("audit.heading")}</h1>
          <p className="mt-1 max-w-2xl text-xs text-ink/60">{t("audit.description")}</p>
        </div>
        <div className="flex items-start gap-3">
          <VerifyChainButton tenantSlug={tenantSlug} />
          {hasPermission(ctx.membership.role, "audit:export") && (
            <Link
              className="btn btn-primary"
              href={`/api/audit/export?tenant=${tenantSlug}`}
              prefetch={false}
            >
              {t("audit.exportButton")}
            </Link>
          )}
        </div>
      </div>

      <form className="card space-y-3" method="get">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-ink/60">{t("audit.filterEvent")}</span>
            <select
              name="event"
              defaultValue={event ?? ""}
              className="rounded border border-ink/15 bg-white px-2 py-1 text-sm"
            >
              <option value="">{t("audit.filterEventAny")}</option>
              {EVENT_TYPE_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-ink/60">{t("audit.filterActor")}</span>
            <input
              type="text"
              name="actor"
              defaultValue={actorToken}
              placeholder="email@example.com or membership id"
              className="rounded border border-ink/15 bg-white px-2 py-1 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-ink/60">{t("audit.filterSubjectType")}</span>
            <input
              type="text"
              name="subject_type"
              defaultValue={subjectType}
              placeholder="Draft, Membership, Channel…"
              className="rounded border border-ink/15 bg-white px-2 py-1 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-ink/60">{t("audit.filterSubjectId")}</span>
            <input
              type="text"
              name="subject_id"
              defaultValue={subjectId}
              placeholder="exact id"
              className="rounded border border-ink/15 bg-white px-2 py-1 text-sm font-mono"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-ink/60">{t("audit.filterSince")}</span>
            <input
              type="date"
              name="since"
              defaultValue={sp.since ?? ""}
              className="rounded border border-ink/15 bg-white px-2 py-1 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-ink/60">{t("audit.filterUntil")}</span>
            <input
              type="date"
              name="until"
              defaultValue={sp.until ?? ""}
              className="rounded border border-ink/15 bg-white px-2 py-1 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-ink/60">{t("audit.filterPageSize")}</span>
            <select
              name="size"
              defaultValue={String(size)}
              className="rounded border border-ink/15 bg-white px-2 py-1 text-sm"
            >
              {PAGE_SIZE_OPTIONS.map((opt) => (
                <option key={opt} value={String(opt)}>
                  {opt}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn btn-primary" type="submit">
            {t("audit.applyFilters")}
          </button>
          {hasFilters && (
            <Link className="btn" href={resetHref} prefetch={false}>
              {t("audit.resetFilters")}
            </Link>
          )}
          {actorResolutionMiss && (
            <span className="text-xs text-amber-700">{t("audit.actorNotFound")}</span>
          )}
        </div>
      </form>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wider text-ink/50">
            <tr>
              <th className="py-1 pr-3">#</th>
              <th className="py-1 pr-3">{t("audit.colWhen")}</th>
              <th className="py-1 pr-3">{t("audit.colEvent")}</th>
              <th className="py-1 pr-3">{t("audit.colSubject")}</th>
              <th className="py-1 pr-3">{t("audit.colActor")}</th>
              <th className="py-1 pr-3">{t("audit.colHash")}</th>
              <th className="py-1 pr-3 text-right">{t("audit.colDetails")}</th>
            </tr>
          </thead>
          <tbody>
            {result.events.length === 0 && (
              <tr>
                <td colSpan={7} className="py-3 text-center text-xs text-ink/50">
                  {t("audit.empty")}
                </td>
              </tr>
            )}
            {result.events.map((e) => (
              <AuditRow
                key={e.id}
                event={{
                  id: e.id,
                  seq: e.seq.toString(),
                  eventType: e.eventType,
                  createdAt: e.createdAt.toISOString(),
                  subjectType: e.subjectType,
                  subjectId: e.subjectId,
                  actorEmail: e.actor?.user.email ?? null,
                  hash: e.hash,
                  prevHash: e.prevHash,
                  payloadJson: JSON.stringify(e.payload, null, 2),
                }}
              />
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-ink/50">
          {result.events.length > 0
            ? t("audit.showingCount", {
                shown: String(result.events.length),
                from: result.events[0].seq.toString(),
                to: result.events[result.events.length - 1].seq.toString(),
              })
            : ""}
        </span>
        <div className="flex items-center gap-2">
          {before != null && (
            <Link className="btn" href={firstPageHref} prefetch={false}>
              {t("audit.firstPage")}
            </Link>
          )}
          {nextHref && (
            <Link className="btn" href={nextHref} prefetch={false}>
              {t("audit.olderPage")}
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
