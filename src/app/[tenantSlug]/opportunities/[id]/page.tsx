import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import { hasPermission } from "@/lib/rbac";
import { decideOpportunity, addOpportunityComment, type DecisionKind } from "@/lib/opportunities/decide";

const STATUS_BG: Record<string, string> = {
  NEW: "bg-sky-100 text-sky-800",
  UNDER_REVIEW: "bg-amber-100 text-amber-800",
  ACCEPTED: "bg-emerald-100 text-emerald-800",
  REVISED: "bg-emerald-100 text-emerald-800",
  REJECTED: "bg-red-100 text-red-700",
  ROUTED_TO_PARTNER: "bg-violet-100 text-violet-800",
};

const CLASS_OPTIONS = [
  "new_engagement",
  "expansion",
  "renewal",
  "cross_sell",
  "referral",
] as const;

export default async function OpportunityDetailPage({
  params,
}: {
  params: Promise<{ tenantSlug: string; id: string }>;
}) {
  const { tenantSlug, id } = await params;
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");

  const candidate = await superDb.opportunityCandidate.findFirst({
    where: { id, tenantId: ctx.tenant.id },
    include: {
      sourceMessage: true,
      reviewer: { include: { user: { select: { email: true, name: true } } } },
      decidedBy: { include: { user: { select: { email: true, name: true } } } },
      comments: {
        orderBy: { createdAt: "asc" },
        include: { author: { include: { user: { select: { email: true, name: true } } } } },
      },
    },
  });
  if (!candidate) notFound();

  const canReview = hasPermission(ctx.membership.role, "opportunity:review");
  const decided = !!candidate.decidedAt;

  const reviewerOptions = await superDb.membership.findMany({
    where: {
      tenantId: ctx.tenant.id,
      status: "ACTIVE",
      role: { in: ["SALES_REVIEWER", "FIRM_ADMIN"] },
    },
    include: { user: { select: { email: true, name: true } } },
    orderBy: { joinedAt: "asc" },
  });

  async function decideAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (!hasPermission(inner.membership.role, "opportunity:review")) throw new Error("forbidden");

    const kind = String(formData.get("kind") ?? "") as DecisionKind;
    if (!["accept", "revise", "reject", "routeToPartner"].includes(kind)) {
      throw new Error("invalid decision kind");
    }

    const reviewerMembershipId = (formData.get("reviewerMembershipId") as string | null)?.trim() || null;
    const partnerType = (formData.get("partnerType") as "DEFAULT" | "CLIENT" | "THIRD_PARTY" | null) ?? "DEFAULT";

    await decideOpportunity({
      tenantId: inner.tenant.id,
      candidateId: id,
      actorMembershipId: inner.membership.id,
      kind,
      reviewerMembershipId,
      revisedJurisdiction:
        kind === "revise" ? ((formData.get("revisedJurisdiction") as string) || null) : null,
      revisedServiceLine:
        kind === "revise" ? ((formData.get("revisedServiceLine") as string) || null) : null,
      revisedClassification:
        kind === "revise" ? ((formData.get("revisedClassification") as string) || null) : null,
      partnerType: kind === "routeToPartner" ? partnerType : undefined,
      reason: (formData.get("reason") as string | null) ?? null,
    });

    revalidatePath(`/${tenantSlug}/opportunities`);
    revalidatePath(`/${tenantSlug}/opportunities/${id}`);
  }

  async function commentAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (!hasPermission(inner.membership.role, "opportunity:review")) throw new Error("forbidden");

    const body = String(formData.get("body") ?? "").trim();
    if (!body) return;
    await addOpportunityComment({
      tenantId: inner.tenant.id,
      candidateId: id,
      actorMembershipId: inner.membership.id,
      body,
    });
    revalidatePath(`/${tenantSlug}/opportunities/${id}`);
  }

  const signalQuotes = (candidate.signalQuotes as string[] | null) ?? [];

  return (
    <div className="space-y-4">
      <Link
        href={`/${tenantSlug}/opportunities`}
        className="text-xs text-ink/60 underline decoration-dotted"
      >
        ← back to candidates
      </Link>

      <div className="card space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className={`tag ${STATUS_BG[candidate.status] ?? ""}`}>{candidate.status}</span>
            {candidate.classification && (
              <span className="tag bg-ink/5">{candidate.classification.replace("_", " ")}</span>
            )}
            {candidate.jurisdiction && (
              <span className="text-sm text-ink/70">{candidate.jurisdiction}</span>
            )}
            {candidate.serviceLine && (
              <span className="text-sm text-ink/70">· {candidate.serviceLine}</span>
            )}
            {candidate.confidence != null && (
              <span className="text-xs text-ink/50 tabular-nums">
                {Math.round(candidate.confidence * 100)}% confidence
              </span>
            )}
          </div>
          <div className="text-xs text-ink/50">
            detected {candidate.createdAt.toISOString().slice(0, 16).replace("T", " ")}
          </div>
        </div>

        {candidate.suggestedReviewerTeam && (
          <div className="text-xs text-ink/60">
            suggested team:{" "}
            <span className="font-medium">{candidate.suggestedReviewerTeam}</span>
          </div>
        )}

        {candidate.rationale && (
          <div>
            <div className="text-xs uppercase tracking-wider text-ink/50">Rationale</div>
            <p className="mt-1 text-sm">{candidate.rationale}</p>
          </div>
        )}

        {signalQuotes.length > 0 && (
          <div>
            <div className="text-xs uppercase tracking-wider text-ink/50">Signal quotes</div>
            <ul className="mt-1 space-y-1 text-sm">
              {signalQuotes.map((q, i) => (
                <li key={i} className="rounded bg-ink/5 p-2 italic text-ink/80">
                  &ldquo;{q}&rdquo;
                </li>
              ))}
            </ul>
          </div>
        )}

        {decided && (
          <div className="rounded border border-ink/10 bg-ink/5 p-2 text-xs">
            Decided {candidate.decidedAt!.toISOString().slice(0, 16).replace("T", " ")}{" "}
            by {candidate.decidedBy?.user.name ?? candidate.decidedBy?.user.email ?? "—"}
            {candidate.decisionReason && (
              <div className="mt-1 text-ink/70">{candidate.decisionReason}</div>
            )}
            {candidate.routeNotes && candidate.routeNotes !== candidate.decisionReason && (
              <div className="mt-1 text-ink/70">route notes: {candidate.routeNotes}</div>
            )}
            {candidate.partnerType !== "DEFAULT" && candidate.status === "ROUTED_TO_PARTNER" && (
              <div className="mt-1">
                partner type: <strong>{candidate.partnerType}</strong>
              </div>
            )}
          </div>
        )}
      </div>

      {candidate.sourceMessage && (
        <div className="card space-y-2">
          <div className="text-xs uppercase tracking-wider text-ink/50">Source inbound</div>
          <div className="text-sm">
            {candidate.sourceMessage.sender && <>from {candidate.sourceMessage.sender} · </>}
            <span className="font-medium">
              {candidate.sourceMessage.subject ?? "(no subject)"}
            </span>
          </div>
          <pre className="whitespace-pre-wrap rounded bg-ink/5 p-3 text-xs text-ink/70">
            {candidate.sourceMessage.body}
          </pre>
        </div>
      )}

      {!decided && canReview && (
        <DecideForm
          candidateStatus={candidate.status}
          reviewerOptions={reviewerOptions.map((m) => ({
            id: m.id,
            label: m.user.name ?? m.user.email,
            role: m.role,
          }))}
          action={decideAction}
        />
      )}

      <div className="card space-y-3">
        <h2 className="text-base font-medium">Discussion</h2>
        {candidate.comments.length === 0 ? (
          <p className="text-xs text-ink/50">No comments yet.</p>
        ) : (
          <ul className="space-y-2">
            {candidate.comments.map((c) => (
              <li key={c.id} className="rounded border border-ink/10 p-2 text-sm">
                <div className="text-xs text-ink/50">
                  {c.author.user.name ?? c.author.user.email} ·{" "}
                  {c.createdAt.toISOString().slice(0, 16).replace("T", " ")}
                </div>
                <p className="mt-1 whitespace-pre-wrap">{c.body}</p>
              </li>
            ))}
          </ul>
        )}

        {canReview && (
          <form action={commentAction} className="space-y-2">
            <textarea
              name="body"
              rows={3}
              className="input"
              placeholder="Add a comment (e.g. context, why you're rejecting, who else to loop in)…"
              maxLength={4000}
              required
            />
            <button type="submit" className="btn text-xs">
              Post comment
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

function DecideForm({
  candidateStatus,
  reviewerOptions,
  action,
}: {
  candidateStatus: string;
  reviewerOptions: { id: string; label: string; role: string }[];
  action: (formData: FormData) => Promise<void>;
}) {
  return (
    <form action={action} className="card space-y-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-base font-medium">Decide</h2>
        <span className="text-xs text-ink/50">current: {candidateStatus}</span>
      </div>

      <fieldset className="space-y-1 text-sm">
        <legend className="text-xs uppercase tracking-wider text-ink/50">Action</legend>
        <label className="flex items-center gap-2">
          <input type="radio" name="kind" value="accept" defaultChecked />
          <strong>Accept</strong> — allocate to a Sales Reviewer for follow-up
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" name="kind" value="revise" />
          <strong>Revise</strong> — correct the classification and re-route
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" name="kind" value="reject" />
          <strong>Reject</strong> — false positive, not pursuing
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" name="kind" value="routeToPartner" />
          <strong>Route to Partner</strong> — outside firm scope (default Partner = Acumon Intelligence)
        </label>
      </fieldset>

      <div>
        <label className="label">Reviewer / allocation target</label>
        <select name="reviewerMembershipId" className="input" defaultValue="">
          <option value="">— select —</option>
          {reviewerOptions.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label} ({m.role})
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-ink/50">
          Required for Accept and Revise. Optional for Route to Partner; ignored for Reject.
        </p>
      </div>

      <details className="rounded border border-ink/10 p-3 text-sm">
        <summary className="cursor-pointer text-xs uppercase tracking-wider text-ink/50">
          Revise — corrected fields (only used for Revise)
        </summary>
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          <div>
            <label className="label">Jurisdiction</label>
            <input className="input" name="revisedJurisdiction" maxLength={60} />
          </div>
          <div>
            <label className="label">Service line</label>
            <input className="input" name="revisedServiceLine" maxLength={120} />
          </div>
          <div>
            <label className="label">Classification</label>
            <select className="input" name="revisedClassification" defaultValue="">
              <option value="">— keep —</option>
              {CLASS_OPTIONS.map((c) => (
                <option key={c} value={c}>
                  {c.replace("_", " ")}
                </option>
              ))}
            </select>
          </div>
        </div>
      </details>

      <details className="rounded border border-ink/10 p-3 text-sm">
        <summary className="cursor-pointer text-xs uppercase tracking-wider text-ink/50">
          Route to Partner — partner type
        </summary>
        <fieldset className="mt-2 space-y-1">
          <label className="flex items-center gap-2">
            <input type="radio" name="partnerType" value="DEFAULT" defaultChecked />
            Default — Acumon Intelligence (PRD §8.3 — discounted)
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="partnerType" value="CLIENT" />
            Client — the firm itself (included)
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="partnerType" value="THIRD_PARTY" />
            Third party — requires configuration fee + ongoing surcharge
          </label>
        </fieldset>
      </details>

      <div>
        <label className="label">Reason / notes</label>
        <textarea
          name="reason"
          rows={2}
          className="input"
          maxLength={2000}
          placeholder="Why this decision (optional but recommended for Reject and Route to Partner)"
        />
      </div>

      <button type="submit" className="btn btn-primary text-sm">
        Record decision
      </button>
    </form>
  );
}
