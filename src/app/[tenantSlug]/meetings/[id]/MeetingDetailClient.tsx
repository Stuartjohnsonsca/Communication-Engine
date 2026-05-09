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
  chairName: string | null;
  canActOnPaper: boolean;
  canEditRecord: boolean;
  canChairApprove: boolean;
  participants: {
    id: string;
    name: string;
    email: string | null;
    isExternal: boolean;
    isMeetingCreator: boolean;
    noteTakingOptedOut: boolean;
    noteTakingOptedOutAt: string | null;
  }[];
  noteTaking: {
    disclosedAt: string | null;
    blocked: boolean;
    blockReason: string | null;
  };
  transcript: {
    source: "TEAMS" | "ZOOM" | "MEET" | "MANUAL";
    ingestedAt: string | null;
    bytes: number;
    excerpt: string;
  } | null;
  summary: {
    status: "DRAFTED" | "EDITED" | "APPROVED" | "CIRCULATED";
    body: string;
    generatedAt: string;
    approvedAt: string | null;
    fcgVersionUsed: number | null;
  } | null;
  minutes: {
    status: "DRAFTED" | "EDITED" | "APPROVED" | "CIRCULATED";
    body: string;
    generatedAt: string;
    approvedAt: string | null;
    circulatedAt: string | null;
    fcgVersionUsed: number | null;
  } | null;
};

