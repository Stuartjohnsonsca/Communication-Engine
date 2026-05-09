"use client";

import { useState, useTransition } from "react";

type DraftOut = {
  type: string;
  channel: string;
  subject?: string | null;
  body: string;
  citations: { marker: string; source: string; locator?: string; claim: string }[];
  actions: { title: string; detail?: string; type: string; dueAt?: string | null }[];
  holdingRequired: boolean;
  holdingReason?: string | null;
  researchTaskRequired: boolean;
  noGoSubjectHit: boolean;
};

const SAMPLE = `From: Anna Patel <anna.patel@bigcorp.example>
Subject: Q3 advice — when can you reply?

Hi, I sent over the draft engagement letter on Tuesday and haven't heard back.
Can you confirm receipt and let me know when we'll have a substantive answer?
Our board meets next Friday.

Thanks,
Anna`;

export default function NewDraftClient({ tenantSlug }: { tenantSlug: string }) {
  const [channel, setChannel] = useState("email");
  const [body, setBody] = useState(SAMPLE);
  const [subject, setSubject] = useState("Re: Q3 advice — when can you reply?");
  const [sender, setSender] = useState("anna.patel@bigcorp.example");
  const [draft, setDraft] = useState<DraftOut | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    setError(null);
    setDraft(null);
    startTransition(async () => {
      try {
        const res = await fetch("/api/ai/draft", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            tenantSlug,
            inbound: { channel, sender, subject, body, receivedAt: new Date().toISOString() },
          }),
        });
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        setDraft(data.output);
      } catch (e) {
        setError(e instanceof Error ? e.message : "draft failed");
      }
    });
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="card space-y-3">
        <h2 className="text-base font-medium">Inbound</h2>
        <div>
          <label className="label">Channel</label>
          <select className="input" value={channel} onChange={(e) => setChannel(e.target.value)}>
            <option value="email">email</option>
            <option value="slack">slack</option>
            <option value="teams">teams</option>
            <option value="letter">letter</option>
            <option value="report">report</option>
          </select>
        </div>
        <div>
          <label className="label">From</label>
          <input className="input" value={sender} onChange={(e) => setSender(e.target.value)} />
        </div>
        <div>
          <label className="label">Subject</label>
          <input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} />
        </div>
        <div>
          <label className="label">Body</label>
          <textarea
            className="input"
            rows={10}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </div>
        <button className="btn btn-primary w-full" disabled={pending} onClick={submit}>
          {pending ? "Drafting…" : "Generate draft"}
        </button>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>

      <div className="card">
        <h2 className="text-base font-medium">Draft</h2>
        {!draft && !pending && <p className="mt-2 text-sm text-ink/50">Submit to see the draft.</p>}
        {pending && <p className="mt-2 text-sm text-ink/50">Calling Claude…</p>}
        {draft && (
          <div className="mt-3 space-y-3">
            <div className="flex flex-wrap gap-2 text-xs">
              <span className="tag">{draft.type}</span>
              <span className="tag">{draft.channel}</span>
              {draft.holdingRequired && <span className="tag bg-amber-100">holding</span>}
              {draft.researchTaskRequired && <span className="tag bg-violet-100">research required</span>}
              {draft.noGoSubjectHit && <span className="tag bg-red-100">no-go subject</span>}
            </div>
            {draft.subject && (
              <div className="text-sm">
                <span className="label">Subject</span>
                {draft.subject}
              </div>
            )}
            <pre className="whitespace-pre-wrap rounded bg-ink/5 p-3 text-sm">{draft.body}</pre>
            {draft.actions.length > 0 && (
              <div>
                <div className="label">Actions ({draft.actions.length})</div>
                <ul className="space-y-1 text-sm">
                  {draft.actions.map((a, i) => (
                    <li key={i}>
                      <span className="tag mr-2">{a.type}</span>
                      {a.title}
                      {a.dueAt && (
                        <span className="ml-2 text-xs text-ink/50">due {a.dueAt}</span>
                      )}
                    </li>
                  ))}
                </ul>
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
        )}
      </div>
    </div>
  );
}
