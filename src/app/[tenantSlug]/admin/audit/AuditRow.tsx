"use client";

import { useState } from "react";

export type AuditRowEvent = {
  id: string;
  seq: string;
  eventType: string;
  createdAt: string;
  subjectType: string;
  subjectId: string;
  actorEmail: string | null;
  hash: string;
  prevHash: string;
  payloadJson: string;
};

export default function AuditRow({ event }: { event: AuditRowEvent }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr className="border-t border-ink/5 hover:bg-ink/5">
        <td className="py-1 pr-3 align-top font-mono text-xs">{event.seq}</td>
        <td className="py-1 pr-3 align-top text-xs">{event.createdAt}</td>
        <td className="py-1 pr-3 align-top">{event.eventType}</td>
        <td className="py-1 pr-3 align-top text-xs">
          <span className="text-ink/80">{event.subjectType}</span>{" "}
          <span className="font-mono text-ink/50">{event.subjectId.slice(0, 8)}</span>
        </td>
        <td className="py-1 pr-3 align-top text-xs">{event.actorEmail ?? "—"}</td>
        <td className="py-1 pr-3 align-top font-mono text-[10px] text-ink/50">
          {event.hash.slice(0, 12)}…
        </td>
        <td className="py-1 pr-3 align-top text-right">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="text-xs text-ink/60 underline-offset-2 hover:underline"
            aria-expanded={open}
            aria-controls={`audit-payload-${event.id}`}
          >
            {open ? "Hide" : "Show"}
          </button>
        </td>
      </tr>
      {open && (
        <tr id={`audit-payload-${event.id}`} className="border-t border-ink/5 bg-ink/2">
          <td colSpan={7} className="py-2 pr-3">
            <div className="space-y-2 text-xs">
              <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
                <div>
                  <span className="text-ink/50">Subject id:</span>{" "}
                  <span className="font-mono">{event.subjectId}</span>
                </div>
                <div>
                  <span className="text-ink/50">Hash:</span>{" "}
                  <span className="font-mono">{event.hash}</span>
                </div>
                <div className="sm:col-span-2">
                  <span className="text-ink/50">Prev hash:</span>{" "}
                  <span className="font-mono">{event.prevHash}</span>
                </div>
              </div>
              <pre className="overflow-x-auto rounded bg-ink/5 p-2 font-mono text-[11px] leading-snug">
                {event.payloadJson}
              </pre>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