const RECORD_STATUS_BADGE: Record<"DRAFTED" | "EDITED" | "APPROVED" | "CIRCULATED", string> = {
  DRAFTED: "bg-sky-100 text-sky-800",
  EDITED: "bg-amber-100 text-amber-800",
  APPROVED: "bg-emerald-100 text-emerald-800",
  CIRCULATED: "bg-violet-100 text-violet-800",
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
                <li key={p.id} className="flex flex-wrap items-baseline justify-between gap-2">
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
                    {p.noteTakingOptedOut && (
                      <span className="tag ml-1 bg-red-100 text-red-800">opted out</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      <NotesAndMinutes tenantSlug={tenantSlug} meeting={meeting} />
    </div>
  );
}

function NotesAndMinutes({
  tenantSlug,
  meeting,
}: {
  tenantSlug: string;
  meeting: MeetingDetail;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [transcriptBody, setTranscriptBody] = useState("");
  const [transcriptSource, setTranscriptSource] =
    useState<"TEAMS" | "ZOOM" | "MEET" | "MANUAL">("MANUAL");
  const [optOutId, setOptOutId] = useState<string>("");
  const [optOutReason, setOptOutReason] = useState("");
  const [editKind, setEditKind] = useState<"SUMMARY" | "MINUTES" | null>(null);
  const [editBody, setEditBody] = useState("");

  const startsAtMs = new Date(meeting.startsAt).getTime();
  const endsAtMs = startsAtMs + meeting.durationMin * 60_000;
  const meetingHasEnded = Date.now() >= endsAtMs;

  const eligibleOptOuts = meeting.participants.filter((p) => !p.noteTakingOptedOut);
  const blocked = meeting.noteTaking.blocked;

  function call(url: string, init: { method: string; body?: Record<string, unknown> }) {
    setError(null);
    startTransition(async () => {
      const res = await fetch(url, {
        method: init.method,
        headers: { "content-type": "application/json" },
        body: init.body ? JSON.stringify(init.body) : undefined,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(typeof data.error === "string" ? data.error : `Failed: ${res.statusText}`);
        return;
      }
      router.refresh();
    });
  }

  function disclose() {
    call(`/api/meetings/${meeting.id}/disclose`, {
      method: "POST",
      body: { tenantSlug },
    });
  }

  function recordOptOut() {
    if (!optOutId) {
      setError("Pick a participant to record an opt-out for.");
      return;
    }
    call(`/api/meetings/${meeting.id}/opt-out`, {
      method: "POST",
      body: { tenantSlug, participantId: optOutId, reason: optOutReason || null },
    });
    setOptOutId("");
    setOptOutReason("");
  }

  function ingestTranscript() {
    if (!transcriptBody.trim()) {
      setError("Paste the transcript before ingesting.");
      return;
    }
    call(`/api/meetings/${meeting.id}/transcript`, {
      method: "POST",
      body: { tenantSlug, source: transcriptSource, body: transcriptBody },
    });
    setTranscriptBody("");
  }

  function generateRecord(kind: "SUMMARY" | "MINUTES") {
    call(`/api/meetings/${meeting.id}/record`, {
      method: "POST",
      body: { tenantSlug, kind },
    });
  }

  function startEdit(kind: "SUMMARY" | "MINUTES") {
    const r = kind === "SUMMARY" ? meeting.summary : meeting.minutes;
    setEditKind(kind);
    setEditBody(r?.body ?? "");
  }

  function saveEdit() {
    if (!editKind) return;
    call(`/api/meetings/${meeting.id}/record`, {
      method: "PATCH",
      body: { tenantSlug, kind: editKind, body: editBody },
    });
    setEditKind(null);
  }

  function approve(kind: "SUMMARY" | "MINUTES") {
    call(`/api/meetings/${meeting.id}/record`, {
      method: "PUT",
      body: { tenantSlug, kind, action: "approve" },
    });
  }

  function circulate() {
    call(`/api/meetings/${meeting.id}/record`, {
      method: "PUT",
      body: { tenantSlug, kind: "MINUTES", action: "circulate" },
    });
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Notes and Minutes</h2>
        <p className="mt-1 text-sm text-ink/70">
          Pre-meeting disclosure, transcript ingestion, and post-meeting Summary / Formal
          Minutes — drafted from the transcript and routed to the Chair for approval before
          circulation. <span className="text-ink/50">PRD §7.5.</span>
        </p>
      </div>

      {error && (
        <div className="card border-red-300">
          <p className="text-sm text-red-600">{error}</p>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-medium">Pre-meeting disclosure</h3>
            {meeting.noteTaking.disclosedAt ? (
              <span className="tag bg-emerald-100 text-emerald-800">disclosed</span>
            ) : (
              <span className="tag bg-ink/10 text-ink/60">not yet</span>
            )}
          </div>
          {meeting.noteTaking.disclosedAt ? (
            <p className="text-xs text-ink/60">
              Sent {meeting.noteTaking.disclosedAt.slice(0, 16).replace("T", " ")}.
            </p>
          ) : (
            <p className="text-xs text-ink/60">
              Tell participants AI-assisted note-taking will be used. External participants
              must be given the chance to opt out before joining.
            </p>
          )}
          {meeting.canEditRecord && !meeting.noteTaking.disclosedAt && (
            <button className="btn" onClick={disclose} disabled={pending}>
              {pending ? "…" : "Mark disclosure sent"}
            </button>
          )}
          <hr className="border-ink/10" />
          <div className="space-y-2">
            <h4 className="text-sm font-medium">Record an opt-out</h4>
            {blocked && (
              <p className="text-xs text-amber-700">
                Note-taking is currently blocked for this meeting. Reason:{" "}
                {meeting.noteTaking.blockReason ?? "—"}.
              </p>
            )}
            {eligibleOptOuts.length === 0 ? (
              <p className="text-xs text-ink/60">No participants eligible to opt out.</p>
            ) : (
              <>
                <select
                  className="input"
                  value={optOutId}
                  onChange={(e) => setOptOutId(e.target.value)}
                  disabled={pending || !meeting.canEditRecord}
                >
                  <option value="">— pick participant —</option>
                  {eligibleOptOuts.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                      {p.isExternal ? " (external)" : ""}
                    </option>
                  ))}
                </select>
                <input
                  className="input"
                  placeholder="Optional reason"
                  value={optOutReason}
                  onChange={(e) => setOptOutReason(e.target.value)}
                  disabled={pending || !meeting.canEditRecord}
                />
                <button
                  className="btn"
                  onClick={recordOptOut}
                  disabled={pending || !meeting.canEditRecord || !optOutId}
                >
                  Record opt-out
                </button>
              </>
            )}
          </div>
        </div>

        <div className="card space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-medium">Transcript</h3>
            {meeting.transcript ? (
              <span className="tag bg-emerald-100 text-emerald-800">
                {meeting.transcript.source.toLowerCase()}
              </span>
            ) : blocked ? (
              <span className="tag bg-red-100 text-red-800">blocked</span>
            ) : (
              <span className="tag bg-ink/10 text-ink/60">not yet</span>
            )}
          </div>
          {meeting.transcript ? (
            <>
              <p className="text-xs text-ink/60">
                Ingested{" "}
                {meeting.transcript.ingestedAt?.slice(0, 16).replace("T", " ") ?? "—"} ·{" "}
                {Math.round(meeting.transcript.bytes / 1024)} KB
              </p>
              <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap rounded bg-ink/5 p-2 text-xs">
                {meeting.transcript.excerpt}
                {meeting.transcript.bytes > meeting.transcript.excerpt.length && "…"}
              </pre>
            </>
          ) : blocked ? (
            <p className="text-xs text-ink/60">
              Transcript ingestion is disabled because a participant opted out of AI-assisted
              note-taking.
            </p>
          ) : !meetingHasEnded ? (
            <p className="text-xs text-ink/60">
              The meeting hasn&apos;t ended yet — paste the transcript here once it&apos;s
              available.
            </p>
          ) : null}
          {!blocked && meeting.canEditRecord && (
            <>
              <select
                className="input"
                value={transcriptSource}
                onChange={(e) =>
                  setTranscriptSource(e.target.value as "TEAMS" | "ZOOM" | "MEET" | "MANUAL")
                }
                disabled={pending}
              >
                <option value="MANUAL">Pasted manually</option>
                <option value="TEAMS">Microsoft Teams</option>
                <option value="ZOOM">Zoom</option>
                <option value="MEET">Google Meet</option>
              </select>
              <textarea
                className="input font-mono"
                rows={6}
                placeholder="Paste the transcript here…"
                value={transcriptBody}
                onChange={(e) => setTranscriptBody(e.target.value)}
                disabled={pending}
              />
              <button
                className="btn btn-primary"
                onClick={ingestTranscript}
                disabled={pending || !transcriptBody.trim()}
              >
                {pending ? "Ingesting…" : meeting.transcript ? "Replace transcript" : "Ingest transcript"}
              </button>
            </>
          )}
        </div>
      </div>

      <RecordCard
        kind="SUMMARY"
        record={meeting.summary}
        canEdit={meeting.canEditRecord}
        canApprove={meeting.canChairApprove}
        canGenerate={!!meeting.transcript && !blocked}
        editing={editKind === "SUMMARY"}
        editBody={editBody}
        setEditBody={setEditBody}
        pending={pending}
        onGenerate={() => generateRecord("SUMMARY")}
        onEdit={() => startEdit("SUMMARY")}
        onSave={saveEdit}
        onCancel={() => setEditKind(null)}
        onApprove={() => approve("SUMMARY")}
      />

      <RecordCard
        kind="MINUTES"
        record={meeting.minutes}
        canEdit={meeting.canEditRecord}
        canApprove={meeting.canChairApprove}
        canGenerate={!!meeting.transcript && !blocked}
        editing={editKind === "MINUTES"}
        editBody={editBody}
        setEditBody={setEditBody}
        pending={pending}
        onGenerate={() => generateRecord("MINUTES")}
        onEdit={() => startEdit("MINUTES")}
        onSave={saveEdit}
        onCancel={() => setEditKind(null)}
        onApprove={() => approve("MINUTES")}
        onCirculate={circulate}
      />
    </div>
  );
}

function RecordCard({
  kind,
  record,
  canEdit,
  canApprove,
  canGenerate,
  editing,
  editBody,
  setEditBody,
  pending,
  onGenerate,
  onEdit,
  onSave,
  onCancel,
  onApprove,
  onCirculate,
}: {
  kind: "SUMMARY" | "MINUTES";
  record: MeetingDetail["summary"] | MeetingDetail["minutes"];
  canEdit: boolean;
  canApprove: boolean;
  canGenerate: boolean;
  editing: boolean;
  editBody: string;
  setEditBody: (v: string) => void;
  pending: boolean;
  onGenerate: () => void;
  onEdit: () => void;
  onSave: () => void;
  onCancel: () => void;
  onApprove: () => void;
  onCirculate?: () => void;
}) {
  const label = kind === "MINUTES" ? "Formal Minutes" : "Summary";
  const status = record?.status;
  const isApprovedOrLater = status === "APPROVED" || status === "CIRCULATED";
  const minutesRecord = kind === "MINUTES" ? (record as MeetingDetail["minutes"]) : null;

  return (
    <div className="card space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-medium">{label}</h3>
        <div className="flex items-center gap-2 text-xs text-ink/50">
          {status && <span className={`tag ${RECORD_STATUS_BADGE[status]}`}>{status.toLowerCase()}</span>}
          {record?.fcgVersionUsed != null && <span>FCG v{record.fcgVersionUsed}</span>}
          {record?.generatedAt && (
            <span>· drafted {record.generatedAt.slice(0, 16).replace("T", " ")}</span>
          )}
          {record?.approvedAt && (
            <span>· approved {record.approvedAt.slice(0, 16).replace("T", " ")}</span>
          )}
          {minutesRecord?.circulatedAt && (
            <span>· circulated {minutesRecord.circulatedAt.slice(0, 16).replace("T", " ")}</span>
          )}
        </div>
      </div>

      {!record && (
        <p className="text-sm text-ink/60">
          No {label.toLowerCase()} yet.{" "}
          {canGenerate
            ? "Click Generate to draft from the ingested transcript."
            : "Ingest a transcript first."}
        </p>
      )}

      {record && editing && (
        <>
          <textarea
            className="input font-mono"
            rows={20}
            value={editBody}
            onChange={(e) => setEditBody(e.target.value)}
            disabled={pending}
          />
          <div className="flex gap-2">
            <button className="btn btn-primary" onClick={onSave} disabled={pending}>
              {pending ? "Saving…" : "Save"}
            </button>
            <button className="btn" onClick={onCancel} disabled={pending}>
              Cancel
            </button>
          </div>
        </>
      )}

      {record && !editing && (
        <pre className="whitespace-pre-wrap rounded bg-ink/5 p-3 text-sm">{record.body}</pre>
      )}

      <div className="flex flex-wrap gap-2">
        {!record && canEdit && canGenerate && (
          <button className="btn btn-primary" onClick={onGenerate} disabled={pending}>
            {pending ? "Drafting…" : `Generate ${label.toLowerCase()}`}
          </button>
        )}
        {record && !editing && !isApprovedOrLater && canEdit && (
          <>
            <button className="btn" onClick={onGenerate} disabled={pending}>
              Regenerate
            </button>
            <button className="btn" onClick={onEdit} disabled={pending}>
              Edit
            </button>
          </>
        )}
        {record && !editing && status !== "CIRCULATED" && status !== "APPROVED" && canApprove && (
          <button className="btn btn-primary" onClick={onApprove} disabled={pending}>
            Approve {label.toLowerCase()}
          </button>
        )}
        {kind === "MINUTES" && status === "APPROVED" && canApprove && onCirculate && (
          <button className="btn btn-primary" onClick={onCirculate} disabled={pending}>
            Mark circulated
          </button>
        )}
      </div>
    </div>
  );
}
