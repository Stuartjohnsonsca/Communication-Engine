import type { ChannelAdapter, IngestRow } from "./types";

/**
 * Mock adapter — returns a small, varied batch of synthetic inbound and
 * outbound messages so the rest of the platform (drafting, sentiment,
 * adherence) has realistic-looking input without real OAuth wiring.
 *
 * Used in two situations:
 *   1. The channel kind is MOCK (demo/sandbox channel).
 *   2. The channel kind is real but the deployment has no OAuth credentials
 *      configured for it — we fall through here so the rest of the build
 *      still demonstrates end-to-end.
 */
export const mockAdapter: ChannelAdapter = {
  async ingest({ tenantId, channelId, since }) {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const within = (offset: number) => new Date(now - offset);

    const rows: IngestRow[] = [
      {
        externalId: `${channelId}-msg-1`,
        threadId: `${channelId}-thr-100`,
        direction: "IN",
        sender: "rachel.green@bellweather-pharma.example",
        recipients: ["matters@acumon.example"],
        subject: "Status of audit response — overdue?",
        body:
          "Hi team, last we spoke you were going to come back to me on the cross-border " +
          "transfer pricing point by Tuesday. It's now Friday and I've heard nothing. " +
          "Please update me by close of play today.",
        sentAt: within(2 * day),
      },
      {
        externalId: `${channelId}-msg-2`,
        threadId: `${channelId}-thr-101`,
        direction: "IN",
        sender: "operations@argyle-co.example",
        recipients: ["partners@acumon.example"],
        subject: "Thanks — that was excellent",
        body:
          "I just wanted to drop you a quick note to say the way you handled the supplier " +
          "dispute last week was first class. Genuinely impressed.",
        sentAt: within(1 * day),
      },
      {
        externalId: `${channelId}-msg-3`,
        threadId: `${channelId}-thr-102`,
        direction: "OUT",
        sender: "stuart@acumon.example",
        recipients: ["finance@bellweather-pharma.example"],
        subject: "Re: Q2 audit timetable",
        body:
          "Dear Priya,\n\nThank you for sending across the revised timetable. We can " +
          "absolutely meet the 14 May deadline; I will share the draft management letter " +
          "no later than 09 May.\n\nKind regards,\nStuart",
        sentAt: within(3 * day),
      },
      {
        externalId: `${channelId}-msg-4`,
        threadId: `${channelId}-thr-103`,
        direction: "IN",
        sender: "newco-corporate@example.com",
        recipients: ["enquiries@acumon.example"],
        subject: "Looking for help with a Series B raise — UK / Germany",
        body:
          "Hi, we're a UK fintech preparing a Series B with a German lead investor. We " +
          "need transaction support and tax structuring across both jurisdictions. Are " +
          "you taking on new mandates this quarter?",
        sentAt: within(5 * day),
      },
      {
        externalId: `${channelId}-msg-5`,
        threadId: `${channelId}-thr-104`,
        direction: "OUT",
        sender: "stuart@acumon.example",
        recipients: ["jane.howe@argyle-co.example"],
        subject: "Confirmation — call tomorrow 10:30",
        body:
          "Hi Jane,\n\nConfirming our call at 10:30 tomorrow. I'll send a Teams link " +
          "shortly.\n\nBest,\nStuart",
        sentAt: within(0.5 * day),
      },
    ];

    void tenantId; // suppress unused — useful for future tenant-specific personas
    if (since) return rows.filter((r) => !r.sentAt || r.sentAt >= since);
    return rows;
  },
};
