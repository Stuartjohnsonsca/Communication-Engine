import { redirect } from "next/navigation";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import FcgChatClient from "./FcgChatClient";

export default async function FcgChatPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenantSlug: string }>;
  searchParams: Promise<{ proposal?: string }>;
}) {
  const { tenantSlug } = await params;
  const sp = await searchParams;
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");

  let initial: { proposalId?: string; turns: { role: string; content: string }[] } = { turns: [] };
  if (sp.proposal) {
    const turns = await superDb.fCGChatTurn.findMany({
      where: { proposalId: sp.proposal, tenantId: ctx.tenant.id },
      orderBy: { createdAt: "asc" },
      select: { role: true, content: true },
    });
    initial = { proposalId: sp.proposal, turns };
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">FCG drafting chat</h1>
      <p className="text-sm text-ink/70">
        Ask Claude to draft, refine, or remove rules. Tool calls are staged into a proposal that the
        Firm Culture Team will then vote on. Nothing here commits the FCG.
      </p>
      <FcgChatClient
        tenantSlug={tenantSlug}
        initialProposalId={initial.proposalId}
        initialTurns={initial.turns}
      />
    </div>
  );
}
