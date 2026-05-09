import { redirect } from "next/navigation";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import WizardClient from "./WizardClient";

export default async function WizardPage({
  params,
}: {
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");

  const committed = await superDb.firmCultureGuide.findFirst({
    where: { tenantId: ctx.tenant.id, status: "COMMITTED" },
    include: { rules: true },
    orderBy: { version: "desc" },
  });

  // Reuse an in-progress wizard proposal if one exists, otherwise the chat
  // route will create a fresh one on first turn.
  const drafting = await superDb.fCGProposal.findFirst({
    where: { tenantId: ctx.tenant.id, state: "DRAFTING", proposedById: ctx.membership.id },
    orderBy: { updatedAt: "desc" },
  });

  return (
    <WizardClient
      tenantSlug={tenantSlug}
      initialProposalId={drafting?.id}
      initialOps={
        ((drafting?.diff as { ops?: unknown[] } | null)?.ops ?? []) as { tool: string; input: Record<string, unknown> }[]
      }
      committedVersion={committed?.version ?? null}
      committedRuleCount={committed?.rules.length ?? 0}
    />
  );
}
