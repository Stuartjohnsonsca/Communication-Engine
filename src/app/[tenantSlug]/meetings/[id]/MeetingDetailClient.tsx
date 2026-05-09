"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export type AgendaItem = {
  item: string;
  durationMin?: number | null;
  owner?: string | null;
};

export type MeetingDetail = {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  startsAt: string;
  durationMin: number;
  leadTimeWorkingDays: number;
  shortNotice: boolean;
  paperStatus: "NONE" | "DRAFTED" | "EDITED" | "ISSUED";
  paperBody: string | null;
  agenda: AgendaItem[];
  openQuestions: string[];
  paperGeneratedAt: string | null;
  paperIssuedAt: string | null;
  paperFcgVersionUsed: number | null;
  paperAuthorName: string;
  creatorName: string;
  canActOnPaper: boolean;
  participants: {
    id: string;
    name: string;
    email: string | null;
    isExternal: boolean;
    isMeetingCreator: boolean;
  }[];
};

const STATUS_BADGE: Record<MeetingDetail["paperStatus"], string> = {
  NONE: "bg-ink/10 text-ink/60",
  DRAFTED: "bg-sky-100 text-sky-800",
  EDITED: "bg-amber-100 text-amber-800",
  ISSUED: "bg-emerald-100 text-emerald-800",
};

const STATUS_LABEL: Record<MeetingDetail["paperStatus"], string> = {
  NONE: "no paper",
  DRAFTED: "drafted",
  EDITED: "drafted (edited)",
  ISSUED: "issued",
};

