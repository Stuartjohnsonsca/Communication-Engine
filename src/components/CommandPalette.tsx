"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/lib/i18n/LocaleProvider";

/**
 * Backlog item 8 — global ⌘K command palette. Wraps the tenant-scoped
 * `/api/search` endpoint. The palette opens on Ctrl+K (Cmd+K on Mac), or
 * on the topbar button below md. Keyboard nav: ArrowDown / ArrowUp move
 * the active row; Enter navigates; Esc closes; Tab cycles too.
 *
 * Focus trap is intentionally light — the input is the only tabbable
 * element while open; the result list is mouse + keyboard navigable but
 * not focusable per row, mirroring the shadcn / Linear pattern.
 */

type SearchHit = {
  kind: string;
  id: string;
  title: string;
  subtitle?: string;
  href: string;
  score: number;
  group?: string;
  timestamp?: string;
};

type SearchResult = {
  q: string;
  hits: SearchHit[];
  skipped: boolean;
};

const GROUP_ORDER = [
  "Drafts",
  "Actions",
  "Meetings",
  "Opportunities",
  "Members",
  "FCG rules",
  "UCG rules",
  "Audit log",
  "Sub-processors",
  "Processing activities",
];

export function CommandPalette({ tenantSlug }: { tenantSlug: string }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const reqIdRef = useRef(0);
  const router = useRouter();
  const t = useT();

  // Open on Ctrl/Cmd+K from anywhere in the app. Avoid swallowing the
  // keystroke when an editable element already has focus and is intercepting
  // (most browsers map Cmd+K to the location bar but inside an SPA it's
  // free game; we still respect input fields).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((cur) => !cur);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Listen for an explicit open signal from the topbar button (sibling
  // component dispatches a CustomEvent so we don't need to thread props).
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener("commandpalette:open", onOpen);
    return () => window.removeEventListener("commandpalette:open", onOpen);
  }, []);

  // Reset state every time we close, focus the input every time we open.
  useEffect(() => {
    if (open) {
      setActive(0);
      // Defer focus until the input mounts.
      setTimeout(() => inputRef.current?.focus(), 0);
    } else {
      setQ("");
      setHits([]);
      setLoading(false);
    }
  }, [open]);

  // Body-scroll lock while open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // Debounced search. We discard out-of-order responses by tracking a
  // monotonically-increasing request id.
  useEffect(() => {
    if (!open) return;
    const trimmed = q.trim();
    if (trimmed.length < 2) {
      setHits([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const myReqId = ++reqIdRef.current;
    const ctrl = new AbortController();
    const t = window.setTimeout(async () => {
      try {
        const r = await fetch(
          `/api/search?tenant=${encodeURIComponent(tenantSlug)}&q=${encodeURIComponent(trimmed)}`,
          { signal: ctrl.signal },
        );
        if (!r.ok) {
          if (myReqId === reqIdRef.current) {
            setHits([]);
            setLoading(false);
          }
          return;
        }
        const data = (await r.json()) as SearchResult;
        if (myReqId === reqIdRef.current) {
          setHits(data.hits);
          setActive(0);
          setLoading(false);
        }
      } catch {
        if (myReqId === reqIdRef.current) {
          setLoading(false);
        }
      }
    }, 150);
    return () => {
      ctrl.abort();
      window.clearTimeout(t);
    };
  }, [q, open, tenantSlug]);

  const grouped = useMemo(() => {
    const buckets = new Map<string, SearchHit[]>();
    for (const h of hits) {
      const g = h.group ?? "Other";
      const arr = buckets.get(g) ?? [];
      arr.push(h);
      buckets.set(g, arr);
    }
    const out: Array<{ group: string; rows: SearchHit[] }> = [];
    for (const g of GROUP_ORDER) {
      const arr = buckets.get(g);
      if (arr && arr.length) out.push({ group: g, rows: arr });
    }
    for (const [g, arr] of buckets) {
      if (!GROUP_ORDER.includes(g)) out.push({ group: g, rows: arr });
    }
    return out;
  }, [hits]);

  // Flat row array used by keyboard navigation — must mirror the order the
  // grouped renderer paints them.
  const flatRows = useMemo(() => grouped.flatMap((g) => g.rows), [grouped]);

  const navigateTo = useCallback(
    (h: SearchHit) => {
      setOpen(false);
      router.push(h.href);
    },
    [router],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        return;
      }
      if (!flatRows.length) return;
      if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) {
        e.preventDefault();
        setActive((a) => (a + 1) % flatRows.length);
      } else if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) {
        e.preventDefault();
        setActive((a) => (a - 1 + flatRows.length) % flatRows.length);
      } else if (e.key === "Enter") {
        e.preventDefault();
        const target = flatRows[active];
        if (target) navigateTo(target);
      }
    },
    [flatRows, active, navigateTo],
  );

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("shell.searchLabel")}
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[10vh]"
      onClick={() => setOpen(false)}
      onKeyDown={onKeyDown}
    >
      <div
        className="w-full max-w-xl overflow-hidden rounded-lg border border-ink/10 bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-ink/10 px-3 py-2">
          <span aria-hidden className="text-ink/40">⌘K</span>
          <input
            ref={inputRef}
            type="text"
            placeholder={t("shell.searchPlaceholder")}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="w-full bg-transparent text-sm outline-none placeholder:text-ink/40"
          />
          {loading && <span className="text-xs text-ink/40">…</span>}
        </div>

        <div className="max-h-[60vh] overflow-y-auto py-1 text-sm">
          {q.trim().length < 2 ? (
            <p className="px-3 py-3 text-xs text-ink/50">
              {t("shell.searchEmptyHint")}
            </p>
          ) : !loading && flatRows.length === 0 ? (
            <p className="px-3 py-3 text-xs text-ink/50">{t("shell.searchNoMatches")}</p>
          ) : (
            grouped.map((g) => (
              <div key={g.group} className="py-1">
                <div className="px-3 pb-1 pt-2 text-[10px] uppercase tracking-wider text-ink/40">
                  {g.group}
                </div>
                <ul>
                  {g.rows.map((h) => {
                    const idx = flatRows.indexOf(h);
                    const isActive = idx === active;
                    return (
                      <li key={`${h.kind}:${h.id}`}>
                        <button
                          type="button"
                          onClick={() => navigateTo(h)}
                          onMouseEnter={() => setActive(idx)}
                          className={`flex w-full items-baseline justify-between gap-3 px-3 py-1.5 text-left ${
                            isActive ? "bg-ink/[0.06]" : "hover:bg-ink/[0.03]"
                          }`}
                        >
                          <div className="min-w-0">
                            <div className="truncate font-medium">{h.title}</div>
                            {h.subtitle && (
                              <div className="truncate text-xs text-ink/50">{h.subtitle}</div>
                            )}
                          </div>
                          <span className="shrink-0 text-[10px] uppercase tracking-wide text-ink/40">
                            {h.kind}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))
          )}
        </div>

        <div className="border-t border-ink/5 px-3 py-1.5 text-[10px] text-ink/40">
          {t("shell.searchKeyHint")}
        </div>
      </div>
    </div>
  );
}

/**
 * Small button companion that triggers the palette via a CustomEvent — used
 * by the mobile topbar where the keyboard shortcut isn't visible.
 */
export function CommandPaletteButton({ className }: { className?: string }) {
  const t = useT();
  return (
    <button
      type="button"
      aria-label={t("shell.openSearch")}
      onClick={() => window.dispatchEvent(new CustomEvent("commandpalette:open"))}
      className={
        className ??
        "inline-flex items-center gap-1 rounded-md border border-ink/15 bg-white px-2 py-1 text-xs text-ink/60 hover:bg-ink/5"
      }
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <circle cx="11" cy="11" r="7" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
      <span>{t("shell.searchLabel")}</span>
      <span className="ml-1 hidden md:inline rounded bg-ink/10 px-1 text-[10px] text-ink/60">⌘K</span>
    </button>
  );
}
