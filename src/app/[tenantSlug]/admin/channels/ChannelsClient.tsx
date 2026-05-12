"use client";

import { useState, useTransition } from "react";

type ChannelRow = {
  id: string;
  kind: string;
  status: string;
  dpiaApproved: boolean;
  createdAt: string;
  scope: string | null;
  expiresAt: string | null;
  messageCount: number;
};

type KindOption = {
  kind: string;
  label: string;
  tier: 1 | 2 | 3 | "demo";
  prdRef: string;
  realOAuth: boolean;
};

export default function ChannelsClient({
  tenantSlug,
  channels,
  kinds,
}: {
  tenantSlug: string;
  channels: ChannelRow[];
  kinds: KindOption[];
}) {
  const [selectedKind, setSelectedKind] = useState(kinds[0]?.kind ?? "");
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  // Item 51 — operator backfill state.
  const [backfillDays, setBackfillDays] = useState(30);
  const [backfillPending, startBackfillTransition] = useTransition();
  const [backfillResult, setBackfillResult] = useState<string | null>(null);

  function runBackfill() {
    setError(null);
    setBackfillResult(null);
    startBackfillTransition(async () => {
      const res = await fetch("/api/admin/auto-draft-backfill", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenantSlug, daysBack: backfillDays }),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        setError(`Backfill failed: ${data.error ?? res.statusText}`);
        return;
      }
      const produced = Number(data.produced ?? 0);
      const skipped = Number(data.skipped ?? 0);
      const candidates = Number(data.candidates ?? 0);
      setBackfillResult(
        `Backfill for the last ${backfillDays} day${backfillDays === 1 ? "" : "s"}: ${produced} draft${
          produced === 1 ? "" : "s"
        } produced, ${skipped} skipped, ${candidates} candidate${
          candidates === 1 ? "" : "s"
        } scanned. Re-press if you hit the 500-per-press cap.`,
      );
    });
  }

  function reload() {
    window.location.reload();
  }

  function addChannel() {
    if (!selectedKind) return;
    setError(null);
    setInfo(null);
    startTransition(async () => {
      const res = await fetch("/api/channels", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenantSlug, kind: selectedKind }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(`Error adding channel: ${data.error ?? res.statusText}`);
        return;
      }
      reload();
    });
  }

  function connect(id: string, mode: "real" | "mock") {
    setError(null);
    setInfo(null);
    setBusyId(id);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/channels/${id}/connect`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tenantSlug, mode }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(`Error connecting: ${data.error ?? res.statusText}`);
          return;
        }
        if (data.redirectTo) {
          window.location.href = data.redirectTo;
          return;
        }
        setInfo(`Channel connected (${data.mode ?? "ok"}).`);
        reload();
      } finally {
        setBusyId(null);
      }
    });
  }

  function ingest(id: string) {
    setError(null);
    setInfo(null);
    setBusyId(id);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/channels/${id}/ingest`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tenantSlug }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(`Error ingesting: ${data.error ?? res.statusText}`);
          return;
        }
        setInfo(
          `Ingest: fetched ${data.fetched ?? 0}, inserted ${data.inserted ?? 0}, skipped ${data.skipped ?? 0}.`,
        );
        reload();
      } finally {
        setBusyId(null);
      }
    });
  }

  function revoke(id: string) {
    if (!confirm("Revoke this channel? Existing tokens will be invalidated.")) return;
    setError(null);
    setInfo(null);
    setBusyId(id);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/channels/${id}/revoke`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tenantSlug }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(`Error revoking: ${data.error ?? res.statusText}`);
          return;
        }
        reload();
      } finally {
        setBusyId(null);
      }
    });
  }

  const kindLabel = (k: string) => kinds.find((x) => x.kind === k)?.label ?? k;
  const selectedMeta = kinds.find((k) => k.kind === selectedKind);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Channels</h1>
        <p className="mt-1 text-xs text-ink/60">
          PRD §10 — OAuth-based ingestion of approved firm communications. Tier 1 at GA: Microsoft
          365, Google Workspace, Slack. Personal channels are excluded by design (PRD §5.1.1).
        </p>
      </div>

      <div className="card space-y-3">
        <h2 className="text-base font-medium">Add a channel</h2>
        <div className="flex flex-wrap items-end gap-3">
          <div className="grow min-w-[260px]">
            <label className="label">Channel kind</label>
            <select
              className="input"
              value={selectedKind}
              onChange={(e) => setSelectedKind(e.target.value)}
            >
              {kinds.map((k) => (
                <option key={k.kind} value={k.kind}>
                  {k.label} — tier {k.tier} ({k.prdRef})
                  {k.realOAuth ? "" : " · mock only"}
                </option>
              ))}
            </select>
            {selectedMeta && !selectedMeta.realOAuth && selectedMeta.tier !== "demo" && (
              <p className="mt-1 text-xs text-ink/50">
                OAuth credentials for this kind are not configured in this deployment. The channel
                will fall through to the mock adapter so the rest of the platform still demonstrates
                end-to-end.
              </p>
            )}
          </div>
          <button className="btn btn-primary" disabled={pending || !selectedKind} onClick={addChannel}>
            {pending && !busyId ? "Adding…" : "Add channel"}
          </button>
        </div>
      </div>

      {(error || info) && (
        <div className={`card ${error ? "border-red-300" : ""}`}>
          {error && <p className="text-sm text-red-600">{error}</p>}
          {info && <p className="text-sm text-ink/70">{info}</p>}
        </div>
      )}

      <div className="card space-y-3">
        <div>
          <h2 className="text-base font-medium">Backfill drafts from historic inbound</h2>
          <p className="mt-1 text-xs text-ink/60">
            The engine produces drafts continuously as new inbound arrives (every ~5 minutes via the
            <code className="mx-1 rounded bg-ink/5 px-1">auto-draft</code> cron). Use this control
            to replay drafting against historic ingested inbound — for example after first connecting
            a mailbox, or to catch a backlog older than the 24-hour cron window. Bounded: each press
            produces at most 500 drafts; re-press to continue.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="label" htmlFor="backfill-days">
              Days back
            </label>
            <input
              id="backfill-days"
              type="number"
              min={1}
              max={365}
              className="input"
              value={backfillDays}
              onChange={(e) =>
                setBackfillDays(
                  Math.max(1, Math.min(365, Number.parseInt(e.target.value, 10) || 1)),
                )
              }
            />
          </div>
          <button
            className="btn"
            disabled={backfillPending}
            onClick={runBackfill}
          >
            {backfillPending ? "Backfilling…" : "Backfill now"}
          </button>
        </div>
        {backfillResult && (
          <p className="text-sm text-ink/70">{backfillResult}</p>
        )}
      </div>

      <div className="card">
        <h2 className="text-base font-medium">Configured channels</h2>
        {channels.length === 0 ? (
          <p className="mt-2 text-sm text-ink/60">No channels yet — add one above.</p>
        ) : (
          <table className="mt-3 w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-ink/50">
              <tr>
                <th className="py-1 pr-3">Kind</th>
                <th className="py-1 pr-3">Status</th>
                <th className="py-1 pr-3">DPIA</th>
                <th className="py-1 pr-3">Messages</th>
                <th className="py-1 pr-3">Token expires</th>
                <th className="py-1 pr-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {channels.map((c) => {
                const meta = kinds.find((k) => k.kind === c.kind);
                const isBusy = busyId === c.id;
                const canConnect = c.status === "INACTIVE";
                const canIngest = c.status === "ACTIVE";
                const canRevoke = c.status === "ACTIVE";
                return (
                  <tr key={c.id} className="border-t border-ink/5 align-top">
                    <td className="py-2 pr-3">
                      <div className="font-medium">{kindLabel(c.kind)}</div>
                      <div className="text-xs text-ink/50">
                        added {c.createdAt.slice(0, 10)}
                        {c.scope && ` · ${c.scope.length > 60 ? c.scope.slice(0, 60) + "…" : c.scope}`}
                      </div>
                    </td>
                    <td className="py-2 pr-3">
                      <span className="tag">{c.status}</span>
                    </td>
                    <td className="py-2 pr-3 text-xs">
                      {c.dpiaApproved ? (
                        <span className="tag">approved</span>
                      ) : (
                        <span className="text-ink/50">pending</span>
                      )}
                    </td>
                    <td className="py-2 pr-3">{c.messageCount}</td>
                    <td className="py-2 pr-3 text-xs text-ink/60">
                      {c.expiresAt ? c.expiresAt.slice(0, 10) : "—"}
                    </td>
                    <td className="py-2 pr-3">
                      <div className="flex flex-wrap gap-2">
                        {canConnect && meta?.realOAuth && meta.kind !== "MOCK" && (
                          <button
                            className="btn btn-primary"
                            disabled={isBusy}
                            onClick={() => connect(c.id, "real")}
                          >
                            {isBusy ? "…" : "Connect (OAuth)"}
                          </button>
                        )}
                        {canConnect && (
                          <button
                            className="btn"
                            disabled={isBusy}
                            onClick={() => connect(c.id, "mock")}
                          >
                            {isBusy ? "…" : "Connect (mock)"}
                          </button>
                        )}
                        {canIngest && (
                          <button
                            className="btn"
                            disabled={isBusy}
                            onClick={() => ingest(c.id)}
                          >
                            {isBusy ? "…" : "Run ingest"}
                          </button>
                        )}
                        {canRevoke && (
                          <button
                            className="btn"
                            disabled={isBusy}
                            onClick={() => revoke(c.id)}
                          >
                            {isBusy ? "…" : "Revoke"}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
