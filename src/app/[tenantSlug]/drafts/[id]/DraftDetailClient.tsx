"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export type AdherenceDimensionKey =
  | "responseTime"
  | "tone"
  | "mandatoryPhrase"
  | "prohibitedPhrase"
  | "escalation";

export type AdherenceDimension = {
  score: number | null;
  verdict: "pass" | "partial" | "fail" | "not_applicable";
  evidence?: string;
};

export type AdherenceRuleFinding = {
  ruleExternalId: string;
  source: "fcg" | "ucg";
  verdict: "pass" | "fail";
  explanation: string;
};

export type AdherenceDetail = {
  id: string;
  overall: number;
  perDimension: Record<AdherenceDimensionKey, AdherenceDimension>;
  perRule: AdherenceRuleFinding[];
  fcgVersionUsed: number;
  ucgVersionUsed: number | null;
  createdAt: string;
  escalatedAt: string | null;
  acknowledgedAt: string | null;
};

export type SentimentDetail = {
  id: string;
  classification: string;
  confidence: number | null;
  isAboutFirmHandling: boolean;
  trigger: string | null;
  escalatedAt: string | null;
  acknowledgedAt: string | null;
  evidenceSpans: { text: string }[];
};

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
  sentText: string | null;
  sentResponseLatencyMin: number | null;
  adherence: AdherenceDetail | null;
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
  sentiment: SentimentDetail | null;
  synthesisedFromOutboundIngest: boolean;
};

const DIMENSION_LABELS: Record<AdherenceDimensionKey, string> = {
  responseTime: "Response time",
  tone: "Tone",
  mandatoryPhrase: "Mandatory phrases",
  prohibitedPhrase: "Prohibited phrases",
  escalation: "Escalation handling",
};

