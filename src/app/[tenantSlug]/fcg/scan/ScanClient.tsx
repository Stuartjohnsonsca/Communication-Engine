"use client";

import Link from "next/link";
import { useState, useTransition } from "react";

type ScanRow = {
  id: string;
  status: string;
  dateRangeFrom: string;
  dateRangeTo: string;
  channelKinds: string[];
  messagesAnalysed: number;
  proposalId: string | null;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
  initiatedByEmail: string;
};

export default function ScanClient({
  tenantSlug,
  canRun,
  hasDpia,
  fctCount,
  availableChannelKinds,
  allChannelKinds,
  initialScans,
}: {
  tenantSlug: string;
  canRun: boolean;
  hasDpia: boolean;
  fctCount: number;
  availableChannelKinds: string[];
  allChannelKinds: { kind: string; label: string }[];
  initialScans: ScanRow[];
}) {
  const [scans, setScans] = useState<ScanRow[]>(initialScans);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Default the date range to "the last 60 days" — long enough to surface
  // recurring response-time patterns, short enough to keep within the
  // recommended DPIA window for a Pilot-stage scan.
  const today = new Date();
  const defaultTo = today.toISOString().slice(0, 10);
  const sixtyDaysAgo = new Date(today.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const [dateFrom, setDateFrom] = useState(sixtyDaysAgo);
  const [dateTo, setDateTo] = useState(defaultTo);
  const [selectedKinds, setSelectedKinds] = useState<string[]>(availableChannelKinds);

  function toggleKind(k: string) {
    setSelectedKinds((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]));
  }

  async function startScan() {
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/fcg/scan?tenant=${tenantSlug}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            dateRangeFrom: new Date(dateFrom).toISOString(),
            dateRangeTo: new Date(`${dateTo}T23:59:59`).toISOString(),
            channelKinds: selectedKinds,
          }),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
        const created = await res.json();
        // Immediately run the scan synchronously so the operator sees the
        // outcome in one click. Lifecycle states still distinguish PENDING /
        // ANALYSING / DRAFTED so a future async worker can replace this.
        const runRes = await fetch(`/api/fcg/scan/${created.id}/run?tenant=${tenantSlug}`, {
          method: "POST",
        });
        const runJson = await runRes.json().catch(() => ({}));
        if (!runRes.ok) throw new Error(runJson.error ?? "scan failed");
        // Reload list with the freshly-completed scan at the top.
        const listRes = await fetch(`/api/fcg/scan?tenant=${tenantSlug}`);
        if (listRes.ok) {
          const list = await listRes.json();
          setScans(toRows(list));
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "scan failed");
      }
    });
  }

  async function discard(scanId: string) {
    if (!confirm("Discard this scan? Any staged DRAFTING proposal will be withdrawn.")) return;
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/fcg/scan/${scanId}/discard?tenant=${tenantSlug}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "discard failed");
        const listRes = await fetch(`/api/fcg/scan?tenant=${tenantSlug}`);
        if (listRes.ok) setScans(toRows(await listRes.json()));
      } catch (e) {
        setError(e instanceof Error ? e.message : "discard failed");
      }
    });
  }

  const blockers: string[] = [];
  if (!hasDpia) blockers.push("Tenant has no ATTESTED DPIA — complete §12.2 first.");
  if (fctCount === 0) blockers.push("No FCT or Firm Administrator memberships — appoint at least one.");
  if (availableChannelKinds.length === 0)
    blockers.push("No active channels authorised — connect Microsoft 365 / Google / Slack first.");

  return (
    <div className="space-y-6">
      {!canRun && (
        <div className="card text-sm text-ink/70">
          Read-only view. Only the Firm Administrator can launch a scan.
        </div>
      )}

      {canRun && (
        <div className="card space-y-4">
          <div>
            <h2 className="text-base font-medium">New scan</h2>
            <p className="mt-1 text-xs text-ink/60">
              Pulls IngestedMessage rows from FCT-member memberships in the chosen window, runs
              them through the analyser, and stages a DRAFTING FCG proposal for the FCT to open
              for vote. Capped at 200 messages.
            </p>
          </div>

          {blockers.length > 0 && (
            <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              <p className="font-medium">Cannot launch a scan yet:</p>
              <ul className="mt-1 list-disc pl-5">
                {blockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <div className="label">Date range — from</div>
              <input
                type="date"
                className="input"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
              />
            </div>
            <div>
              <div className="label">Date range — to</div>
              <input
                type="date"
                className="input"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
              />
            </div>
          </div>

          <div>
            <div className="label">Channel scope</div>
            <p className="mb-2 text-xs text-ink/60">
              Only kinds with an active Channel row are pre-ticked. Tick another to widen scope —
              the scan will simply find zero rows for kinds with no ingested messages.
            </p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {allChannelKinds
                .filter((k) => k.kind !== "MOCK")
                .map((k) => (
                  <label
                    key={k.kind}
                    className={`flex cursor-pointer items-center gap-2 rounded border px-3 py-2 text-sm ${
                      selectedKinds.includes(k.kind) ? "border-accent bg-accent/5" : "border-ink/10"
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      checked={selectedKinds.includes(k.kind)}
                      onChange={() => toggleKind(k.kind)}
                    />
                    <span>
                      {k.label}
                      {availableChannelKinds.includes(k.kind) && (
                        <span className="ml-1 text-xs text-ink/40">(active)</span>
                      )}
                    </span>
                  </label>
                ))}
            </div>
          </div>

          <button
            className="btn btn-primary"
            disabled={pending || blockers.length > 0 || selectedKinds.length === 0}
            onClick={startScan}
          >
            {pending ? "Scanning…" : "Run scan"}
          </button>
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
      )}

      <div className="card">
        <h2 className="text-base font-medium">Scan history</h2>
        {scans.length === 0 ? (
          <p className="mt-2 text-sm text-ink/60">No scans yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-ink/5 text-sm">
            {scans.map((s) => (
              <li key={s.id} className="py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="tag">{s.status}</span>
                    <span className="text-ink/60">
                      {s.dateRangeFrom.slice(0, 10)} → {s.dateRangeTo.slice(0, 10)}
                    </span>
                    <span className="text-xs text-ink/40">·</span>
                    <span className="text-xs text-ink/50">
                      {s.channelKinds.length === 0 ? "all channels" : s.channelKinds.join(", ")}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-ink/50">
                    <span>by {s.initiatedByEmail}</span>
                    <span>{new Date(s.createdAt).toISOString().slice(0, 16).replace("T", " ")}</span>
                  </div>
                </div>
                <div className="mt-1 text-xs text-ink/60">
                  {s.status === "DRAFTED" && (
                    <span>
                      {s.messagesAnalysed} message{s.messagesAnalysed === 1 ? "" : "s"} analysed —
                      proposal staged for FCT vote
                    </span>
                  )}
                  {s.status === "PROMOTED" && (
                    <span>{s.messagesAnalysed} messages analysed — proposal opened for vote</span>
                  )}
                  {s.status === "ERRORED" && (
                    <span className="text-red-700">Errored: {s.errorMessage}</span>
                  )}
                  {s.status === "DISCARDED" && <span>Discarded by operator</span>}
                  {s.status === "PENDING" && <span>Queued — has not started yet</span>}
                  {s.status === "ANALYSING" && <span>Currently analysing…</span>}
                </div>
                {(s.status === "DRAFTED" || s.status === "PROMOTED") && s.proposalId && (
                  <div className="mt-2 flex items-center gap-2">
                    <Link
                      href={`/${tenantSlug}/fcg/proposals/${s.proposalId}`}
                      className="btn"
                    >
                      Open proposal
                    </Link>
                    {canRun && s.status === "DRAFTED" && (
                      <button className="btn" onClick={() => discard(s.id)} disabled={pending}>
                        Discard
                      </button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function toRows(list: unknown[]): ScanRow[] {
  type Raw = {
    id: string;
    status: string;
    dateRangeFrom: string;
    dateRangeTo: string;
    channelKinds?: string[];
    messagesAnalysed: number;
    proposalId: string | null;
    errorMessage: string | null;
    createdAt: string;
    completedAt: string | null;
    initiatedBy?: { user: { email: string } };
  };
  return (list as Raw[]).map((s) => ({
    id: s.id,
    status: s.status,
    dateRangeFrom: s.dateRangeFrom,
    dateRangeTo: s.dateRangeTo,
    channelKinds: s.channelKinds ?? [],
    messagesAnalysed: s.messagesAnalysed,
    proposalId: s.proposalId,
    errorMessage: s.errorMessage,
    createdAt: s.createdAt,
    completedAt: s.completedAt,
    initiatedByEmail: s.initiatedBy?.user.email ?? "—",
  }));
}
