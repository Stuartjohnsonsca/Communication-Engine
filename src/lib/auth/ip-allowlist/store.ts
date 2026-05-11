import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import { validateAllowlist } from "./evaluate";

/**
 * Apply a new IP allowlist for a tenant. The Firm Administrator
 * supplies free-form lines from a textarea; this function validates
 * them, persists the canonicalised list, and writes a
 * `TENANT_IP_ALLOWLIST_CHANGED` audit event.
 *
 * Throws on validation failure so the caller (server action) can
 * surface the error to the form. On success returns the persisted
 * list so the UI can re-render with normalised entries (host bits
 * stripped, /32 + /128 appended).
 */
export class AllowlistValidationError extends Error {
  status = 400;
  constructor(public readonly errors: string[]) {
    super(`allowlist validation failed: ${errors.join("; ")}`);
    this.name = "AllowlistValidationError";
  }
}

export async function updateTenantAllowlist(input: {
  tenantId: string;
  actorMembershipId: string;
  /** Raw lines from the textarea. Order preserved; dupes collapsed. */
  lines: readonly string[];
}): Promise<{ cidrs: string[]; before: string[] }> {
  const result = validateAllowlist(input.lines);
  if (!result.ok) throw new AllowlistValidationError(result.errors);

  const existing = await superDb.tenant.findUnique({
    where: { id: input.tenantId },
    select: { allowedIpCidrs: true },
  });
  if (!existing) throw new Error("tenant not found");

  const before = existing.allowedIpCidrs;
  const after = result.cidrs;

  // No change → no audit row. This makes a duplicate form submission
  // a silent no-op rather than a chain-padding event.
  const sameLength = before.length === after.length;
  const setEqual = sameLength && before.every((c, i) => c === after[i]);
  if (setEqual) return { cidrs: after, before };

  await superDb.tenant.update({
    where: { id: input.tenantId },
    data: { allowedIpCidrs: after },
  });

  await writeAuditEvent({
    tenantId: input.tenantId,
    eventType: "TENANT_IP_ALLOWLIST_CHANGED",
    actorMembershipId: input.actorMembershipId,
    subjectType: "Tenant",
    subjectId: input.tenantId,
    payload: {
      before,
      after,
      addedCount: after.filter((c) => !before.includes(c)).length,
      removedCount: before.filter((c) => !after.includes(c)).length,
    },
  });

  return { cidrs: after, before };
}

export async function getTenantAllowlist(tenantId: string): Promise<string[]> {
  const row = await superDb.tenant.findUnique({
    where: { id: tenantId },
    select: { allowedIpCidrs: true },
  });
  return row?.allowedIpCidrs ?? [];
}
