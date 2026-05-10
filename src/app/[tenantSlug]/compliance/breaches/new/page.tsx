import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getTenantContext } from "@/lib/tenant";
import { hasPermission } from "@/lib/rbac";
import {
  SEVERITY_LABELS,
  createBreachIncident,
  isAcumonBreachOperator,
} from "@/lib/compliance/breach";
import type { BreachSeverity } from "@prisma/client";

const SEVERITY_OPTIONS: BreachSeverity[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];

export default async function NewBreachIncidentPage({
  params,
}: {
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");
  if (
    !isAcumonBreachOperator(ctx.tenant.slug) ||
    !hasPermission(ctx.membership.role, "breach:manage")
  ) {
    redirect(`/${tenantSlug}/compliance/breaches`);
  }

  async function createAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (
      !isAcumonBreachOperator(inner.tenant.slug) ||
      !hasPermission(inner.membership.role, "breach:manage")
    ) {
      throw new Error("forbidden");
    }
    const detectedAtRaw = String(formData.get("detectedAt") ?? "");
    const created = await createBreachIncident({
      title: String(formData.get("title") ?? ""),
      description: String(formData.get("description") ?? ""),
      severity: String(formData.get("severity") ?? "MEDIUM") as BreachSeverity,
      detectedAt: detectedAtRaw ? new Date(detectedAtRaw) : undefined,
      awareAt: new Date(String(formData.get("awareAt") ?? "")),
      isPersonalData: formData.get("isPersonalData") === "on",
      affectedCategories: String(formData.get("affectedCategories") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      recordedByName: String(formData.get("recordedByName") ?? ""),
      actorTenantId: inner.tenant.id,
      actorMembershipId: inner.membership.id,
    });
    revalidatePath(`/${tenantSlug}/compliance/breaches`);
    redirect(`/${tenantSlug}/compliance/breaches/${created.id}`);
  }

  const nowIso = new Date().toISOString().slice(0, 16);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Record breach incident</h1>
        <p className="mt-1 text-sm text-ink/70">
          The 24-hour notice clock starts at <strong>aware</strong>, not detected. Be precise
          with the timestamp — every per-Client notification deadline is computed from it.
        </p>
      </div>

      <form action={createAction} className="card grid gap-3 text-sm">
        <input
          className="input"
          name="title"
          required
          maxLength={200}
          placeholder="Short factual title (no jargon)"
        />
        <textarea
          className="input"
          name="description"
          required
          rows={4}
          placeholder="What happened, what data was potentially exposed. Keep neutral and factual — this body is shown verbatim to affected Clients unless you tailor a per-Client payload at dispatch time."
        />
        <div className="grid grid-cols-2 gap-2">
          <label className="grid gap-1">
            <span className="text-xs text-ink/60">Aware at (UTC)</span>
            <input
              className="input"
              name="awareAt"
              type="datetime-local"
              required
              defaultValue={nowIso}
            />
          </label>
          <label className="grid gap-1">
            <span className="text-xs text-ink/60">Detected at (best known, optional)</span>
            <input className="input" name="detectedAt" type="datetime-local" />
          </label>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <label className="grid gap-1">
            <span className="text-xs text-ink/60">Severity</span>
            <select className="input" name="severity" defaultValue="MEDIUM">
              {SEVERITY_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {SEVERITY_LABELS[s]}
                </option>
              ))}
            </select>
          </label>
          <label className="inline-flex items-center gap-2 self-end text-xs">
            <input type="checkbox" name="isPersonalData" defaultChecked />
            Personal-data breach (UK GDPR Art. 4(12))
          </label>
        </div>
        <input
          className="input"
          name="affectedCategories"
          placeholder="Affected categories (comma-separated, e.g. drafts, audit metadata)"
        />
        <input
          className="input"
          name="recordedByName"
          required
          placeholder="Recorded by (your name)"
          defaultValue={ctx.user.name ?? ""}
        />
        <button className="btn btn-primary justify-self-start" type="submit">
          Create incident
        </button>
      </form>
    </div>
  );
}
