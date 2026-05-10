import Link from "next/link";

export const metadata = {
  title: "Status — Acumon Communications",
  description:
    "Public service status, recent incidents, sub-processor list, accessibility statement, and contract version model for Acumon Communications.",
};

export default function StatusLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-paper">
      <header className="border-b border-ink/10 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
          <Link href="/" className="font-semibold tracking-tight no-underline">
            Acumon Communications
          </Link>
          <nav className="flex items-center gap-3 text-sm">
            <Link href="/status" className="no-underline">
              Status
            </Link>
            <Link href="/login" className="btn">
              Sign in
            </Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-5xl p-4 md:p-8">{children}</main>
      <footer className="border-t border-ink/10 bg-white">
        <div className="mx-auto max-w-5xl px-4 py-3 text-xs text-ink/60">
          Public surface — no authentication required. Data sources are documented per-PRD: §13.1
          Service Levels, §12.9 Breach Notification, §15.3 Sub-Processor list, §13.4 Accessibility,
          §15.4 Terms versioning.
        </div>
      </footer>
    </div>
  );
}
