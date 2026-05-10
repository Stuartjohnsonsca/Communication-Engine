import type { Adapter } from "../lib/types";
import { judgeUcg } from "@/lib/ai/agents/judgeAgent";

type Input = {
  fcg: unknown;
  ucg: unknown;
  tenantId?: string;
};

export const judgeAdapter: Adapter = {
  role: "judge",
  async run(raw) {
    const input = raw as Input;
    return judgeUcg({
      fcg: input.fcg,
      ucg: input.ucg,
      tenantId: input.tenantId ?? "eval-tenant",
    });
  },
};
