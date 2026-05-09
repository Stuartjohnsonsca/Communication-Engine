import Link from "next/link";
import { redirect } from "next/navigation";
import { getTenantContext } from "@/lib/tenant";
import { hasPermission } from "@/lib/rbac";
import { listScans } from "@/lib/culture-scan";
import { superDb } from "@/lib/db";
import { ALL_KINDS } from "@/lib/channels/registry";
import ScanClient from "./ScanClient";

export default async function ScanPage({
  params,
}: {
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");
  if (!hasPermission(ctx.membership.role, "fcg:scan:read")) redirect(`/${tenantSlug}`);

  const [scans, dpia, channels, fctCount] = await Promise.all([
    listScans(ctx.tenant.id),
    superDb.dPIAAttestation.findFirst({
      where: { tenantId: ctx.tenant.id },
      orderBy: { createdAt: "desc" },
    }),
    superDb.channel.findMany({
      where: { tenantId: ctx.tenant.id, status: "ACTIVE" },
      select: { kind: true, dpiaApproved: true },
    }),
    superDb.membership.count({
      where: {
        tenantId: ctx.tenant.id,
        status: "ACTIVE",
        role: { in: ["FCT_MEMBER", "FIRM_ADMIN"] },
      },
    }),
  ]);

  const canRun = hasPermission(ctx.membership.role, "fcg:scan:run");
  const channelKinds = Array.from(new Set(channels.map((c) => c.kind)));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Firm Culture Scan</h1>
          <p className="mt-1 text-sm text-ink/60">
            PRD §5.1.1 — bounded scan over Firm Culture Team communications, produces a draft FCG
            for the FCT to review and run through the §6 quorum vote.
          </p>
        </div>
        <Link href={`/${tenantSlug}/fcg`} className="btn">
          Back to FCG
        </Link>
      </div>

      <ScanClient
        tenantSlug={tenantSlug}
        canRun={canRun}
        hasDpia={!!dpia}
        fctCount={fctCount}
        availableChannelKinds={channelKinds}
        allChannelKinds={ALL_KINDS.map((k) => ({ kind: k.kind, label: k.label }))}
        initialScans={scans.map((s) => ({
          id: s.id,
          status: s.status,
          dateRangeFrom: s.dateRangeFrom.toISOString(),
          dateRangeTo: s.dateRangeTo.toISOString(),
          channelKinds: (s.channelKinds as unknown as string[]) ?? [],
          messagesAnalysed: s.messagesAnalysed,
          proposalId: s.proposalId,
          errorMessage: s.errorMessage,
          createdAt: s.createdAt.toISOString(),
          completedAt: s.completedAt?.toISOString() ?? null,
          initiatedByEmail: s.initiatedBy.user.email,
        }))}
      />
    </div>
  );
}