const VERDICT_BG: Record<AdherenceDimension["verdict"], string> = {
  pass: "bg-emerald-100 text-emerald-800",
  partial: "bg-amber-100 text-amber-800",
  fail: "bg-red-100 text-red-700",
  not_applicable: "bg-ink/10 text-ink/60",
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
  const [confirmingSent, setConfirmingSent] = useState(false);
  const [sentSubject, setSentSubject] = useState(draft.subject ?? "");
  const [sentBodyText, setSentBodyText] = useState(draft.body);

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

  function openSentDialog() {
    setSentSubject(draft.subject ?? "");
    setSentBodyText(draft.body);
    setConfirmingSent(true);
  }

  function confirmSent() {
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/drafts/${draft.id}/sent`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tenantSlug,
          sentSubject: sentSubject.trim() ? sentSubject : null,
          sentText: sentBodyText,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(`Could not mark sent: ${data.error ?? res.statusText}`);
        return;
      }
      setConfirmingSent(false);
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
            {draft.synthesisedFromOutboundIngest && (
              <span className="tag bg-amber-100" title="Reconstructed by ingest from the connected mailbox — the User did not draft this in the engine.">
                bypassed send
              </span>
            )}
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
            <button className="btn btn-primary" onClick={openSentDialog} disabled={pending}>
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

      {draft.sentiment && draft.sentiment.escalatedAt && !draft.sentiment.acknowledgedAt && (
        <SentimentEscalationBanner
          tenantSlug={tenantSlug}
          sentiment={draft.sentiment}
        />
      )}

      {draft.adherence && draft.adherence.escalatedAt && !draft.adherence.acknowledgedAt && (
        <AdherenceEscalationBanner
          tenantSlug={tenantSlug}
          adherence={draft.adherence}
        />
      )}

      {confirmingSent && (
        <div className="card border-emerald-300 space-y-3">
          <div>
            <h2 className="text-base font-medium">Confirm what you actually sent</h2>
            <p className="mt-1 text-xs text-ink/60">
              Adherence is scored against the text you actually sent (PRD §9.1), not the system&rsquo;s
              draft. Paste over the body if you edited it in your email client.
            </p>
          </div>
          <div>
            <label className="label">Subject</label>
            <input
              className="input"
              value={sentSubject}
              onChange={(e) => setSentSubject(e.target.value)}
            />
          </div>
          <div>
            <label className="label">Body</label>
            <textarea
              className="input font-mono"
              rows={14}
              value={sentBodyText}
              onChange={(e) => setSentBodyText(e.target.value)}
            />
          </div>
          <div className="flex gap-2">
            <button className="btn btn-primary" onClick={confirmSent} disabled={pending}>
              {pending ? "Scoring…" : "Mark sent &amp; score"}
            </button>
            <button
              className="btn"
              onClick={() => setConfirmingSent(false)}
              disabled={pending}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {draft.adherence && <AdherencePanel adherence={draft.adherence} />}

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

function AdherencePanel({ adherence }: { adherence: AdherenceDetail }) {
  const overallPct = Math.round(adherence.overall * 100);
  const dimKeys = Object.keys(adherence.perDimension) as AdherenceDimensionKey[];

  return (
    <div className="card space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-medium">Adherence (sent text)</h2>
          <p className="text-xs text-ink/60">
            FCG v{adherence.fcgVersionUsed}
            {adherence.ucgVersionUsed != null && ` · UCG v${adherence.ucgVersionUsed}`} ·
            scored {adherence.createdAt.slice(0, 16).replace("T", " ")}
          </p>
        </div>
        <div className="text-right">
          <div className="text-2xl font-semibold tabular-nums">{overallPct}%</div>
          <div className="text-xs text-ink/50">overall</div>
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        {dimKeys.map((k) => {
          const d = adherence.perDimension[k];
          const pct = d.score == null ? null : Math.round(d.score * 100);
          return (
            <div key={k} className="rounded border border-ink/10 p-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium">{DIMENSION_LABELS[k]}</span>
                <span className={`tag ${VERDICT_BG[d.verdict]}`}>{d.verdict}</span>
              </div>
              <div className="mt-1 text-lg tabular-nums">
                {pct == null ? <span className="text-ink/40">—</span> : `${pct}%`}
              </div>
              {d.evidence && (
                <p className="mt-1 text-xs text-ink/60">{d.evidence}</p>
              )}
            </div>
          );
        })}
      </div>

      {adherence.perRule.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-ink/60">
            Rule-level findings ({adherence.perRule.length})
          </summary>
          <ul className="mt-2 space-y-1">
            {adherence.perRule.map((r, i) => (
              <li key={i} className="rounded bg-ink/5 p-2">
                <div className="flex items-center gap-2">
                  <span className={`tag ${VERDICT_BG[r.verdict]}`}>{r.verdict}</span>
                  <span className="font-mono">{r.source}:{r.ruleExternalId}</span>
                </div>
                <div className="mt-1 text-ink/70">{r.explanation}</div>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function AdherenceEscalationBanner({
  tenantSlug,
  adherence,
}: {
  tenantSlug: string;
  adherence: AdherenceDetail;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const overallPct = Math.round(adherence.overall * 100);
  const failures = adherence.perRule.filter((r) => r.verdict === "fail").slice(0, 3);

  function acknowledge() {
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/adherence/${adherence.id}/acknowledge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenantSlug }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? res.statusText);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="card border-red-400 bg-red-50/60 space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <h2 className="text-base font-medium text-red-800">
            Adherence escalation — sent communication scored {overallPct}% overall
          </h2>
          <p className="mt-1 text-xs text-red-900/70">
            Below the {Math.round(0.6 * 100)}% threshold. The Firm Culture Team has also been notified.
            Acknowledge once you have followed up with the counterparty or otherwise have the matter in
            hand — this records who took ownership.
          </p>
        </div>
        <div className="text-right text-xs text-red-900/70">
          <div className="tabular-nums">FCG v{adherence.fcgVersionUsed}</div>
          {adherence.ucgVersionUsed != null && (
            <div className="tabular-nums">UCG v{adherence.ucgVersionUsed}</div>
          )}
        </div>
      </div>
      {failures.length > 0 && (
        <ul className="space-y-1 text-xs">
          {failures.map((r, i) => (
            <li key={i} className="rounded bg-white/70 p-2 text-red-900">
              <span className="font-mono opacity-70">{r.source}:{r.ruleExternalId}</span>
              <div>{r.explanation}</div>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-3">
        <button className="btn btn-primary text-xs" onClick={acknowledge} disabled={pending}>
          {pending ? "…" : "Acknowledge escalation"}
        </button>
        {error && <span className="text-xs text-red-700">{error}</span>}
      </div>
    </div>
  );
}

function SentimentEscalationBanner({
  tenantSlug,
  sentiment,
}: {
  tenantSlug: string;
  sentiment: SentimentDetail;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const conf = sentiment.confidence == null ? null : Math.round(sentiment.confidence * 100);

  function acknowledge() {
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/sentiment/${sentiment.id}/acknowledge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenantSlug }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? res.statusText);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="card border-red-400 bg-red-50/60 space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <h2 className="text-base font-medium text-red-800">
            Sentiment escalation — counterparty unhappy with firm handling
          </h2>
          <p className="mt-1 text-xs text-red-900/70">
            PRD §9.3 escalation. The Firm Culture Team has also been notified via the Sentiment
            queue. Acknowledge once you have the matter in hand — this records who took ownership.
          </p>
        </div>
        <div className="text-right text-xs text-red-900/70">
          {conf != null && <div className="tabular-nums">{conf}% confidence</div>}
          {sentiment.trigger && <div>trigger: {sentiment.trigger}</div>}
        </div>
      </div>
      {sentiment.evidenceSpans.length > 0 && (
        <ul className="space-y-1 text-xs">
          {sentiment.evidenceSpans.slice(0, 3).map((sp, i) => (
            <li key={i} className="rounded bg-white/70 p-2 italic text-red-900">
              &ldquo;{sp.text}&rdquo;
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-3">
        <button className="btn btn-primary text-xs" onClick={acknowledge} disabled={pending}>
          {pending ? "…" : "Acknowledge escalation"}
        </button>
        {error && <span className="text-xs text-red-700">{error}</span>}
      </div>
    </div>
  );
}
