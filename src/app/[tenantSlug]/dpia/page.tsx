import PhaseStub from "@/components/PhaseStub";

export default function DpiaPage() {
  return (
    <PhaseStub
      title="DPIA Helper"
      phase={4}
      prdRef="§12.2 DPIA attestation workflow"
      description="During onboarding, the Firm Administrator and Client DPO are presented with a DPIA Helper covering scope of channels, retention windows, lawful basis selection, special-category data handling, transfer mechanism, sub-processors, performance-monitoring proportionality, sentiment scope, and Sales Identifier opt-in."
      bullets={[
        "Helper produces a draft DPIA the Client signs off internally",
        "Material scope changes (new channel, dashboard, Sales Identifier) re-trigger attestation",
        "Annual re-attestation; failure within 30 days → graceful degradation (drafting continues; dashboards/SI paused)",
        "Versioned and stored alongside the controlling FCG version",
      ]}
    />
  );
}
