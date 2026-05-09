"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export default function NewDraftClient({ tenantSlug }: { tenantSlug: string }) {
  const router = useRouter();
  const [channel, setChannel] = useState("email");
  const [body, setBody] = useState("");
  const [subject, setSubject] = useState("");
  const [sender, setSender] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    setError(null);
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
        router.push(`/${tenantSlug}/drafts/${data.draft.id}`);
      } catch (e) {
        setError(e instanceof Error ? e.message : "draft failed");
      }
    });
  }

  return (
    <div className="card max-w-2xl space-y-3">
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
      <button className="btn btn-primary w-full" disabled={pending || !body.trim()} onClick={submit}>
        {pending ? "Drafting…" : "Generate draft"}
      </button>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
