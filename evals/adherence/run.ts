import type { Adapter } from "../lib/types";
import { scoreAdherence } from "@/lib/ai/agents/adherenceAgent";

type Input = {
  tenantId?: string;
  fcg: unknown;
  ucg: unknown;
  channel: string;
  inbound?: { sender?: string | null; subject?: string | null; body?: string | null };
  sent: { subject?: string | null; body: string };
  responseLatencyMin?: number | null;
};

export const adherenceAdapter: Adapter = {
  role: "adherence",
  async run(raw) {
    const input = raw as Input;
    const { result } = await scoreAdherence({
      tenantId: input.tenantId ?? "eval-tenant",
      fcg: input.fcg,
      ucg: input.ucg,
      channel: input.channel,
      inbound: input.inbound,
      sent: input.sent,
      responseLatencyMin: input.responseLatencyMin ?? null,
    });
    return result;
  },
};
