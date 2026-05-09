"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export type DraftDetail = {
  id: string;
  kind: string;
  status: string;
  channel: string;
  language: string;
  subject: string | null;
  body: string;
  citations: { marker: string; source: string; locator?: string; claim: string }[];
  holdingRequired: boolean;
  holdingReason: string | null;
  fcgWindowDeadline: string | null;
  noGoSubjectHit: boolean;
  researchTaskRequired: boolean;
  fcgVersionUsed: number | null;
  ucgVersionUsed: number | null;
  inboundChannel: string | null;
  inboundSender: string | null;
  inboundSubject: string | null;
  inboundBody: string | null;
  createdAt: string;
  sentMarkedAt: string | null;
  actions: {
    id: string;
    title: string;
    detail: string | null;
    type: string;
    status: string;
    dueAt: string | null;
  }[];
  parent: { id: string; status: string; createdAt: string } | null;
  children: { id: string; status: string; createdAt: string }[];
};

export default function DraftDetailClient({
  tenantSlug,
  draft,
}: {
  tenantSlug: string;
  draft: DraftDetail;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [subject, setSubject] = useState(draft.subject ?? "");
  const [body, setBody] = useState(draft.body);

  const isSent = draft.status === "SENT";
  const isDiscarded = draft.status === "DISCARDED";
  const dirty = subject !== (draft.subject ?? "") || body !== draft.body;

  function save() {
    if (!dirty) {
      setEditing(false);
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/drafts/${draft.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tenantSlug,
          subject: subject.trim() ? subject : null,
          body,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(`Could not save: ${data.error ?? res.statusText}`);
        return;
      }
      setEditing(false);
      router.refresh();
    });
  }

  function setStatus(status: "ACCEPTED" | "DISCARDED") {
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/drafts/${draft.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenantSlug, status }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(`Could not update: ${data.error ?? res.statusText}`);
        return;
      }
      router.refresh();
    });
  }

  function markSent() {
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/drafts/${draft.id}/sent`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenantSlug }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(`Could not mark sent: ${data.error ?? res.statusText}`);
        return;
      }
      router.refresh();
    });
  }

  function regenerate() {
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/drafts/${draft.id}/regenerate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenantSlug }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(`Could not regenerate: ${data.error ?? res.statusText}`);
        return;
      }
      const json = await res.json();
      router.push(`/${tenantSlug}/drafts/${json.draft.id}`);
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <Link
            href={`/${tenantSlug}/drafts`}
            className="text-xs text-ink/60 underline decoration-dotted"
          >
            ← All drafts
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            {draft.subject ?? "(no subject)"}
          </h1>
          <div className="mt-1 flex flex-wrap gap-2 text-xs text-ink/60">
            <span className="tag">{draft.status}</span>
            <span className="tag">{draft.kind}</span>
            <span className="tag">{draft.channel}</span>
            {draft.holdingRequired && <span className="tag bg-amber-100">holding</span>}
            {draft.researchTaskRequired && (
              <span className="tag bg-violet-100">research required</span>
            )}
            {draft.noGoSubjectHit && <span className="tag bg-red-100">no-go subject</span>}
            <span>created {draft.createdAt.slice(0, 16).replace("T", " ")}</span>
            {draft.sentMarkedAt && (
              <span>sent {draft.sentMarkedAt.slice(0, 16).replace("T", " ")}</span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {!isSent && !isDiscarded && !editing && (
            <button className="btn" onClick={() => setEditing(true)} disabled={pending}>
              Edit
            </button>
          )}
          {!isSent && !isDiscarded && (
            <button className="btn" onClick={regenerate} disabled={pending}>
              {pending ? "…" : "Regenerate"}
            </button>
          )}
          {!isSent && draft.status !== "ACCEPTED" && !isDiscarded && (
            <button
              className="btn btn-primary"
              onClick={() => setStatus("ACCEPTED")}
              disabled={pending}
            >
              Accept
            </button>
          )}
          {draft.status === "ACCEPTED" && !isSent && (
            <button className="btn btn-primary" onClick={markSent} disabled={pending}>
              Mark sent
            </button>
          )}
          {!isSent && !isDiscarded && (
            <button className="btn" onClick={() => setStatus("DISCARDED")} disabled={pending}>
              Discard
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="card border-red-300">
          <p className="text-sm text-red-600">{error}</p>
        </div>
      )}

      {(draft.parent || draft.children.length > 0) && (
        <div className="card text-xs text-ink/60">
          <div className="label">Lineage</div>
          {draft.parent && (
            <div>
              Regenerated from{" "}
              <Link
                href={`/${tenantSlug}/drafts/${draft.parent.id}`}
                className="underline decoration-dotted"
              >
                earlier draft
              </Link>{" "}
              ({draft.parent.status}, {draft.parent.createdAt.slice(0, 10)})
            </div>
          )}
          {draft.children.length > 0 && (
            <div>
              Superseded by{" "}
              {draft.children.map((c, i) => (
                <span key={c.id}>
                  {i > 0 && ", "}
                  <Link
                    href={`/${tenantSlug}/drafts/${c.id}`}
                    className="underline decoration-dotted"
                  >
                    {c.status} ({c.createdAt.slice(0, 10)})
                  </Link>
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-medium">Draft</h2>
            {draft.fcgVersionUsed != null && (
              <span className="text-xs text-ink/50">
                FCG v{draft.fcgVersionUsed}
                {draft.ucgVersionUsed != null && ` · UCG v${draft.ucgVersionUsed}`}
              </span>
            )}
          </div>

          {editing ? (
            <>
              <div>
                <label className="label">Subject</label>
                <input
                  className="input"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                />
              </div>
              <div>
                <label className="label">Body</label>
                <textarea
                  className="input font-mono"
                  rows={18}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                />
              </div>
              <div className="flex gap-2">
                <button
                  className="btn btn-primary"
                  onClick={save}
                  disabled={pending || !dirty}
                >
                  {pending ? "Saving…" : "Save"}
                </button>
                <button
                  className="btn"
                  onClick={() => {
                    setEditing(false);
                    setSubject(draft.subject ?? "");
                    setBody(draft.body);
                  }}
                  disabled={pending}
                >
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <>
              {draft.subject && (
                <div className="text-sm">
                  <span className="label">Subject</span>
                  {draft.subject}
                </div>
              )}
              <pre className="whitespace-pre-wrap rounded bg-ink/5 p-3 text-sm">
                {draft.body}
              </pre>
            </>
          )}

          {draft.holdingReason && (
            <div className="text-xs text-ink/60">
              <span className="label">Holding reason</span>
              {draft.holdingReason}
              {draft.fcgWindowDeadline && (
                <> · substantive due by {draft.fcgWindowDeadline.slice(0, 10)}</>
              )}
            </div>
          )}

          {draft.citations.length > 0 && (
            <div>
              <div className="label">Citations</div>
              <ul className="space-y-1 text-xs">
                {draft.citations.map((c, i) => (
                  <li key={i} className="rounded bg-ink/5 p-2">
                    <span className="font-mono">[{c.marker}]</span> {c.source}{" "}
                    {c.locator && <span className="text-ink/50">@ {c.locator}</span>}
                    <div className="italic text-ink/70">{c.claim}</div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="space-y-4">
          <div className="card space-y-2">
            <h2 className="text-base font-medium">Inbound</h2>
            {draft.inboundBody ? (
              <>
                <div className="text-xs text-ink/60">
                  {draft.inboundChannel && <span className="tag mr-1">{draft.inboundChannel}</span>}
                  {draft.inboundSender && <>from {draft.inboundSender} · </>}
                  {draft.inboundSubject && <>{draft.inboundSubject}</>}
                </div>
                <pre className="whitespace-pre-wrap rounded bg-ink/5 p-3 text-sm">
                  {draft.inboundBody}
                </pre>
              </>
            ) : (
              <p className="text-sm text-ink/50">
                No inbound stored on this draft. Regenerate is unavailable.
              </p>
            )}
          </div>

          <div className="card">
            <h2 className="text-base font-medium">
              Actions ({draft.actions.length})
            </h2>
            {draft.actions.length === 0 ? (
              <p className="mt-2 text-sm text-ink/50">None.</p>
            ) : (
              <ul className="mt-2 space-y-1 text-sm">
                {draft.actions.map((a) => (
                  <li key={a.id} className="flex items-baseline gap-2">
                    <span className="tag">{a.type}</span>
                    <span>{a.title}</span>
                    {a.dueAt && (
                      <span className="text-xs text-ink/50">
                        due {a.dueAt.slice(0, 10)}
                      </span>
                    )}
                    {a.status !== "OPEN" && (
                      <span className="tag bg-ink/10">{a.status}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-3 text-xs">
              <Link
                href={`/${tenantSlug}/actions`}
                className="underline decoration-dotted"
              >
                Manage in Actions →
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
