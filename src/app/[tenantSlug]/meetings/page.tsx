import Link from "next/link";
import { redirect } from "next/navigation";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import NewMeetingForm from "./NewMeetingForm";

const STATUS_BADGE: Record<string, string> = {
  NONE: "bg-ink/10 text-ink/60",
  DRAFTED: "bg-sky-100 text-sky-800",
  EDITED: "bg-amber-100 text-amber-800",
  ISSUED: "bg-emerald-100 text-emerald-800",
};

const STATUS_LABEL: Record<string, string> = {
  NONE: "no paper",
  DRAFTED: "drafted",
  EDITED: "drafted (edited)",
  ISSUED: "issued",
};

export default async function MeetingsPage({
  params,
}: {
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");

  const meetings = await loadMeetings(ctx.tenant.id);

  const now = Date.now();
  const upcoming = meetings.filter((m) => m.startsAt.getTime() >= now);
  const past = meetings.filter((m) => m.startsAt.getTime() < now).reverse();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Meetings</h1>
        <p className="mt-1 text-sm text-ink/70">
          Schedule a meeting; the system drafts an agenda and discussion paper for the
          paper-author (default: the meeting creator) to review and issue.{" "}
          <span className="text-ink/50">PRD §7.4.</span>
        </p>
      </div>

      <NewMeetingForm tenantSlug={tenantSlug} />

      {meetings.length === 0 ? (
        <p className="text-sm text-ink/60">No meetings yet.</p>
      ) : (
        <div className="space-y-6">
          <Section title={`Upcoming (${upcoming.length})`} meetings={upcoming} tenantSlug={tenantSlug} />
          {past.length > 0 && (
            <Section title={`Past (${past.length})`} meetings={past} tenantSlug={tenantSlug} muted />
          )}
        </div>
      )}
    </div>
  );
}

function loadMeetings(tenantId: string) {
  return superDb.meeting.findMany({
    where: { tenantId },
    orderBy: { startsAt: "asc" },
    include: {
      _count: { select: { participants: true } },
      paperAuthor: { include: { user: true } },
    },
    take: 100,
  });
}
type MeetingRow = Awaited<ReturnType<typeof loadMeetings>>[number];

function Section({
  title,
  meetings,
  tenantSlug,
  muted = false,
}: {
  title: string;
  meetings: MeetingRow[];
  tenantSlug: string;
  muted?: boolean;
}) {
  return (
    <div>
      <h2 className="mb-2 text-base font-medium">{title}</h2>
      <ul className="space-y-2">
        {meetings.map((m) => {
          const author = m.paperAuthor?.user.name ?? m.paperAuthor?.user.email ?? "—";
          const date = m.startsAt.toISOString().slice(0, 16).replace("T", " ");
          return (
            <li key={m.id}>
              <Link
                href={`/${tenantSlug}/meetings/${m.id}`}
                className={`card block hover:bg-ink/[0.02] ${muted ? "opacity-80" : ""}`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{m.title}</div>
                    <div className="mt-1 flex flex-wrap gap-2 text-xs text-ink/60">
                      <span>{date}</span>
                      <span>· {m.durationMin} min</span>
                      {m.location && <span>· {m.location}</span>}
                      <span>· {m._count.participants} participants</span>
                      <span>· author {author}</span>
                      {m.shortNotice && <span className="tag bg-amber-100">short notice</span>}
                    </div>
                  </div>
                  <span className={`tag shrink-0 ${STATUS_BADGE[m.paperStatus] ?? ""}`}>
                    {STATUS_LABEL[m.paperStatus] ?? m.paperStatus}
                  </span>
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
