import PhaseStub from "@/components/PhaseStub";

export default function ChannelsPage() {
  return (
    <PhaseStub
      title="Channels"
      phase={2}
      prdRef="§10 Integrations"
      description="OAuth-based ingestion of approved firm communications. Tier 1 at GA: Microsoft 365, Google Workspace, Slack. Tier 2 within 6 months: WhatsApp Business (sanctioned only), iManage, NetDocuments, Zoom, DocuSign, practice management."
      bullets={[
        "Per-channel DPIA scope check before activation",
        "Token storage encrypted at rest with AES-GCM (per-tenant key)",
        "Source-system permissions flow through to RAG retrieval",
        "Personal channels excluded by design (PRD §5.1.1)",
      ]}
    />
  );
}