export default function MeetingDetailClient({
  tenantSlug,
  meeting,
}: {
  tenantSlug: string;
  meeting: MeetingDetail;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [paperBody, setPaperBody] = useState(meeting.paperBody ?? "");

  const isIssued = meeting.paperStatus === "ISSUED";
  const hasPaper = meeting.paperStatus !== "NONE";
  const dirty = paperBody !== (meeting.paperBody ?? "");

  function generate() {
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/meetings/${meeting.id}/paper`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenantSlug }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(typeof data.error === "string" ? data.error : `Generation failed: ${res.statusText}`);
        return;
      }
      router.refresh();
    });
  }

  function savePaper() {
    if (!dirty) {
      setEditing(false);
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/meetings/${meeting.id}/paper`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenantSlug, paperBody }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(typeof data.error === "string" ? data.error : `Save failed: ${res.statusText}`);
        return;
      }
      setEditing(false);
      router.refresh();
    });
  }

  function issue() {
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/meetings/${meeting.id}/issue`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenantSlug }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(typeof data.error === "string" ? data.error : `Issue failed: ${res.statusText}`);
        return;
      }
      router.refresh();
    });
  }

  const startsAtLabel = meeting.startsAt.slice(0, 16).replace("T", " ");
  const externalCount = meeting.participants.filter((p) => p.isExternal).length;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <Link
            href={`/${tenantSlug}/meetings`}
            className="text-xs text-ink/60 underline decoration-dotted"
          >
            ← All meetings
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">{meeting.title}</h1>
          <div className="mt-1 flex flex-wrap gap-2 text-xs text-ink/60">
            <span className={`tag ${STATUS_BADGE[meeting.paperStatus]}`}>
              {STATUS_LABEL[meeting.paperStatus]}
            </span>
            <span>{startsAtLabel}</span>
            <span>· {meeting.durationMin} min</span>
            {meeting.location && <span>· {meeting.location}</span>}
            <span>
              · paper-author {meeting.paperAuthorName}
              {meeting.paperAuthorName !== meeting.creatorName &&
                ` (creator ${meeting.creatorName})`}
            </span>
            {meeting.shortNotice && (
              <span className="tag bg-amber-100">
                short notice (lead {meeting.leadTimeWorkingDays} working days)
              </span>
            )}
            {externalCount > 0 && (
              <span className="tag bg-violet-100">{externalCount} external</span>
            )}
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap justify-end gap-2">
          {!hasPaper && meeting.canActOnPaper && (
            <button className="btn btn-primary" onClick={generate} disabled={pending}>
              {pending ? "Drafting…" : "Generate paper"}
            </button>
          )}
          {hasPaper && !isIssued && meeting.canActOnPaper && !editing && (
            <>
              <button className="btn" onClick={() => setEditing(true)} disabled={pending}>
                Edit
              </button>
              <button className="btn" onClick={generate} disabled={pending}>
                {pending ? "…" : "Regenerate"}
              </button>
              <button className="btn btn-primary" onClick={issue} disabled={pending}>
                {pending ? "…" : "Mark issued"}
              </button>
            </>
          )}
          {!meeting.canActOnPaper && (
            <span className="text-xs text-ink/60">
              Only the paper-author can act on this paper.
            </span>
          )}
        </div>
      </div>

      {error && (
        <div className="card border-red-300">
          <p className="text-sm text-red-600">{error}</p>
        </div>
      )}

      {meeting.shortNotice && hasPaper && (
        <div className="card border-amber-300 bg-amber-50/60 text-sm">
          This meeting is scheduled inside the FCG-defined lead time of{" "}
          {meeting.leadTimeWorkingDays} working days. The paper is being circulated short
          notice — the audit trail records this so the FCT can review proportionality.
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <div className="space-y-4">
          <div className="card space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-medium">Discussion paper</h2>
              {meeting.paperFcgVersionUsed != null && (
                <span className="text-xs text-ink/50">
                  FCG v{meeting.paperFcgVersionUsed}
                  {meeting.paperGeneratedAt && (
                    <> · drafted {meeting.paperGeneratedAt.slice(0, 16).replace("T", " ")}</>
                  )}
                  {meeting.paperIssuedAt && (
                    <> · issued {meeting.paperIssuedAt.slice(0, 16).replace("T", " ")}</>
                  )}
                </span>
              )}
            </div>

            {!hasPaper && (
              <p className="text-sm text-ink/60">
                No paper yet. Click <em>Generate paper</em> to draft an agenda and discussion
                paper grounded in the description and the firm&rsquo;s FCG.
              </p>
            )}

            {hasPaper && editing && (
              <>
                <textarea
                  className="input font-mono"
                  rows={24}
                  value={paperBody}
                  onChange={(e) => setPaperBody(e.target.value)}
                />
                <div className="flex gap-2">
                  <button
                    className="btn btn-primary"
                    onClick={savePaper}
                    disabled={pending || !dirty}
                  >
                    {pending ? "Saving…" : "Save"}
                  </button>
                  <button
                    className="btn"
                    onClick={() => {
                      setEditing(false);
                      setPaperBody(meeting.paperBody ?? "");
                    }}
                    disabled={pending}
                  >
                    Cancel
                  </button>
                </div>
              </>
            )}

            {hasPaper && !editing && meeting.paperBody && (
              <pre className="whitespace-pre-wrap rounded bg-ink/5 p-3 text-sm">
                {meeting.paperBody}
              </pre>
            )}
          </div>

          {hasPaper && meeting.agenda.length > 0 && (
            <div className="card">
              <h2 className="text-base font-medium">Agenda</h2>
              <ol className="mt-2 space-y-1 text-sm">
                {meeting.agenda.map((a, i) => (
                  <li key={i} className="flex items-baseline justify-between gap-3 border-b border-ink/5 py-1 last:border-0">
                    <span>
                      <span className="text-ink/40 mr-2 tabular-nums">{i + 1}.</span>
                      {a.item}
                    </span>
                    <span className="shrink-0 text-xs text-ink/50">
                      {a.durationMin && <>{a.durationMin} min</>}
                      {a.owner && <> · {a.owner}</>}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          )}

          {hasPaper && meeting.openQuestions.length > 0 && (
            <div className="card">
              <h2 className="text-base font-medium">Open questions</h2>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
                {meeting.openQuestions.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="space-y-4">
          <div className="card">
            <h2 className="text-base font-medium">Description</h2>
            {meeting.description ? (
              <p className="mt-2 whitespace-pre-wrap text-sm text-ink/80">{meeting.description}</p>
            ) : (
              <p className="mt-2 text-sm text-ink/50">No description provided.</p>
            )}
          </div>

          <div className="card">
            <h2 className="text-base font-medium">
              Participants ({meeting.participants.length})
            </h2>
            <ul className="mt-2 space-y-1 text-sm">
              {meeting.participants.map((p) => (
                <li key={p.id} className="flex items-baseline justify-between gap-2">
                  <span>
                    {p.name}
                    {p.email && <span className="text-ink/50"> &lt;{p.email}&gt;</span>}
                  </span>
                  <span className="shrink-0">
                    {p.isMeetingCreator && <span className="tag mr-1">creator</span>}
                    {p.isExternal ? (
                      <span className="tag bg-violet-100">external</span>
                    ) : (
                      <span className="tag">internal</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
