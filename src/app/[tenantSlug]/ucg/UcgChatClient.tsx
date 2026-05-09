"use client";

import { useState, useTransition } from "react";

type Turn = { role: string; content: string };
type Rule = {
  externalId: string;
  category: string;
  channel: string;
  statement: string;
  narrowsFcgRule: string | null;
};
type Ruling = {
  ucgRuleId: string | null;
  fcgRuleId: string | null;
  verdict: string;
  severity: string | null;
  explanation: string;
  suggestedFix: string | null;
};

export default function UcgChatClient({
  tenantSlug,
  ucgId: initialUcgId,
  initialTurns,
  initialRules,
  initialRulings,
  judgeStatus,
  ucgStatus,
}: {
  tenantSlug: string;
  ucgId?: string;
  initialTurns: Turn[];
  initialRules: Rule[];
  initialRulings: Ruling[];
  judgeStatus: string | null;
  ucgStatus: string | null;
}) {
  const [ucgId, setUcgId] = useState<string | undefined>(initialUcgId);
  const [turns, setTurns] = useState<Turn[]>(initialTurns);
  const [rules, setRules] = useState<Rule[]>(initialRules);
  const [rulings, setRulings] = useState<Ruling[]>(initialRulings);
  const [status, setStatus] = useState<string | null>(ucgStatus);
  const [judge, setJudge] = useState<string | null>(judgeStatus);
  const [draft, setDraft] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  async function send() {
    const message = draft.trim();
    if (!message) return;
    setDraft("");
    setError(null);
    setTurns((t) => [...t, { role: "user", content: message }]);
    startTransition(async () => {
      try {
        const res = await fetch("/api/ai/ucg-chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tenantSlug, ucgId, userMessage: message }),
        });
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        setUcgId(data.ucgId);
        setTurns((t) => [...t, { role: "assistant", content: data.message ?? "(no text)" }]);
        // refresh rules
        const r = await fetch(window.location.pathname).then((x) => x.text());
        // we'll just trust the round-trip; full refresh below if needed
        void r;
      } catch (e) {
        setError(e instanceof Error ? e.message : "unknown error");
      }
    });
  }

  async function runJudge() {
    if (!ucgId) return;
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch("/api/ai/judge", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tenantSlug, ucgId }),
        });
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        setJudge(data.overall);
        setRulings(data.rulings ?? []);
        setStatus(data.overall === "pass" ? "JUDGED_PASS" : "JUDGED_FAIL");
      } catch (e) {
        setError(e instanceof Error ? e.message : "judge failed");
      }
    });
  }

  async function commit() {
    if (!ucgId) return;
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/ucg/${ucgId}/commit`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tenantSlug }),
        });
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        setStatus(data.status);
      } catch (e) {
        setError(e instanceof Error ? e.message : "commit failed");
      }
    });
  }

  const blocking = rulings.filter((r) => r.severity === "blocking" && r.verdict === "FAIL");
  const canCommit =
    !!ucgId &&
    (judge === "pass" || (judge === "partial" && blocking.length === 0)) &&
    status !== "COMMITTED";

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
      <div className="card flex flex-col" style={{ minHeight: 480 }}>
        <div className="flex-1 space-y-3 overflow-y-auto pr-1">
          {turns.length === 0 && (
            <p className="text-sm text-ink/50">
              Try: <em>&ldquo;I want to acknowledge external client emails within 4 hours, narrower
              than the firm window.&rdquo;</em>
            </p>
          )}
          {turns.map((t, i) => (
            <div key={i} className={t.role === "user" ? "text-right" : ""}>
              <div
                className={`inline-block max-w-prose whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${
                  t.role === "user" ? "bg-accent text-white" : "bg-ink/5"
                }`}
              >
                {t.content}
              </div>
            </div>
          ))}
        </div>
        <form
          className="mt-3 flex gap-2 shrink-0"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <input
            className="input"
            placeholder="Type and press Enter…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoFocus
          />
          <button className="btn btn-primary" type="submit" disabled={pending || !draft.trim()}>
            {pending ? "…" : "Send"}
          </button>
        </form>
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      </div>

      <aside className="card space-y-3">
        <div>
          <div className="label">UCG status</div>
          <div className="text-sm">
            <span className="tag">{status ?? "no draft"}</span>{" "}
            {judge && <span className="tag">judge: {judge}</span>}
          </div>
        </div>
        <div>
          <div className="label">Rules ({rules.length})</div>
          <ul className="space-y-1 text-xs">
            {rules.length === 0 && <li className="text-ink/50">none yet</li>}
            {rules.map((r) => (
              <li key={r.externalId} className="rounded bg-ink/5 p-2">
                <div className="font-mono text-[10px] text-ink/60">
                  {r.externalId} · {r.category} · {r.channel}
                </div>
                <div>{r.statement}</div>
                {r.narrowsFcgRule && (
                  <div className="text-[10px] text-ink/50">narrows {r.narrowsFcgRule}</div>
                )}
              </li>
            ))}
          </ul>
        </div>
        {rulings.length > 0 && (
          <div>
            <div className="label">Compliance rulings</div>
            <ul className="space-y-1 text-xs">
              {rulings.map((r, i) => (
                <li key={i} className={`rounded p-2 ${r.verdict === "FAIL" ? "bg-red-50" : "bg-emerald-50"}`}>
                  <div className="font-medium">
                    {r.verdict} {r.severity ? `(${r.severity})` : ""}
                  </div>
                  <div className="text-[11px] text-ink/70">{r.explanation}</div>
                  {r.suggestedFix && (
                    <div className="mt-1 text-[11px] italic">Fix: {r.suggestedFix}</div>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="flex gap-2">
          <button className="btn flex-1" disabled={!ucgId || pending} onClick={runJudge}>
            Run Judge
          </button>
          <button className="btn btn-primary flex-1" disabled={!canCommit || pending} onClick={commit}>
            Commit
          </button>
        </div>
        {!canCommit && status !== "COMMITTED" && rulings.length > 0 && (
          <p className="text-xs text-red-700">
            Cannot commit while there are blocking failures. Edit your rules and re-run the Judge.
          </p>
        )}
      </aside>
    </div>
  );
}
