import PhaseStub from "@/components/PhaseStub";

export default function DashboardsPage() {
  return (
    <PhaseStub
      title="Performance dashboards"
      phase={3}
      prdRef="§9.1 Adherence measurement · §9.2 Performance dashboards"
      description="Adherence is measured against communications actually sent (not drafts). Each User has a personal dashboard with full drill-down. The Firm Culture Team sees aggregate, departmental and (with opt-in) individual adherence — monthly in arrears to satisfy ICO worker-monitoring guidance."
      bullets={[
        "Response-time, tone, mandatory/prohibited phrase, escalation, opportunity-recognition dimensions",
        "Per-user opt-in for non-aggregated visibility outside the User",
        "Annual re-attestation of lawful basis required",
        "Drill-down from aggregate score to specific communications",
      ]}
    />
  );
}
