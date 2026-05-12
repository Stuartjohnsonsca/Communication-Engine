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
  // Item 57 — per-channel ingest activity. Serialised from
  // ChannelHealth (the snapshot lives server-side; we only ship the
  // bits the table needs).
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  inboundCount7d: number;
  inboundCount30d: number;
  silent: boolean;
};

type KindOption = {
  kind: string;
  label: string;
  tier: 1 | 2 | 3 | "demo";
  prdRef: string;
  realOAuth: boolean;
};

// Item 52 — server-projected sweep-run row.
type SweepRunRow = {
  id: string;
  source: "CRON" | "BACKFILL";
  startedAt: string;
  windowHours: number;
  maxPerTenant: number;
  candidates: number;
  produced: number;
  skipped: number;
  errored: number;
  skipReasons: Record<string, number>;
  triggeredByName: string | null;
};

// Stable, operator-friendly labels for the skip-reason codes the sweep
// emits. Unknown codes (future additions, sweep-level vs producer-level)
// fall through to the raw code with underscores stripped.
const SKIP_REASON_LABELS: Record<string, string> = {
  draft_already_exists: "Already drafted",
  ingested_not_found: "Inbound vanished",
  tenant_mismatch: "Tenant mismatch",
  not_inbound: "Not inbound",
  membership_not_found: "Owner not found",
  sender_is_owning_user: "Sender = owner",
  drafting_halted: "Lifecycle halted",
  no_committed_fcg: "No committed FCG",
  no_channel_id: "No channel attribution",
  no_active_channel_auth: "No active channel auth",
  auto_draft_paused: "Auto-draft paused",
};

function labelSkipReason(code: string): string {
  return SKIP_REASON_LABELS[code] ?? code.replace(/_/g, " ");
}

type AutoDraftPauseState = {
  pausedAt: string | null;
  pausedByName: string | null;
  reason: string | null;
};

