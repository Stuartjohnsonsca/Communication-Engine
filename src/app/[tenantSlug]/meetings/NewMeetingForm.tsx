"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

type ParticipantDraft = {
  name: string;
  email: string;
  isExternal: boolean;
};

function defaultStartsAt(): string {
  // Tomorrow at 10:00 local, formatted for <input type="datetime-local">.
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(10, 0, 0, 0);
  const pad = (n: number) => `${n}`.padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function NewMeetingForm({ tenantSlug }: { tenantSlug: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [location, setLocation] = useState("");
  const [startsAt, setStartsAt] = useState(defaultStartsAt());
  const [durationMin, setDurationMin] = useState(60);
  const [leadTimeWorkingDays, setLeadTimeWorkingDays] = useState(3);
  const [participants, setParticipants] = useState<ParticipantDraft[]>([
    { name: "", email: "", isExternal: false },
  ]);

  function addParticipant() {
    setParticipants((ps) => [...ps, { name: "", email: "", isExternal: false }]);
  }
  function updateParticipant(i: number, patch: Partial<ParticipantDraft>) {
    setParticipants((ps) => ps.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));
  }
  function removeParticipant(i: number) {
    setParticipants((ps) => ps.filter((_, idx) => idx !== i));
  }

  function submit() {
    setError(null);
    const cleaned = participants
      .map((p) => ({ ...p, name: p.name.trim(), email: p.email.trim() }))
      .filter((p) => p.name.length > 0)
      .map((p) => ({
        name: p.name,
        email: p.email || null,
        isExternal: p.isExternal,
        isMeetingCreator: false,
      }));

    startTransition(async () => {
      try {
        const res = await fetch("/api/meetings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            tenantSlug,
            title,
            description: description || null,
            location: location || null,
            startsAt: new Date(startsAt).toISOString(),
            durationMin,
            leadTimeWorkingDays,
            participants: cleaned,
          }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(typeof data.error === "string" ? data.error : res.statusText);
        }
        const data = await res.json();
        router.push(`/${tenantSlug}/meetings/${data.meeting.id}`);
      } catch (e) {
        setError(e instanceof Error ? e.message : "could not schedule meeting");
      }
    });
  }

  if (!open) {
    return (
      <button className="btn btn-primary" onClick={() => setOpen(true)}>
        Schedule meeting
      </button>
    );
  }

  return (
    <div className="card max-w-3xl space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-medium">Schedule a meeting</h2>
        <button className="btn text-xs" onClick={() => setOpen(false)} disabled={pending}>
          Close
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className="label">Title</label>
          <input
            className="input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Q3 review with ACME"
          />
        </div>

        <div>
          <label className="label">Starts at</label>
          <input
            type="datetime-local"
            className="input"
            value={startsAt}
            onChange={(e) => setStartsAt(e.target.value)}
          />
        </div>
        <div>
          <label className="label">Duration (min)</label>
          <input
            type="number"
            min={5}
            max={480}
            className="input"
            value={durationMin}
            onChange={(e) => setDurationMin(Number(e.target.value) || 60)}
          />
        </div>

        <div>
          <label className="label">Location</label>
          <input
            className="input"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="Teams, Boardroom 3, etc."
          />
        </div>
        <div>
          <label className="label">FCG lead time (working days)</label>
          <input
            type="number"
            min={0}
            max={15}
            className="input"
            value={leadTimeWorkingDays}
            onChange={(e) => setLeadTimeWorkingDays(Number(e.target.value) || 3)}
          />
          <p className="mt-1 text-xs text-ink/50">
            Default 3. Meetings within the window are flagged short-notice.
          </p>
        </div>

        <div className="sm:col-span-2">
          <label className="label">Description / context</label>
          <textarea
            className="input"
            rows={4}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Who, why, what's at stake. The drafter uses this to ground the agenda and paper."
          />
        </div>

        <div className="sm:col-span-2">
          <div className="flex items-center justify-between">
            <span className="label mb-0">Participants (besides yourself)</span>
            <button className="btn text-xs" onClick={addParticipant} disabled={pending}>
              Add participant
            </button>
          </div>
          <ul className="mt-2 space-y-2">
            {participants.map((p, i) => (
              <li key={i} className="grid grid-cols-12 gap-2">
                <input
                  className="input col-span-4"
                  placeholder="Name"
                  value={p.name}
                  onChange={(e) => updateParticipant(i, { name: e.target.value })}
                />
                <input
                  className="input col-span-5"
                  placeholder="email (optional)"
                  value={p.email}
                  onChange={(e) => updateParticipant(i, { email: e.target.value })}
                />
                <label className="col-span-2 flex items-center gap-1 text-xs">
                  <input
                    type="checkbox"
                    checked={p.isExternal}
                    onChange={(e) => updateParticipant(i, { isExternal: e.target.checked })}
                  />
                  external
                </label>
                <button
                  className="btn col-span-1 text-xs"
                  onClick={() => removeParticipant(i)}
                  disabled={pending}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="flex gap-2">
        <button
          className="btn btn-primary"
          onClick={submit}
          disabled={pending || !title.trim()}
        >
          {pending ? "Scheduling…" : "Schedule meeting"}
        </button>
        <button className="btn" onClick={() => setOpen(false)} disabled={pending}>
          Cancel
        </button>
      </div>
    </div>
  );
}
