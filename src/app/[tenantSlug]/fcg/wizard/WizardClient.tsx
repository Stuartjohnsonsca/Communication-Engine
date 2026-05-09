"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";

type StagedOp = { tool: string; input: Record<string, unknown> };
type Turn = { role: "user" | "assistant"; content: string };

type Step = {
  id: string;
  title: string;
  subtitle: string;
  chat: boolean;
  categories?: string[]; // FCGCategory enum values used to filter staged rules
  starters?: string[];
  helper?: string; // additional guidance text
};

const STEPS: Step[] = [
  {
    id: "intro",
    title: "Channels & language",
    subtitle:
      "What does the FCG cover? Pick channels and the working language(s). You can change these later.",
    chat: false,
    helper:
      "Per PRD §13.5 each rule can carry channel-specific overrides — these are set later in each step.",
  },
  {
    id: "tone",
    title: "Tone & voice",
    subtitle:
      "How does the firm sound on the page? Plain English vs technical, formal vs warm, default register.",
    chat: true,
    categories: ["TONE"],
    starters: [
      "Draft a tone rule that we use plain English with clients — short sentences, no jargon unless the client uses it first.",
      "Set our default register as professional and warm; never curt.",
      "On internal Slack we can be informal; on external email and letters we are formal.",
    ],
  },
  {
    id: "response_time",
    title: "Response times",
    subtitle:
      "How quickly the firm acknowledges and substantively responds, per channel. The drafting agent will create holding messages when these windows are at risk.",
    chat: true,
    categories: ["RESPONSE_TIME"],
    starters: [
      "Acknowledge all external client emails within 24 hours.",
      "Substantive technical responses within 5 working days; if longer, send a holding message naming the new date.",
      "Internal Slack from colleagues within 4 hours during business hours.",
    ],
  },
  {
    id: "greeting",
    title: "Salutations & sign-offs",
    subtitle: "How we open and close communications across each channel.",
    chat: true,
    categories: ["SALUTATION", "SIGNOFF"],
    starters: [
      "External client emails open with 'Dear <Name>' and sign off with 'Kind regards'.",
      "Internal Slack uses first names only; no salutation needed.",
      "Formal letters open with 'Dear <Name>' and sign off with 'Yours sincerely'.",
    ],
  },
  {
    id: "phrases",
    title: "Mandatory & prohibited phrases",
    subtitle: "Specific language we always include, and language we never use.",
    chat: true,
    categories: ["MANDATORY_PHRASE", "PROHIBITED_PHRASE"],
    starters: [
      "All external advice emails must include 'this is general guidance, not specific advice for your circumstances'.",
      "Never use the word 'guarantee' in client communications.",
      "Always include the regulatory disclaimer on formal letters.",
    ],
  },
  {
    id: "esc_reg_sig",
    title: "Escalation, regulatory & signature",
    subtitle:
      "How we escalate, mandatory regulatory phrases, and default signature blocks.",
    chat: true,
    categories: ["ESCALATION", "REGULATORY", "SIGNATURE"],
    starters: [
      "If a client raises a formal complaint, escalate to a Partner within 4 hours.",
      "All audit-related external emails include the firm's FRC reference.",
      "Default email signature: Name · Role · Acumon Intelligence · Regulator reference.",
    ],
  },
  {
    id: "review",
    title: "Review & submit for vote",
    subtitle:
      "Review every staged rule. When you're ready, submit the proposal to the Firm Culture Team for a quorum vote.",
    chat: false,
  },
];

function categoryOfOp(op: StagedOp): string | null {
  const r = op?.input?.rule as { category?: string } | undefined;
  return r?.category ?? null;
}

function ruleOfOp(op: StagedOp) {
  return (op?.input?.rule ?? null) as
    | { externalId?: string; category?: string; channel?: string; statement?: string; mandatory?: boolean }
    | null;
}

