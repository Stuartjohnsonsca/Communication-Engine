import { redirect } from "next/navigation";
import { getTenantContext } from "@/lib/tenant";
import { hasPermission } from "@/lib/rbac";
import { superDb } from "@/lib/db";

export default async function AccessibilityPage({
  params,
}: {
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");
  if (!hasPermission(ctx.membership.role, "accessibility:read")) {
    redirect(`/${tenantSlug}/dashboard`);
  }

  const active = await superDb.accessibilityStatement.findFirst({
    where: { isActive: true },
    orderBy: { version: "desc" },
  });

  if (!active) {
    return (
      <div className="card text-sm text-ink/60">
        No accessibility statement published yet.
      </div>
    );
  }

  const knownIssues = parseKnownIssues(active.knownIssues);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Accessibility statement</h1>
        <p className="mt-1 text-sm text-ink/70">
          PRD §13.4 — published commitment for Acumon Communications. Version{" "}
          <strong>v{active.version}</strong>, conformance target{" "}
          <strong>{active.conformanceTo}</strong>, claim{" "}
          <strong>{active.claim}</strong>.
        </p>
      </div>

      <section className="card whitespace-pre-wrap text-sm">{active.body}</section>

      {knownIssues.length > 0 && (
        <section className="card space-y-2">
          <h2 className="text-base font-medium">Known issues</h2>
          <ul className="space-y-2 text-sm">
            {knownIssues.map((k, i) => (
              <li key={i} className="rounded border border-ink/10 p-3">
                <div className="font-medium">{k.issue}</div>
                {k.impact && <div className="text-xs text-ink/60">Impact: {k.impact}</div>}
                {k.workaround && (
                  <div className="mt-1 text-xs text-ink/70">Workaround: {k.workaround}</div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card space-y-2 text-sm text-ink/70">
        {active.auditedAt ? (
          <p>
            Last formal audit: <strong>{active.auditedAt.toISOString().slice(0, 10)}</strong>
            {active.auditedByName ? ` by ${active.auditedByName}` : ""}.
          </p>
        ) : (
          <p>No formal audit recorded yet — independent audit scheduled before GA per PRD §16 P1.</p>
        )}
        <p>
          Published {active.publishedAt?.toISOString().slice(0, 10) ?? "—"}
          {active.publishedByName ? ` by ${active.publishedByName}` : ""}.
        </p>
      </section>
    </div>
  );
}

type KnownIssue = { issue: string; impact?: string; workaround?: string };

function parseKnownIssues(value: unknown): KnownIssue[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is KnownIssue => {
    return (
      typeof v === "object" &&
      v !== null &&
      typeof (v as { issue?: unknown }).issue === "string"
    );
  });
}
