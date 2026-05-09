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

  // The conflict belongs to whichever UCG is still in CONFLICTED state — that
  // may or may not be the latest version. If the user has already opened a
  // new DRAFT to resolve it, we still want to show the banner so they
  // remember why they're editing.
  const conflictedUcg = await superDb.userCultureGuide.findFirst({
    where: { tenantId: ctx.tenant.id, membershipId: ctx.membership.id, status: "CONFLICTED" },
    orderBy: { version: "desc" },
    include: { rules: { select: { suspendedAt: true } } },
  });
  const conflictFcg =
    conflictedUcg?.conflictedSinceFcgId
      ? await superDb.firmCultureGuide.findUnique({
          where: { id: conflictedUcg.conflictedSinceFcgId },
          select: { version: true },
        })
      : null;

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">My Culture Guide</h1>
      <div className="text-sm text-ink/70">
        Based on FCG <span className="tag">v{fcg.version}</span>. Talk to Claude to add or refine
        rules. The Compliance Judge runs before commit.
      </div>

      {conflictedUcg && (
        <ConflictBanner
          newFcgVersion={conflictFcg?.version ?? null}
          gracePeriodEndsAt={conflictedUcg.gracePeriodEndsAt}
          conflictAutoSuspendedAt={conflictedUcg.conflictAutoSuspendedAt}
          suspendedRuleCount={conflictedUcg.rules.filter((r) => r.suspendedAt).length}
        />
      )}

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

function ConflictBanner({
  newFcgVersion,
  gracePeriodEndsAt,
  conflictAutoSuspendedAt,
  suspendedRuleCount,
}: {
  newFcgVersion: number | null;
  gracePeriodEndsAt: Date | null;
  conflictAutoSuspendedAt: Date | null;
  suspendedRuleCount: number;
}) {
  if (conflictAutoSuspendedAt) {
    return (
      <div className="card border-red-300 bg-red-50">
        <div className="text-sm font-medium text-red-900">
          Grace period elapsed — {suspendedRuleCount} rule{suspendedRuleCount === 1 ? "" : "s"} auto-suspended.
        </div>
        <p className="mt-1 text-xs text-red-800">
          Your UCG conflicted with FCG v{newFcgVersion ?? "?"} and the {/* */}
          {gracePeriodEndsAt ? formatWhen(gracePeriodEndsAt) : "10 working day"} grace period
          elapsed without a clean recommit. Edit the suspended rules below and recommit to
          restore them.
        </p>
      </div>
    );
  }
  if (!gracePeriodEndsAt) return null;
  const msLeft = gracePeriodEndsAt.getTime() - Date.now();
  const daysLeft = Math.max(0, Math.ceil(msLeft / (1000 * 60 * 60 * 24)));
  return (
    <div className="card border-amber-300 bg-amber-50">
      <div className="text-sm font-medium text-amber-900">
        FCG v{newFcgVersion ?? "?"} committed — your UCG needs review.
      </div>
      <p className="mt-1 text-xs text-amber-800">
        You have <strong>{daysLeft}</strong> calendar day{daysLeft === 1 ? "" : "s"} (until{" "}
        {formatWhen(gracePeriodEndsAt)}) to address conflicts. After that, conflicting rules
        will auto-suspend per PRD §5.2.2. Edit the rules below, run the Judge against the new
        FCG, and commit.
      </p>
    </div>
  );
}

function formatWhen(d: Date) {
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}
