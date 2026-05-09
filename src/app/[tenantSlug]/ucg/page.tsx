import { redirect } from "next/navigation";
import Link from "next/link";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import UcgChatClient from "./UcgChatClient";

export default async function UCGPage({
  params,
}: {
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");

  const fcg = await superDb.firmCultureGuide.findFirst({
    where: { tenantId: ctx.tenant.id, status: "COMMITTED" },
    orderBy: { version: "desc" },
  });
  if (!fcg) {
    return (
      <div className="card">
        <h1 className="text-2xl font-semibold tracking-tight">My Culture Guide</h1>
        <p className="mt-2 text-sm text-ink/70">
          The Firm Culture Team hasn&apos;t committed an FCG yet. Once they do, you&apos;ll be able to
          draft a UCG that personalises (but never relaxes) it.
        </p>
        <Link href={`/${tenantSlug}/fcg/chat`} className="btn btn-primary mt-3 inline-flex">
          Help draft the FCG
        </Link>
      </div>
    );
  }

  const ucg = await superDb.userCultureGuide.findFirst({
    where: { tenantId: ctx.tenant.id, membershipId: ctx.membership.id, status: { not: "SUPERSEDED" } },
    orderBy: { version: "desc" },
    include: {
      rules: true,
      rulings: true,
      chatTurns: { orderBy: { createdAt: "asc" } },
    },
  });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">My Culture Guide</h1>
      <div className="text-sm text-ink/70">
        Based on FCG <span className="tag">v{fcg.version}</span>. Talk to Claude to add or refine
        rules. The Compliance Judge runs before commit.
      </div>

      <UcgChatClient
        tenantSlug={tenantSlug}
        ucgId={ucg?.id}
        initialTurns={ucg?.chatTurns.map((t) => ({ role: t.role, content: t.content })) ?? []}
        initialRules={ucg?.rules ?? []}
        initialRulings={ucg?.rulings ?? []}
        judgeStatus={ucg?.judgeStatus ?? null}
        ucgStatus={ucg?.status ?? null}
      />
    </div>
  );
}
