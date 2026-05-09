import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";

/**
 * Admin lifecycle for the Sales Identifier add-on (PRD §8 + §8.5).
 *
 * Two switches at the tenant level:
 *
 *  - `salesIdentifierEnabled` — main on/off toggle.
 *  - `salesIdentifierLawfulBasisAttestedAt` — separate confirmation that
 *    the Firm Administrator has updated their counterparty privacy notice
 *    (and incremental consent where required) for the additional
 *    processing purpose. PRD §8.5 is explicit that mining client
 *    correspondence to identify revenue is a separate processing purpose
 *    from the core admin-reduction features.
 *
 * The detector refuses to run unless both are present. Enabling without
 * the lawful-basis acknowledgement is permitted (so you can configure the
 * feature in stages) but will not produce any candidates until the
 * acknowledgement is on file.
 *
 * Disabling does NOT clear the lawful-basis acknowledgement — the firm
 * may want to pause and resume without re-running the legal review. The
 * acknowledgement can be cleared explicitly via the admin form.
 */

export async function setSalesIdentifierEnabled(input: {
  tenantId: string;
  actorMembershipId: string;
  enabled: boolean;
}) {
  const tenant = await superDb.tenant.findUnique({
    where: { id: input.tenantId },
    select: { salesIdentifierEnabled: true },
  });
  if (!tenant) throw new Error("tenant not found");

  if (tenant.salesIdentifierEnabled === input.enabled) return tenant;

  const updated = await superDb.tenant.update({
    where: { id: input.tenantId },
    data: {
      salesIdentifierEnabled: input.enabled,
      salesIdentifierEnabledAt: input.enabled ? new Date() : null,
    },
  });

  await writeAuditEvent({
    tenantId: input.tenantId,
    eventType: input.enabled ? "SALES_IDENTIFIER_ENABLED" : "SALES_IDENTIFIER_DISABLED",
    actorMembershipId: input.actorMembershipId,
    subjectType: "Tenant",
    subjectId: input.tenantId,
    payload: { enabled: input.enabled },
  });

  return updated;
}

export async function attestSalesIdentifierLawfulBasis(input: {
  tenantId: string;
  actorMembershipId: string;
  signedByName: string;
  signedByRole: string;
  note?: string | null;
}) {
  const name = input.signedByName.trim();
  const role = input.signedByRole.trim();
  if (!name || !role) throw new Error("signer name and role required");

  const updated = await superDb.tenant.update({
    where: { id: input.tenantId },
    data: {
      salesIdentifierLawfulBasisAttestedAt: new Date(),
      salesIdentifierLawfulBasisAttestedBy: `${name} <${role}>`,
      salesIdentifierLawfulBasisNote: input.note?.trim() || null,
    },
  });

  await writeAuditEvent({
    tenantId: input.tenantId,
    eventType: "SI_LAWFUL_BASIS_ATTESTED",
    actorMembershipId: input.actorMembershipId,
    subjectType: "Tenant",
    subjectId: input.tenantId,
    payload: {
      signedByName: name,
      signedByRole: role,
      hasNote: !!input.note?.trim(),
    },
  });

  return updated;
}

