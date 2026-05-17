import Link from "next/link";
import type { NavNode } from "@/lib/nav-tree";
import type { NavBadges } from "@/lib/notifications";

/**
 * Backlog item 112 — tile-grid landing page for each grouped nav node.
 *
 * Server component. Rendered from /work, /culture, /quality, /privacy,
 * /operations and /admin. Reuses the `NavBadges.byHref` map so per-tile
 * counts agree with the sidebar.
 *
 * Tiles render in a 1-column → 2-column → 3-column responsive grid. Each
 * tile carries the same badge as the corresponding sidebar entry would
 * have had on the old flat nav, with `stale` tone preserved.
 */
export function NavTilePage({
  node,
  badges,
}: {
  node: NavNode;
  badges: NavBadges;
}) {
  if (node.sections && node.sections.length > 0) {
    return (
      <div className="space-y-8 max-w-5xl">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">{node.label}</h1>
          <p className="mt-2 text-sm text-ink/70">{node.description}</p>
        </header>
        {node.sections.map((sec) => (
          <section key={sec.id} className="space-y-3">
            <h2 className="text-sm font-medium uppercase tracking-wide text-ink/60">
              {sec.label}
            </h2>
            <TileGrid items={sec.items} badges={badges} />
          </section>
        ))}
      </div>
    );
  }
  return (
    <div className="space-y-6 max-w-5xl">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{node.label}</h1>
        <p className="mt-2 text-sm text-ink/70">{node.description}</p>
      </header>
      <TileGrid items={node.items ?? []} badges={badges} />
    </div>
  );
}

function TileGrid({
  items,
  badges,
}: {
  items: { id: string; href: string; label: string; description: string }[];
  badges: NavBadges;
}) {
  return (
    <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((it) => {
        const badge = badges.byHref[it.href] ?? 0;
        const stale = badges.tones[it.href] === "stale";
        return (
          <li key={it.id}>
            <Link
              href={it.href}
              className="block h-full rounded-md border border-ink/10 bg-white p-4 transition hover:border-ink/30 hover:bg-ink/[0.02]"
            >
              <div className="flex items-start justify-between gap-2">
                <h3 className="text-sm font-medium">{it.label}</h3>
                {badge > 0 && (
                  <span
                    className={
                      stale
                        ? "inline-flex min-w-[1.25rem] justify-center rounded-full bg-red-700 px-1.5 py-0.5 text-[10px] font-medium leading-none text-white"
                        : "inline-flex min-w-[1.25rem] justify-center rounded-full bg-ink px-1.5 py-0.5 text-[10px] font-medium leading-none text-white"
                    }
                    title={
                      stale ? "Includes item(s) outstanding > 4h" : undefined
                    }
                  >
                    {badge > 99 ? "99+" : badge}
                  </span>
                )}
              </div>
              <p className="mt-2 text-xs text-ink/70">{it.description}</p>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
