"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";

type StagedOp = { tool: string; input: Record<string, unknown> };
type StagedThisTurn = { externalId: string; statement: string; category: string };
// `stagedThisTurn` is the slice of rules whose `propose_rule_change`
// tool call landed on the assistant's most recent reply — visible
// confirmation that the chat did something structural, not just chatty.
// Empty array signals "the assistant responded but didn't stage a
// rule" — the wizard nudges the user to rephrase.
type Turn = {
  role: "user" | "assistant";
  content: string;
  stagedThisTurn?: StagedThisTurn[];
};

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
      "What does the FCG cover? Pick channels and the working language. These bias the chat agent's defaults at every later step; individual rules can still override.",
    chat: false,
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

  // Step 1 selections — channels + working language. Sent to Claude as part
  // of the focus prefix in every later chat call so rules default sensibly.
  const ALL_CHANNELS = ["email", "slack", "teams", "letter", "report", "whatsapp_business"] as const;
  const [channels, setChannels] = useState<string[]>(["email", "slack", "teams", "letter"]);
  const [language, setLanguage] = useState("en-GB");

  function toggleChannel(c: string) {
    setChannels((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));
  }

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

    // Prefix the message with the wizard's focus so Claude scopes
    // its tool calls correctly and ignores off-topic asks for this step.
    const focusBits = [
      step.categories ? `categories=${step.categories.join(",")}` : null,
      channels.length ? `channels=${channels.join(",")}` : null,
      `language=${language}`,
    ]
      .filter(Boolean)
      .join("; ");
    const focused = `[Wizard focus: ${focusBits}] ${message}`;

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
        // Item 114 — surface this turn's stagings inline so the user
        // sees the structural side-effect of the chat, not just the
        // assistant's prose. Without this, a chatty reply with no
        // tool call looked identical to a chatty reply that staged a
        // rule, and the wizard's "Submit" disabled-state was the
        // user's only signal anything was wrong.
        const stagedThisTurn: StagedThisTurn[] = Array.isArray(data.toolCalls)
          ? data.toolCalls
              .filter(
                (tc: { name?: string }) =>
                  tc?.name === "propose_rule_change" || tc?.name === "finalise_fcg",
              )
              .flatMap((tc: { name: string; input: Record<string, unknown> }) => {
                if (tc.name === "propose_rule_change") {
                  const r = tc.input?.rule as
                    | { externalId?: string; statement?: string; category?: string }
                    | undefined;
                  return r
                    ? [
                        {
                          externalId: r.externalId ?? "—",
                          statement: r.statement ?? "(no statement)",
                          category: r.category ?? "—",
                        },
                      ]
                    : [];
                }
                // finalise_fcg can carry many rules — surface them all.
                const rules = (tc.input?.rules ?? []) as Array<{
                  externalId?: string;
                  statement?: string;
                  category?: string;
                }>;
                return rules.map((r) => ({
                  externalId: r.externalId ?? "—",
                  statement: r.statement ?? "(no statement)",
                  category: r.category ?? "—",
                }));
              })
          : [];
        setTurns(step.id, (t) => [
          ...t,
          {
            role: "assistant",
            content: data.message ?? "(no text)",
            stagedThisTurn,
          },
        ]);
      } catch (e) {
        setError(e instanceof Error ? e.message : "unknown error");
      }
    });
  }

  /**
   * Submit-and-adopt: open the proposal for vote, then immediately cast the
   * current user's APPROVE. With a single eligible voter that crosses the
   * simple-majority threshold and the proposal commits in the same flow.
   * With multiple voters, this just records this user's vote and the others
   * can still vote independently from the proposal page.
   */
  async function submitForVote() {
    if (!proposalId) {
      setError("Nothing staged to submit yet — work through the chat steps first.");
      return;
    }
    setOpening(true);
    setError(null);
    try {
      const openRes = await fetch(
        `/api/fcg/proposals/${proposalId}/open?tenant=${tenantSlug}`,
        { method: "POST" },
      );
      if (!openRes.ok) throw new Error(await openRes.text());

      const voteRes = await fetch(`/api/fcg/proposals/${proposalId}/vote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenantSlug, decision: "APPROVE" }),
      });
      const voteData = await voteRes.json().catch(() => ({}));
      if (!voteRes.ok) throw new Error(voteData.error ?? "vote failed");

      // Whether or not the proposal passed (depends on quorum), navigate to
      // the proposal page so the user can see the outcome.
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
          <div className="space-y-4">
            <div>
              <div className="label">Channels covered</div>
              <p className="mb-2 text-xs text-ink/60">
                Tick the channels the FCG governs. The chat helper biases towards these in every
                later step; individual rules can still apply to other channels via overrides.
              </p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {ALL_CHANNELS.map((c) => (
                  <label
                    key={c}
                    className={`flex cursor-pointer items-center gap-2 rounded border px-3 py-2 text-sm ${
                      channels.includes(c) ? "border-accent bg-accent/5" : "border-ink/10"
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      checked={channels.includes(c)}
                      onChange={() => toggleChannel(c)}
                    />
                    <span>{c.replace("_", " ")}</span>
                  </label>
                ))}
              </div>
            </div>

            <div>
              <div className="label">Working language</div>
              <p className="mb-2 text-xs text-ink/60">
                One FCG covers one language. For multilingual firms, run the wizard once per
                language to produce per-language variants (PRD §13.5).
              </p>
              <select
                className="input max-w-xs"
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
              >
                <option value="en-GB">English (UK)</option>
                <option value="en-US">English (US)</option>
                <option value="fr-FR">Français</option>
                <option value="de-DE">Deutsch</option>
                <option value="es-ES">Español</option>
                <option value="it-IT">Italiano</option>
                <option value="nl-NL">Nederlands</option>
                <option value="pt-PT">Português</option>
                <option value="pl-PL">Polski</option>
              </select>
            </div>

            <div className="rounded border border-ink/10 bg-paper p-4 text-xs text-ink/70">
              These selections aren&apos;t saved as separate rules — they&apos;re passed to the
              chat agent as defaults so, for example, when you ask &quot;set 24h acknowledgement
              window&quot; the agent knows to apply it across {channels.length === 0 ? "no" : channels.join(", ")} unless
              you say otherwise.
            </div>
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
                {turns.map((t, i) => {
                  // Item 114 — was this turn's reply the response to a
                  // user message that wasn't an obvious filler/question?
                  // If so AND nothing staged, nudge the user. We can't
                  // perfectly detect "this was a rule statement", but
                  // checking the prior turn's length filters out
                  // one-word follow-ups where no-stage is fine.
                  const priorUser = i > 0 ? turns[i - 1] : null;
                  const looksLikeARuleAttempt =
                    priorUser?.role === "user" && (priorUser.content?.length ?? 0) > 30;
                  const showNothingStagedHint =
                    t.role === "assistant" &&
                    t.stagedThisTurn !== undefined &&
                    t.stagedThisTurn.length === 0 &&
                    looksLikeARuleAttempt;
                  return (
                    <div key={i} className={t.role === "user" ? "text-right" : ""}>
                      <div
                        className={`inline-block max-w-prose whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${
                          t.role === "user" ? "bg-accent text-white" : "bg-ink/5"
                        }`}
                      >
                        {t.content}
                      </div>
                      {t.role === "assistant" && t.stagedThisTurn && t.stagedThisTurn.length > 0 && (
                        <div className="mt-1 inline-block rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs text-emerald-900">
                          <div className="font-medium">
                            Staged {t.stagedThisTurn.length} rule
                            {t.stagedThisTurn.length === 1 ? "" : "s"} this turn:
                          </div>
                          <ul className="mt-0.5 list-disc pl-4">
                            {t.stagedThisTurn.map((s, j) => (
                              <li key={j}>
                                <span className="font-mono">{s.externalId}</span>{" "}
                                <span className="opacity-70">({s.category.toLowerCase()})</span>
                                {" — "}
                                {s.statement}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {showNothingStagedHint && (
                        <div className="mt-1 inline-block rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-900">
                          The assistant replied but didn&apos;t stage a rule this turn.
                          Try restating as one concrete rule, e.g. &quot;External client emails
                          open with &lsquo;Dear Name&rsquo; and sign off &lsquo;Kind
                          regards&rsquo;.&quot;
                        </div>
                      )}
                    </div>
                  );
                })}
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
                Clicking submit opens the proposal for a Firm Culture Team vote AND records your
                APPROVE vote in the same step. If you&apos;re the only eligible voter, the proposal
                commits immediately and becomes the authoritative FCG. With multiple voters, the
                others can still vote independently from the proposal page.
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
              {opening ? "Submitting & voting…" : "Submit & approve"}
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
