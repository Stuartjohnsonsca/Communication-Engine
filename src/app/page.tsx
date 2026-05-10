import Link from "next/link";
import { auth } from "@/lib/auth";
import { superDb } from "@/lib/db";

export default async function Home() {
  const session = await auth();
  let memberships: { tenant: { slug: string; name: string }; role: string }[] = [];
  if (session?.user?.email) {
    const user = await superDb.user.findUnique({
      where: { email: session.user.email },
      include: { memberships: { include: { tenant: true } } },
    });
    memberships =
      user?.memberships
        .filter((m) => m.status === "ACTIVE")
        .map((m) => ({ tenant: { slug: m.tenant.slug, name: m.tenant.name }, role: m.role })) ?? [];
  }

  return (
    <main className="mx-auto max-w-3xl p-8">
      <h1 className="text-3xl font-semibold tracking-tight">Acumon Communications</h1>
      <p className="mt-2 text-ink/70">
        Multi-tenant platform for governed firm-wide communications. Built to
        the Acumon Communications PRD v0.1 (May 2026).
      </p>

      <p className="mt-4 text-sm">
        <Link href="/status" className="underline decoration-dotted">
          Public service status →
        </Link>
      </p>

      <section className="card mt-6">
        <h2 className="text-lg font-medium">Sign in</h2>
        {session?.user ? (
          <div className="mt-2 text-sm">
            <p>
              Signed in as <span className="font-medium">{session.user.email}</span>.
            </p>
            {memberships.length === 0 ? (
              <p className="mt-2 text-ink/60">
                You have no active tenant memberships. Ask a Firm Administrator
                to add you, or run <code>npm run seed</code> locally.
              </p>
            ) : (
              <ul className="mt-3 space-y-1">
                {memberships.map((m) => (
                  <li key={m.tenant.slug}>
                    <Link className="btn btn-primary" href={`/${m.tenant.slug}/dashboard`}>
                      Open {m.tenant.name} ({m.role})
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <p className="mt-2 text-sm">
            <Link className="btn btn-primary" href="/login">
              Sign in
            </Link>
          </p>
        )}
      </section>

      <section className="card mt-6">
        <h2 className="text-lg font-medium">Phase 1 (built)</h2>
        <ul className="mt-2 list-disc pl-5 text-sm text-ink/80 space-y-1">
          <li>Multi-tenant data model + Postgres RLS isolation</li>
          <li>Append-only audit log with sha256 hash chain</li>
          <li>Magic-link auth + RBAC (PRD §4 roles)</li>
          <li>Firm Culture Guide chat with quorum voting</li>
          <li>User Culture Guide chat with LLM-as-judge compliance</li>
          <li>Drafting demo (paste inbound → Claude draft + actions)</li>
        </ul>
      </section>

      <section className="card mt-6">
        <h2 className="text-lg font-medium">Phase 2+ (scaffolded)</h2>
        <p className="mt-2 text-sm text-ink/70">
          M365/Google/Slack OAuth ingestion, calendar/meeting prep + minutes, adherence
          dashboards, sentiment monitoring, Sales Identifier, DPIA Helper, DSAR module,
          Cross-Client Learning curator console.
        </p>
      </section>
    </main>
  );
}
