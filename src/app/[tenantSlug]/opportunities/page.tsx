import PhaseStub from "@/components/PhaseStub";

export default function OpportunitiesPage() {
  return (
    <PhaseStub
      title="Sales Identifier"
      phase={4}
      prdRef="§8 Sales Identifier (paid add-on)"
      description="Scans approved firm communications, internal documents and licensed external feeds for revenue opportunities. Routes to the appropriate Sales Reviewer team. Default Partner is Acumon Intelligence (discounted)."
      bullets={[
        "Jurisdiction-specific opportunity packs (UK/IE/DE/FR initially)",
        "Classify and route via FCG-defined sales-routing rules",
        "Reviewer can accept, revise, comment, reject, or route to Partner",
        "Comments feed (anonymised) into Cross-Client Learning if opted-in",
        "Lawful-basis prompt during onboarding (separate processing purpose)",
      ]}
    />
  );
}
