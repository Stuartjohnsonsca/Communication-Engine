import PhaseStub from "@/components/PhaseStub";

export default function MeetingsPage() {
  return (
    <PhaseStub
      title="Meetings"
      phase={3}
      prdRef="§7.4 Calendar reviews · §7.5 Notes & minutes"
      description="Calendar review, single-author meeting paper generation with FCG-defined lead time, transcript-based summary and formal minutes with consent flow for external participants."
      bullets={[
        "Daily calendar scan; flag meetings without agenda/pre-read",
        "Pick paper-author per FCG (default: meeting creator)",
        "Issue papers ≥ FCG lead time (default 3 working days)",
        "Transcript ingestion (Teams/Zoom/Meet) with opt-out flow",
        "Minutes routed to Chair for approval before circulation",
      ]}
    />
  );
}