export default function WizardClient({
  tenantSlug,
  initialProposalId,
  initialOps,
  committedVersion,
  committedRuleCount,
}: {
  tenantSlug: string;
  initialProposalId?: string;
  initialOps: StagedOp[];
  committedVersion: number | null;
  committedRuleCount: number;
}) {
  const [stepIndex, setStepIndex] = useState(0);
  const [proposalId, setProposalId] = useState<string | undefined>(initialProposalId);
  const [ops, setOps] = useState<StagedOp[]>(initialOps);
  const [turnsByStep, setTurnsByStep] = useState<Record<string, Turn[]>>({});
  const [draft, setDraft] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);

  const step = STEPS[stepIndex];
  const turns = turnsByStep[step.id] ?? [];

  const stepRules = useMemo(() => {
    if (!step.categories) return [];
    return ops
      .map((op) => ({ op, rule: ruleOfOp(op) }))
      .filter(({ rule }) => rule && step.categories!.includes(rule.category ?? ""))
      .map(({ rule }) => rule!);
  }, [ops, step]);

  function setTurns(stepId: string, fn: (prev: Turn[]) => Turn[]) {
    setTurnsByStep((m) => ({ ...m, [stepId]: fn(m[stepId] ?? []) }));
  }

  async function send() {
    const message = draft.trim();
    if (!message) return;
    setDraft("");
    setError(null);
    setTurns(step.id, (t) => [...t, { role: "user", content: message }]);

    // Prefix the message with the wizard's category focus so Claude scopes
    // its tool calls correctly and ignores off-topic asks for this step.
    const focused = step.categories
      ? `[Wizard focus: ${step.categories.join(", ")}] ${message}`
      : message;

    startTransition(async () => {
      try {
        const res = await fetch("/api/ai/fcg-chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tenantSlug, proposalId, userMessage: focused }),
        });
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        setProposalId(data.proposalId);
        setOps(data.diffOps ?? []);
        setTurns(step.id, (t) => [...t, { role: "assistant", content: data.message ?? "(no text)" }]);
      } catch (e) {
        setError(e instanceof Error ? e.message : "unknown error");
      }
    });
  }

  async function submitForVote() {
    if (!proposalId) {
      setError("Nothing staged to submit yet — work through the chat steps first.");
      return;
    }
    setOpening(true);
    setError(null);
    try {
      const res = await fetch(`/api/fcg/proposals/${proposalId}/open?tenant=${tenantSlug}`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(await res.text());
      window.location.href = `/${tenantSlug}/fcg/proposals/${proposalId}`;
    } catch (e) {
      setError(e instanceof Error ? e.message : "submit failed");
    } finally {
      setOpening(false);
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
      {/* Sidebar: step list */}
      <aside className="card space-y-1 self-start">
        <div className="label">Wizard</div>
        <p className="text-xs text-ink/60">
          {committedVersion === null
            ? "Drafting your firm's first FCG."
            : `Drafting an amendment to FCG v${committedVersion} (${committedRuleCount} rules).`}
        </p>
        <ol className="mt-3 space-y-1 text-sm">
          {STEPS.map((s, i) => {
            const ruleCount = s.categories
              ? ops.filter((op) => {
                  const c = categoryOfOp(op);
                  return c && s.categories!.includes(c);
                }).length
              : 0;
            const active = i === stepIndex;
            return (
              <li key={s.id}>
                <button
                  onClick={() => setStepIndex(i)}
                  className={`w-full rounded px-2 py-1.5 text-left ${
                    active ? "bg-accent text-white" : "hover:bg-ink/5"
                  }`}
                >
                  <span className="font-mono text-[10px] opacity-60">{i + 1}.</span> {s.title}
                  {s.categories && ruleCount > 0 && (
                    <span className={`ml-2 text-xs ${active ? "text-white/80" : "text-ink/50"}`}>
                      ({ruleCount})
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ol>
        <div className="mt-4 border-t border-ink/10 pt-3 text-xs text-ink/60">
          {ops.length} operation{ops.length === 1 ? "" : "s"} staged in total.
        </div>
      </aside>

      {/* Main step content */}
      <section className="card space-y-4 min-h-[520px]">
        <div>
          <div className="text-xs uppercase tracking-wider text-ink/50">
            Step {stepIndex + 1} of {STEPS.length}
          </div>
          <h2 className="mt-1 text-xl font-semibold">{step.title}</h2>
          <p className="mt-1 text-sm text-ink/70">{step.subtitle}</p>
          {step.helper && <p className="mt-1 text-xs text-ink/50">{step.helper}</p>}
        </div>

        {step.id === "intro" && (
          <div className="rounded border border-ink/10 bg-paper p-4 text-sm">
            <p>
              Each step focuses on one type of culture rule. The wizard&apos;s chat helper drafts
              rules in that category and stages them on a single proposal. Channels you mention
              (email, Slack, Teams, letters, reports) are captured per-rule via the chat — no
              separate &quot;channel selection&quot; up front.
            </p>
            <p className="mt-3">
              When all categories feel right, the final step submits the proposal to the Firm
              Culture Team for a quorum vote.
            </p>
          </div>
        )}

        {step.chat && (
          <>
            <div className="flex flex-col rounded border border-ink/10 bg-paper" style={{ minHeight: 280 }}>
              <div className="flex-1 space-y-2 overflow-y-auto p-3">
                {turns.length === 0 && step.starters && (
                  <div className="text-xs text-ink/60">
                    <p className="font-medium">Try:</p>
                    <ul className="mt-1 space-y-1">
                      {step.starters.map((s, i) => (
                        <li key={i}>
                          <button
                            type="button"
                            onClick={() => setDraft(s)}
                            className="text-left underline-offset-2 hover:underline"
                          >
                            • {s}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
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
                className="flex gap-2 border-t border-ink/10 p-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  send();
                }}
              >
                <input
                  className="input"
                  placeholder={`Describe a ${step.categories?.join("/").toLowerCase() ?? "culture"} rule…`}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                />
                <button className="btn btn-primary" type="submit" disabled={pending || !draft.trim()}>
                  {pending ? "…" : "Send"}
                </button>
              </form>
            </div>

            {stepRules.length > 0 && (
              <div>
                <div className="label">Staged in this category ({stepRules.length})</div>
                <ul className="space-y-1 text-sm">
                  {stepRules.map((r, i) => (
                    <li key={i} className="rounded border border-ink/10 bg-white p-2">
                      <div className="text-xs text-ink/50">
                        <span className="font-mono">{r.externalId ?? "—"}</span>
                        {" · "}
                        <span className="tag">{r.category}</span>
                        {r.channel && r.channel !== "any" && (
                          <span className="tag ml-1">{r.channel}</span>
                        )}
                        {r.mandatory && <span className="tag ml-1 bg-amber-100">mandatory</span>}
                      </div>
                      <div className="mt-1">{r.statement}</div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}

        {step.id === "review" && (
          <div className="space-y-4">
            <div className="rounded border border-ink/10 bg-paper p-4 text-sm">
              <p>
                <strong>{ops.length}</strong> rule operation{ops.length === 1 ? "" : "s"} staged
                across all categories.
              </p>
              <p className="mt-2 text-ink/70">
                Submitting opens the proposal for a Firm Culture Team vote. With a single FCT
                member, your own vote is sufficient to commit. Once committed, the FCG becomes the
                authority for User Culture Guides and drafting.
              </p>
            </div>
            {ops.length === 0 ? (
              <p className="text-sm text-ink/60">
                Nothing staged yet — go back to the earlier steps and chat about each category.
              </p>
            ) : (
              <div className="space-y-3">
                {STEPS.filter((s) => s.categories).map((s) => {
                  const rs = ops
                    .map((op) => ruleOfOp(op))
                    .filter((r): r is NonNullable<ReturnType<typeof ruleOfOp>> =>
                      !!r && s.categories!.includes(r.category ?? ""),
                    );
                  if (rs.length === 0) return null;
                  return (
                    <div key={s.id}>
                      <div className="label">{s.title} ({rs.length})</div>
                      <ul className="space-y-1 text-sm">
                        {rs.map((r, i) => (
                          <li key={i} className="rounded border border-ink/10 bg-white p-2">
                            <div className="text-xs text-ink/50">
                              <span className="font-mono">{r.externalId ?? "—"}</span>{" "}
                              <span className="tag">{r.category}</span>
                            </div>
                            <div>{r.statement}</div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </div>
            )}

            <button
              className="btn btn-primary"
              disabled={ops.length === 0 || opening}
              onClick={submitForVote}
            >
              {opening ? "Submitting…" : "Submit for Firm Culture Team vote"}
            </button>
          </div>
        )}

        {error && <p className="text-sm text-red-600">{error}</p>}

        <div className="flex items-center justify-between border-t border-ink/10 pt-4">
          <button
            className="btn"
            onClick={() => setStepIndex((i) => Math.max(0, i - 1))}
            disabled={stepIndex === 0}
          >
            ← Back
          </button>
          {stepIndex < STEPS.length - 1 ? (
            <button className="btn" onClick={() => setStepIndex((i) => i + 1)}>
              Next →
            </button>
          ) : (
            <Link className="btn" href={`/${tenantSlug}/fcg`}>
              Exit wizard
            </Link>
          )}
        </div>
      </section>
    </div>
  );
}
