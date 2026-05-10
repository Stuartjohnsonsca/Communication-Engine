"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { CommandPalette, CommandPaletteButton } from "./CommandPalette";

export function NavShell({
  tenantSlug,
  tenantName,
  sidebar,
  children,
}: {
  tenantSlug: string;
  tenantName: string;
  sidebar: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  return (
    <div className="min-h-screen md:flex">
      <header className="md:hidden sticky top-0 z-20 flex items-center gap-3 border-b border-ink/10 bg-white px-3 py-2">
        <button
          type="button"
          aria-label="Open navigation"
          aria-controls="tenant-sidebar"
          aria-expanded={open}
          onClick={() => setOpen(true)}
          className="inline-flex items-center justify-center rounded-md border border-ink/15 bg-white p-2"
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>
        <span className="truncate text-sm font-semibold">{tenantName}</span>
        <div className="ml-auto">
          <CommandPaletteButton />
        </div>
      </header>

      {open && (
        <button
          type="button"
          aria-label="Close navigation"
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-30 bg-black/30 md:hidden"
        />
      )}

      <aside
        id="tenant-sidebar"
        className={`${
          open ? "translate-x-0" : "-translate-x-full"
        } fixed inset-y-0 left-0 z-40 h-screen w-64 shrink-0 overflow-y-auto border-r border-ink/10 bg-white p-4 transition-transform md:static md:z-auto md:h-auto md:w-60 md:translate-x-0`}
      >
        <div className="mb-3 flex justify-end md:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setOpen(false)}
            className="inline-flex items-center justify-center rounded-md border border-ink/15 bg-white p-1.5"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="mb-3 hidden md:block">
          <CommandPaletteButton className="inline-flex w-full items-center gap-2 rounded-md border border-ink/15 bg-white px-2 py-1.5 text-xs text-ink/60 hover:bg-ink/5" />
        </div>
        {sidebar}
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto p-4 md:p-8">
        {children}
      </main>

      <CommandPalette tenantSlug={tenantSlug} />
    </div>
  );
}
