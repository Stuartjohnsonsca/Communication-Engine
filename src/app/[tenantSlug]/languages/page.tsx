import { redirect } from "next/navigation";
import Link from "next/link";
import { getTenantContext } from "@/lib/tenant";
import { hasPermission } from "@/lib/rbac";
import { superDb } from "@/lib/db";

export default async function LanguagesPage({
  params,
}: {
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");
  if (!hasPermission(ctx.membership.role, "languages:read")) {
    redirect(`/${tenantSlug}/dashboard`);
  }

  const languages = await superDb.supportedLanguage.findMany({
    orderBy: { ordinal: "asc" },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Supported languages</h1>
        <p className="mt-1 text-sm text-ink/70">
          PRD §13.5 — interface localisation + drafting languages. The same set ships at GA;
          per-User and per-FCG language style guides extend each language with firm-specific
          tone overrides.
        </p>
      </div>

      <section className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-ink/10 text-left text-xs uppercase tracking-wide text-ink/60">
            <tr>
              <th className="py-2 pr-3">Language</th>
              <th className="py-2 pr-3">Code</th>
              <th className="py-2 pr-3">Interface</th>
              <th className="py-2 pr-3">Drafting</th>
              <th className="py-2 pr-3">RTL</th>
              <th className="py-2 pr-3">Notes</th>
            </tr>
          </thead>
          <tbody>
            {languages.map((l) => (
              <tr key={l.id} className="border-b border-ink/5 last:border-0 align-top">
                <td className="py-2 pr-3">
                  <div className="font-medium">{l.name}</div>
                  <div className="text-xs text-ink/50">{l.nativeName}</div>
                </td>
                <td className="py-2 pr-3">
                  <code className="rounded bg-ink/5 px-1 text-xs">{l.code}</code>
                </td>
                <td className="py-2 pr-3">
                  {l.isInterface ? (
                    <span className="tag bg-emerald-100 text-xs text-emerald-900">Yes</span>
                  ) : (
                    <span className="tag bg-ink/5 text-xs text-ink/60">—</span>
                  )}
                </td>
                <td className="py-2 pr-3">
                  {l.isDrafting ? (
                    <span className="tag bg-emerald-100 text-xs text-emerald-900">Yes</span>
                  ) : (
                    <span className="tag bg-ink/5 text-xs text-ink/60">—</span>
                  )}
                </td>
                <td className="py-2 pr-3 text-xs text-ink/60">{l.rtl ? "Yes" : "No"}</td>
                <td className="py-2 pr-3 text-xs text-ink/60">{l.notes ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card space-y-2">
        <h2 className="text-base font-medium">Channel-specific tone adaptation</h2>
        <p className="text-sm text-ink/70">
          A single FCG rule (e.g. &ldquo;be concise&rdquo;) expresses differently across Email,
          Slack, Teams, formal letters and reports. Every FCGRule carries a{" "}
          <code className="rounded bg-ink/5 px-1">channel</code> dimension and a{" "}
          <code className="rounded bg-ink/5 px-1">channelOverrides</code> JSON map so the same
          rule can vary by channel without splitting into duplicates.
        </p>
        <p className="text-sm text-ink/70">
          Multilingual firms hold per-language FCG variants — committed via the regular §6
          quorum vote, see{" "}
          <Link href={`/${tenantSlug}/fcg`} className="underline decoration-dotted">
            FCG workspace
          </Link>
          .
        </p>
      </section>
    </div>
  );
}
