type Props = {
  title: string;
  prdRef: string;
  description: string;
  phase: 2 | 3 | 4 | 5;
  bullets?: string[];
};

export default function PhaseStub({ title, prdRef, description, phase, bullets }: Props) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <span className="tag">Phase {phase}</span>
      </div>
      <p className="text-sm text-ink/70">{description}</p>
      <div className="card">
        <div className="text-xs uppercase tracking-wider text-ink/50">PRD reference</div>
        <div className="mt-1 text-sm">{prdRef}</div>
        {bullets && bullets.length > 0 && (
          <>
            <div className="mt-4 text-xs uppercase tracking-wider text-ink/50">In this phase</div>
            <ul className="mt-1 list-disc pl-5 text-sm text-ink/80">
              {bullets.map((b, i) => (
                <li key={i}>{b}</li>
              ))}
            </ul>
          </>
        )}
        <p className="mt-4 text-xs text-ink/50">
          Schema rows for this area exist already so Phase 2 work plugs in without a migration churn.
        </p>
      </div>
    </div>
  );
}
