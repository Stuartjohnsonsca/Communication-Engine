/**
 * Post-PRD hardening item 64 — Member-facing draft inbox triage.
 *
 * Pure-logic tests over `classifyDraft` + `bucketDrafts` +
 * `formatDeadlineRelative`. No DB; lives under `tests/unit` so the
 * setup-db gate doesn't apply.
 */
import { describe, it, expect } from "vitest";
import {
  classifyDraft,
  bucketDrafts,
  formatDeadlineRelative,
  DUE_SOON_HORIZON_HOURS,
  type TriageDraft,
} from "@/lib/drafts/triage";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function mkDraft(input: Partial<TriageDraft> & { id: string }): TriageDraft {
  return {
    id: input.id,
    status: input.status ?? "PROPOSED",
    fcgWindowDeadline: input.fcgWindowDeadline ?? null,
    sentMarkedAt: input.sentMarkedAt ?? null,
    createdAt: input.createdAt ?? new Date(),
  };
}

describe("classifyDraft", () => {
  const now = new Date("2026-05-12T12:00:00Z");

  it("treats SENT/DISCARDED as recently_closed regardless of deadline", () => {
    const sent = mkDraft({
      id: "a",
      status: "SENT",
      fcgWindowDeadline: new Date(now.getTime() - 99 * HOUR),
    });
    const discarded = mkDraft({
      id: "b",
      status: "DISCARDED",
      fcgWindowDeadline: new Date(now.getTime() + 99 * HOUR),
    });
    expect(classifyDraft(sent, now)).toBe("recently_closed");
    expect(classifyDraft(discarded, now)).toBe("recently_closed");
  });

  it("classifies a non-terminal draft with a past deadline as overdue", () => {
    const d = mkDraft({
      id: "x",
      status: "PROPOSED",
      fcgWindowDeadline: new Date(now.getTime() - 1 * HOUR),
    });
    expect(classifyDraft(d, now)).toBe("overdue");
  });

  it("classifies within the due-soon horizon as due_soon", () => {
    const just = mkDraft({
      id: "y1",
      status: "EDITED",
      fcgWindowDeadline: new Date(now.getTime() + 1 * HOUR),
    });
    const edge = mkDraft({
      id: "y2",
      status: "ACCEPTED",
      fcgWindowDeadline: new Date(
        now.getTime() + DUE_SOON_HORIZON_HOURS * HOUR - 1,
      ),
    });
    expect(classifyDraft(just, now)).toBe("due_soon");
    expect(classifyDraft(edge, now)).toBe("due_soon");
  });

  it("classifies > horizon away or no-deadline as open", () => {
    const farFuture = mkDraft({
      id: "z1",
      status: "PROPOSED",
      fcgWindowDeadline: new Date(now.getTime() + 3 * DAY),
    });
    const none = mkDraft({
      id: "z2",
      status: "PROPOSED",
      fcgWindowDeadline: null,
    });
    expect(classifyDraft(farFuture, now)).toBe("open");
    expect(classifyDraft(none, now)).toBe("open");
  });
});

describe("bucketDrafts", () => {
  const now = new Date("2026-05-12T12:00:00Z");

  it("sorts overdue most-overdue-first", () => {
    const drafts = [
      mkDraft({
        id: "less",
        fcgWindowDeadline: new Date(now.getTime() - 1 * HOUR),
      }),
      mkDraft({
        id: "more",
        fcgWindowDeadline: new Date(now.getTime() - 5 * HOUR),
      }),
      mkDraft({
        id: "mid",
        fcgWindowDeadline: new Date(now.getTime() - 3 * HOUR),
      }),
    ];
    const out = bucketDrafts(drafts, now);
    expect(out.overdue.map((d) => d.id)).toEqual(["more", "mid", "less"]);
    expect(out.due_soon).toHaveLength(0);
    expect(out.open).toHaveLength(0);
  });

  it("sorts due_soon soonest-first", () => {
    const drafts = [
      mkDraft({ id: "later", fcgWindowDeadline: new Date(now.getTime() + 20 * HOUR) }),
      mkDraft({ id: "sooner", fcgWindowDeadline: new Date(now.getTime() + 2 * HOUR) }),
      mkDraft({ id: "mid", fcgWindowDeadline: new Date(now.getTime() + 8 * HOUR) }),
    ];
    const out = bucketDrafts(drafts, now);
    expect(out.due_soon.map((d) => d.id)).toEqual(["sooner", "mid", "later"]);
  });

  it("puts dated open drafts before no-deadline ones, then createdAt-desc for the tail", () => {
    const drafts = [
      mkDraft({
        id: "no-newer",
        fcgWindowDeadline: null,
        createdAt: new Date(now.getTime() - 1 * HOUR),
      }),
      mkDraft({
        id: "dated",
        fcgWindowDeadline: new Date(now.getTime() + 3 * DAY),
      }),
      mkDraft({
        id: "no-older",
        fcgWindowDeadline: null,
        createdAt: new Date(now.getTime() - 5 * HOUR),
      }),
    ];
    const out = bucketDrafts(drafts, now);
    expect(out.open.map((d) => d.id)).toEqual(["dated", "no-newer", "no-older"]);
  });

  it("recently_closed sorts by sentMarkedAt desc, createdAt fallback", () => {
    const drafts = [
      mkDraft({
        id: "discarded",
        status: "DISCARDED",
        sentMarkedAt: null,
        createdAt: new Date(now.getTime() - 1 * HOUR),
      }),
      mkDraft({
        id: "sent-old",
        status: "SENT",
        sentMarkedAt: new Date(now.getTime() - 5 * HOUR),
      }),
      mkDraft({
        id: "sent-new",
        status: "SENT",
        sentMarkedAt: new Date(now.getTime() - 30 * 60 * 1000),
      }),
    ];
    const out = bucketDrafts(drafts, now);
    expect(out.recently_closed.map((d) => d.id)).toEqual([
      "sent-new",
      "discarded",
      "sent-old",
    ]);
  });
});

describe("formatDeadlineRelative", () => {
  const now = new Date("2026-05-12T12:00:00Z");

  it("renders sub-minute as 'now'", () => {
    expect(formatDeadlineRelative(new Date(now.getTime() + 20 * 1000), now)).toBe("now");
    expect(formatDeadlineRelative(new Date(now.getTime() - 20 * 1000), now)).toBe("now");
  });

  it("renders minutes for sub-hour", () => {
    expect(formatDeadlineRelative(new Date(now.getTime() + 45 * 60 * 1000), now)).toBe(
      "in 45m",
    );
    expect(formatDeadlineRelative(new Date(now.getTime() - 10 * 60 * 1000), now)).toBe(
      "10m overdue",
    );
  });

  it("renders hours for sub-2-day", () => {
    expect(formatDeadlineRelative(new Date(now.getTime() + 4 * HOUR), now)).toBe(
      "in 4h",
    );
    expect(formatDeadlineRelative(new Date(now.getTime() - 12 * HOUR), now)).toBe(
      "12h overdue",
    );
  });

  it("renders days for ≥ 2 days", () => {
    expect(formatDeadlineRelative(new Date(now.getTime() + 3 * DAY), now)).toBe(
      "in 3d",
    );
    expect(formatDeadlineRelative(new Date(now.getTime() - 5 * DAY), now)).toBe(
      "5d overdue",
    );
  });
});
