import PhaseStub from "@/components/PhaseStub";

export default function DsarPage() {
  return (
    <PhaseStub
      title="DSAR module"
      phase={4}
      prdRef="§12.4 Data subject rights"
      description="Subject Access, Rectification, Erasure, Restriction, Portability and Objection requests handled in the Firm Administrator console. Counterparty DSARs are routed to the Client; the platform supplies extraction tooling."
      bullets={[
        "Standard turnaround 14 days; statutory backstop 1 month (extendable per UK GDPR Art. 12)",
        "Per-User extraction with full audit-trail of fulfilment",
        "Counterparty extraction tooling for third-party DSARs",
        "Erasure respects statutory retention on audit logs and DPIA records",
      ]}
    />
  );
}