export default function ChannelsClient({
  tenantSlug,
  channels,
  kinds,
  sweepRuns,
  silenceWarnDays,
  canPauseAutoDraft,
  autoDraftPause,
}: {
  tenantSlug: string;
  channels: ChannelRow[];
  kinds: KindOption[];
  sweepRuns: SweepRunRow[];
  silenceWarnDays: number;
  canPauseAutoDraft: boolean;
  autoDraftPause: AutoDraftPauseState;
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
  // Item 58 — auto-draft pause toggle state.
  const [pausePending, startPauseTransition] = useTransition();
  const [pauseReason, setPauseReason] = useState("");
  const [pauseError, setPauseError] = useState<string | null>(null);

  function togglePause(action: "pause" | "resume") {
    setPauseError(null);
    startPauseTransition(async () => {
      const res = await fetch("/api/admin/auto-draft-pause", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tenantSlug,
          action,
          reason: action === "pause" ? pauseReason.trim() || undefined : undefined,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        setPauseError(`Failed to ${action}: ${data.error ?? res.statusText}`);
        return;
      }
      window.location.reload();
    });
  }

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

  // Item 57 — silence banner. ACTIVE channels with active auth that
  // have been silent past the warn window. Token-expiry warnings are
  // a separate cron (item 53); this fires for the case where the
  // token is still valid but nothing is arriving.
  const silentChannels = channels.filter((c) => c.silent);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Channels</h1>
        <p className="mt-1 text-xs text-ink/60">
          PRD §10 — OAuth-based ingestion of approved firm communications. Tier 1 at GA: Microsoft
          365, Google Workspace, Slack. Personal channels are excluded by design (PRD §5.1.1).
        </p>
      </div>

      {autoDraftPause.pausedAt && (
        <div
          className={`card ${
            autoDraftPause.pausedByName === "(circuit-breaker)"
              ? "border-red-400 bg-red-50"
              : "border-amber-400 bg-amber-50"
          }`}
        >
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <div>
              <div
                className={`text-sm font-medium ${
                  autoDraftPause.pausedByName === "(circuit-breaker)"
                    ? "text-red-900"
                    : "text-amber-900"
                }`}
              >
                {autoDraftPause.pausedByName === "(circuit-breaker)"
                  ? "Auto-draft was paused by the circuit breaker"
                  : "Auto-draft is paused"}
              </div>
              <p
                className={`mt-1 text-xs ${
                  autoDraftPause.pausedByName === "(circuit-breaker)"
                    ? "text-red-900/80"
                    : "text-amber-900/80"
                }`}
              >
                {autoDraftPause.pausedByName === "(circuit-breaker)" ? (
                  <>
                    Repeated LLM failures tripped the auto-pause safeguard.
                    Investigate the failed calls on{" "}
                    <a
                      className="underline"
                      href={`/${tenantSlug}/admin/usage`}
                    >
                      /admin/usage
                    </a>{" "}
                    before resuming — the failure source is usually a provider
                    outage, a rate-limited API key, or a scoped model
                    misconfiguration. Background drafting is halted; ad-hoc
                    User drafting via /drafts/new still works.
                  </>
                ) : (
                  <>
                    Background drafting from ingested inbound is halted for
                    this tenant. The 5-minute cron still runs (skip rows
                    appear in history below) and User-pasted drafting via
                    /drafts/new continues to work. Resume when you're ready
                    to let the engine produce drafts again.
                  </>
                )}
              </p>
              <p
                className={`mt-1 text-xs ${
                  autoDraftPause.pausedByName === "(circuit-breaker)"
                    ? "text-red-900/70"
                    : "text-amber-900/70"
                }`}
              >
                Paused {autoDraftPause.pausedAt.slice(0, 16).replace("T", " ")}
                {autoDraftPause.pausedByName && (
                  <> by {autoDraftPause.pausedByName}</>
                )}
                {autoDraftPause.reason && <>: {autoDraftPause.reason}</>}
              </p>
            </div>
            {canPauseAutoDraft && (
              <button
                className="btn btn-primary"
                disabled={pausePending}
                onClick={() => togglePause("resume")}
              >
                {pausePending ? "Resuming…" : "Resume auto-draft"}
              </button>
            )}
          </div>
          {pauseError && (
            <p className="mt-2 text-sm text-red-600">{pauseError}</p>
          )}
        </div>
      )}

      {!autoDraftPause.pausedAt && canPauseAutoDraft && (
        <div className="card space-y-3">
          <div>
            <h2 className="text-base font-medium">Pause auto-draft</h2>
            <p className="mt-1 text-xs text-ink/60">
              Stop background drafting from ingested inbound — for FCG
              revisions, model misbehaviour, or any time you want to halt
              the engine without revoking channel auth. /drafts/new keeps
              working for ad-hoc User drafts.
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="grow min-w-[260px]">
              <label className="label" htmlFor="pause-reason">
                Reason (optional)
              </label>
              <input
                id="pause-reason"
                type="text"
                className="input"
                maxLength={500}
                value={pauseReason}
                onChange={(e) => setPauseReason(e.target.value)}
                placeholder="e.g. FCG revision in progress"
              />
            </div>
            <button
              className="btn"
              disabled={pausePending}
              onClick={() => togglePause("pause")}
            >
              {pausePending ? "Pausing…" : "Pause auto-draft"}
            </button>
          </div>
          {pauseError && (
            <p className="text-sm text-red-600">{pauseError}</p>
          )}
        </div>
      )}

      {silentChannels.length > 0 && (
        <div className="card border-amber-300 bg-amber-50/60">
          <div className="text-sm font-medium text-amber-900">
            {silentChannels.length === 1
              ? "1 channel is silent"
              : `${silentChannels.length} channels are silent`}
          </div>
          <p className="mt-1 text-xs text-amber-900/80">
            No inbound messages in the last {silenceWarnDays} days despite an
            active token. Token-expiry warnings fire separately; this is the
            "token still works but nothing is arriving" mode — common causes
            are scope downgrades made outside the platform, provider rate
            limits, or a polled folder being moved or emptied.
          </p>
          <ul className="mt-2 list-disc pl-4 text-xs text-amber-900/80">
            {silentChannels.map((c) => (
              <li key={c.id}>
                {kindLabel(c.kind)} — last inbound{" "}
                {c.lastInboundAt
                  ? c.lastInboundAt.slice(0, 10)
                  : "never"}
              </li>
            ))}
          </ul>
        </div>
      )}

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

      <div className="card space-y-3">
        <div>
          <h2 className="text-base font-medium">Recent auto-draft activity</h2>
          <p className="mt-1 text-xs text-ink/60">
            Every pass of the auto-draft sweep — both the 5-minute cron and any operator
            backfill — leaves a row here so you can see what the engine is doing. "Skipped"
            covers everything from "already drafted" (the most common; idempotent) to "no
            committed FCG yet." If you see <em>zero candidates</em> repeatedly with new mail
            arriving, the channel may not be ingesting — check the channels table below.
          </p>
        </div>
        {sweepRuns.length === 0 ? (
          <p className="text-sm text-ink/60">
            No sweep activity yet. The cron runs every ~5 minutes; the first row will appear
            once it executes against this tenant.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-ink/50">
              <tr>
                <th className="py-1 pr-3">When</th>
                <th className="py-1 pr-3">Source</th>
                <th className="py-1 pr-3">Window</th>
                <th className="py-1 pr-3">Scanned</th>
                <th className="py-1 pr-3">Produced</th>
                <th className="py-1 pr-3">Skipped</th>
                <th className="py-1 pr-3">Errored</th>
                <th className="py-1 pr-3">Top skip reasons</th>
              </tr>
            </thead>
            <tbody>
              {sweepRuns.map((r) => {
                const reasons = Object.entries(r.skipReasons)
                  .sort((a, b) => b[1] - a[1])
                  .slice(0, 3);
                return (
                  <tr key={r.id} className="border-t border-ink/5 align-top">
                    <td className="py-2 pr-3 text-xs text-ink/70">
                      {r.startedAt.slice(0, 16).replace("T", " ")}
                    </td>
                    <td className="py-2 pr-3">
                      <span className="tag">
                        {r.source === "BACKFILL" ? "backfill" : "cron"}
                      </span>
                      {r.source === "BACKFILL" && r.triggeredByName && (
                        <div className="text-xs text-ink/50">{r.triggeredByName}</div>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-xs text-ink/60">
                      {r.windowHours >= 24
                        ? `${Math.round(r.windowHours / 24)}d`
                        : `${r.windowHours}h`}
                      <span className="ml-1 text-ink/40">· cap {r.maxPerTenant}</span>
                    </td>
                    <td className="py-2 pr-3">{r.candidates}</td>
                    <td className="py-2 pr-3 font-medium">{r.produced}</td>
                    <td className="py-2 pr-3">{r.skipped}</td>
                    <td className="py-2 pr-3">
                      {r.errored > 0 ? (
                        <span className="text-red-600">{r.errored}</span>
                      ) : (
                        <span className="text-ink/50">0</span>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-xs">
                      {reasons.length === 0 ? (
                        <span className="text-ink/40">—</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {reasons.map(([code, n]) => (
                            <span key={code} className="tag bg-ink/[0.04]">
                              {labelSkipReason(code)} · {n}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
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
                <th className="py-1 pr-3">Last inbound</th>
                <th className="py-1 pr-3">In · 7d / 30d</th>
                <th className="py-1 pr-3">Total</th>
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
                    <td className="py-2 pr-3 text-xs">
                      {c.lastInboundAt ? (
                        <span
                          className={c.silent ? "text-amber-700 font-medium" : "text-ink/70"}
                        >
                          {c.lastInboundAt.slice(0, 10)}
                          {c.silent && (
                            <span className="ml-1 tag bg-amber-100 text-amber-900">
                              silent
                            </span>
                          )}
                        </span>
                      ) : c.silent ? (
                        <span className="text-amber-700 font-medium">
                          never
                          <span className="ml-1 tag bg-amber-100 text-amber-900">
                            silent
                          </span>
                        </span>
                      ) : (
                        <span className="text-ink/40">—</span>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-xs text-ink/70 tabular-nums">
                      {c.inboundCount7d} / {c.inboundCount30d}
                    </td>
                    <td className="py-2 pr-3 tabular-nums">{c.messageCount}</td>
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
