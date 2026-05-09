"use client";

import { useState, useTransition } from "react";
import Link from "next/link";

type Turn = { role: string; content: string };
type ToolCall = { name: string; input: unknown };

export default function FcgChatClient({
  tenantSlug,
  initialProposalId,
  initialTurns,
}: {
  tenantSlug: string;
  initialProposalId?: string;
  initialTurns: Turn[];
}) {
  const [proposalId, setProposalId] = useState<string | undefined>(initialProposalId);
  const [turns, setTurns] = useState<Turn[]>(initialTurns);
  const [toolCalls, setToolCalls] = useState<ToolCall[]>([]);
  const [diffOps, setDiffOps] = useState<unknown[]>([]);
  const [draft, setDraft] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [openingVote, setOpeningVote] = useState(false);

  async function send() {
    const message = draft.trim();
    if (!message) return;
    setDraft("");
    setError(null);
    setTurns((t) => [...t, { role: "user", content: message }]);

    startTransition(async () => {
      try {
        const res = await fetch("/api/ai/fcg-chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tenantSlug, proposalId, userMessage: message }),
        });
        if (!res.ok) {
          const txt = await res.text();
          throw new Error(`HTTP ${res.status}: ${txt.slice(0, 400)}`);
        }
        const data = await res.json();
        setProposalId(data.proposalId);
        setToolCalls(data.toolCalls ?? []);
        setDiffOps(data.diffOps ?? []);
        setTurns((t) => [...t, { role: "assistant", content: data.message ?? "(no text)" }]);
      } catch (e) {
        setError(e instanceof Error ? e.message : "unknown error");
      }
    });
  }

  async function openForVote() {
    if (!proposalId) return;
    setOpeningVote(true);
    setError(null);
    try {
      const res = await fetch(`/api/fcg/proposals/${proposalId}/open?tenant=${tenantSlug}`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(await res.text());
      window.location.href = `/${tenantSlug}/fcg/proposals/${proposalId}`;
    } catch (e) {
      setError(e instanceof Error ? e.message : "open failed");
    } finally {
      setOpeningVote(false);
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
      <div className="card flex flex-col" style={{ minHeight: 480 }}>
        <div className="flex-1 space-y-3 overflow-y-auto pr-1">
          {turns.length === 0 && (
            <p className="text-sm text-ink/50">
              Try: <em>&ldquo;Draft a tone rule that we use plain English in client emails. 24h
              acknowledgement window.&rdquo;</em>
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

        <div className="mt-3 flex gap-2">
          <input
            className="input"
            placeholder="Ask Claude…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            disabled={pending}
          />
          <button className="btn btn-primary" onClick={send} disabled={pending}>
            {pending ? "…" : "Send"}
          </button>
        </div>
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      </div>

      <aside className="card space-y-3">
        <div>
          <div className="label">Proposal</div>
          <div className="text-sm">
            {proposalId ? (
              <Link href={`/${tenantSlug}/fcg/proposals/${proposalId}`} className="font-mono text-xs">
                {proposalId.slice(0, 12)}…
              </Link>
            ) : (
              <span className="text-ink/50">none yet — say something to start one</span>
            )}
          </div>
        </div>
        <div>
          <div className="label">Staged operations ({diffOps.length})</div>
          {diffOps.length === 0 ? (
            <p className="text-xs text-ink/50">Tool calls will appear here.</p>
          ) : (
            <ol className="space-y-1 text-xs">
              {diffOps.map((op, i) => (
                <li key={i} className="rounded bg-ink/5 p-2 font-mono">
                  {(op as { tool?: string }).tool}
                </li>
              ))}
            </ol>
          )}
        </div>
        <div>
          <div className="label">Last turn tool calls</div>
          {toolCalls.length === 0 ? (
            <p className="text-xs text-ink/50">none</p>
          ) : (
            <ul className="space-y-1 text-xs">
              {toolCalls.map((tc, i) => (
                <li key={i} className="rounded bg-ink/5 p-2 font-mono break-words">
                  {tc.name}
                </li>
              ))}
            </ul>
          )}
        </div>
        <button
          className="btn btn-primary w-full"
          disabled={!proposalId || diffOps.length === 0 || openingVote}
          onClick={openForVote}
        >
          {openingVote ? "Opening…" : "Send to vote"}
        </button>
      </aside>
    </div>
  );
}
