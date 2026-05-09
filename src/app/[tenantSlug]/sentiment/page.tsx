import PhaseStub from "@/components/PhaseStub";

export default function SentimentPage() {
  return (
    <PhaseStub
      title="Sentiment monitoring"
      phase={3}
      prdRef="§9.3 Sentiment monitoring"
      description="Monitors incoming external comms for extreme-positive or extreme-negative signals about the firm's handling of a matter. Negatives are escalated immediately to the User and the Firm Culture Team. Outgoing-comm sentiment requires User opt-in."
      bullets={[
        "Boundary: only counterparty dissatisfaction with firm handling, not their general displeasure",
        "Negative example: 'You have failed to respond by X' or 'This is not what you advised'",
        "Out of scope: 'I am disappointed my profit is down'",
        "Integrated with adherence dashboards (monthly in arrears)",
      ]}
    />
  );
}
