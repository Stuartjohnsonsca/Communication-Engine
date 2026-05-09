"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export type StatusFilter = "OPEN" | "COMPLETED" | "DISMISSED" | "ALL";

export type ActionRow = {
  id: string;
  title: string;
  detail: string | null;
  type: string;
  status: string;
  dueAt: string | null;
  createdAt: string;
  completedAt: string | null;
  draft: { id: string; subject: string | null } | null;
};

const TYPE_OPTIONS = ["task", "calendar", "followup", "research"] as const;
type ActionType = (typeof TYPE_OPTIONS)[number];

export default function ActionsClient({
  tenantSlug,
  filter,
  totals,
  actions,
}: {
  tenantSlug: string;
  filter: StatusFilter;
  totals: Record<StatusFilter, number>;
  actions: ActionRow[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [type, setType] = useState<ActionType>("task");
  const [dueAt, setDueAt] = useState("");

  function refresh() {
    router.refresh();
  }

  function setStatus(id: string, status: "COMPLETED" | "DISMISSED" | "OPEN") {
    setError(null);
    setBusyId(id);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/actions/${id}/status`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tenantSlug, status }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setError(`Could not update action: ${data.error ?? res.statusText}`);
          return;
        }
        refresh();
      } finally {
        setBusyId(null);
      }
    });
  }

  function createAction(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setError(null);
    startTransition(async () => {
      const res = await fetch("/api/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tenantSlug,
          title: title.trim(),
          detail: detail.trim() || undefined,
          type,
          dueAt: dueAt ? new Date(dueAt).toISOString() : undefined,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(`Could not create action: ${data.error ?? res.statusText}`);
        return;
      }
      setTitle("");
      setDetail("");
      setType("task");
      setDueAt("");
      setShowForm(false);
      refresh();
    });
  }

  const filterTabs: { key: StatusFilter; label: string }[] = [
    { key: "OPEN", label: "Open" },
    { key: "COMPLETED", label: "Completed" },
    { key: "DISMISSED", label: "Dismissed" },
    { key: "ALL", label: "All" },
  ];

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Actions</h1>
          <p className="mt-1 text-xs text-ink/60">
            Tasks extracted from drafts, plus anything you add manually. Status changes are
            audited.
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowForm((v) => !v)}>
          {showForm ? "Cancel" : "New action"}
        </button>
      </div>

      {showForm && (
        <form className="card space-y-3" onSubmit={createAction}>
          <div>
            <label className="label">Title</label>
            <input
              className="input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={280}
              required
              autoFocus
            />
          </div>
          <div>
            <label className="label">Detail (optional)</label>
            <textarea
              className="input"
              rows={2}
              value={detail}
              onChange={(e) => setDetail(e.target.value)}
              maxLength={2000}
            />
          </div>
          <div className="flex flex-wrap gap-3">
            <div className="grow">
              <label className="label">Type</label>
              <select
                className="input"
                value={type}
                onChange={(e) => setType(e.target.value as ActionType)}
              >
                {TYPE_OPTIONS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <div className="grow">
              <label className="label">Due (optional)</label>
              <input
                type="date"
                className="input"
                value={dueAt}
                onChange={(e) => setDueAt(e.target.value)}
              />
            </div>
          </div>
          <button className="btn btn-primary" disabled={pending || !title.trim()}>
            {pending ? "Adding…" : "Add action"}
          </button>
        </form>
      )}

      <div className="flex flex-wrap gap-2 text-sm">
        {filterTabs.map((t) => {
          const active = t.key === filter;
          return (
            <Link
              key={t.key}
              href={`/${tenantSlug}/actions?status=${t.key}`}
              className={`rounded px-3 py-1 ${
                active ? "bg-ink text-white" : "bg-ink/5 hover:bg-ink/10"
              }`}
            >
              {t.label}{" "}
              <span className={active ? "text-white/70" : "text-ink/50"}>
                ({totals[t.key]})
              </span>
            </Link>
          );
        })}
      </div>

      {error && (
        <div className="card border-red-300">
          <p className="text-sm text-red-600">{error}</p>
        </div>
      )}

      {actions.length === 0 ? (
        <p className="card text-sm text-ink/60">
          {filter === "OPEN"
            ? "No open actions. Extract some from a draft, or add one above."
            : "Nothing here."}
        </p>
      ) : (
        <ul className="space-y-2">
          {actions.map((a) => {
            const isBusy = busyId === a.id;
            const overdue =
              a.status === "OPEN" && a.dueAt && new Date(a.dueAt) < today;
            return (
              <li key={a.id} className="card">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="font-medium">{a.title}</span>
                      <span className="tag">{a.type}</span>
                      {overdue && <span className="tag bg-red-100 text-red-700">overdue</span>}
                      {a.status !== "OPEN" && <span className="tag">{a.status}</span>}
                    </div>
                    {a.detail && <div className="mt-1 text-sm text-ink/70">{a.detail}</div>}
                    <div className="mt-1 text-xs text-ink/50">
                      {a.dueAt && <>due {a.dueAt.slice(0, 10)} · </>}
                      added {a.createdAt.slice(0, 10)}
                      {a.completedAt && <> · completed {a.completedAt.slice(0, 10)}</>}
                      {a.draft && (
                        <>
                          {" · from draft "}
                          <Link
                            href={`/${tenantSlug}/drafts`}
                            className="underline decoration-dotted"
                          >
                            {a.draft.subject ?? "(no subject)"}
                          </Link>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-start gap-2">
                    {a.status === "OPEN" && (
                      <>
                        <button
                          className="btn btn-primary"
                          disabled={isBusy}
                          onClick={() => setStatus(a.id, "COMPLETED")}
                        >
                          {isBusy ? "…" : "Complete"}
                        </button>
                        <button
                          className="btn"
                          disabled={isBusy}
                          onClick={() => setStatus(a.id, "DISMISSED")}
                        >
                          Dismiss
                        </button>
                      </>
                    )}
                    {a.status !== "OPEN" && (
                      <button
                        className="btn"
                        disabled={isBusy}
                        onClick={() => setStatus(a.id, "OPEN")}
                      >
                        {isBusy ? "…" : "Reopen"}
                      </button>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
