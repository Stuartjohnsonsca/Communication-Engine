import type { Adapter } from "../lib/types";
import { produceDraft } from "@/lib/ai/agents/draftAgent";

type Input = {
  tenantId?: string;
  fcg: unknown;
  ucg: unknown;
  inbound: {
    channel: string;
    sender?: string;
    subject?: string;
    body: string;
    receivedAt?: string;
  };
  noGoSubjects?: string[];
};

export const draftAdapter: Adapter = {
  role: "draft",
  async run(raw) {
    const input = raw as Input;
    return produceDraft({
      tenantId: input.tenantId ?? "eval-tenant",
      fcg: input.fcg,
      ucg: input.ucg,
      inbound: input.inbound,
      noGoSubjects: input.noGoSubjects,
    });
  },
};
