/**
 * PRD §11.3 anonymisation pipeline (stub for v1).
 *
 * Strips direct and indirect identifiers from a candidate insight before
 * the human Curator reviews it. The pipeline is intentionally conservative
 * — over-redaction is fine; under-redaction is a serious finding that the
 * quarterly re-identification test (PRD §11.3) is meant to catch.
 *
 * The redaction log is returned alongside the redacted text so the curator
 * can sanity-check what was stripped (e.g. mistaking a service name for an
 * organisation). For v1 the implementation is regex-based; a future commit
 * can swap in a proper PII model + entity recogniser without changing the
 * call shape.
 */

export type RedactionEntry = {
  /// Category of identifier (email, phone, name, organisation, matter_ref, …).
  kind: string;
  original: string;
  replacement: string;
  /// Byte offset in the original text where the match started — useful for
  /// the curator UI to highlight context. Not deduplicated.
  offset: number;
};

export type RedactionResult = {
  redactedText: string;
  log: RedactionEntry[];
};

const PATTERNS: Array<{ kind: string; re: RegExp; placeholder: (i: number) => string }> = [
  // Emails — explicit and safest first.
  {
    kind: "email",
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    placeholder: (i) => `[EMAIL_${i}]`,
  },
  // Phone numbers — UK + generic international. Conservative: 10+ digits with
  // optional separators and a leading `+`.
  {
    kind: "phone",
    re: /\+?\d[\d\s().-]{8,}\d/g,
    placeholder: (i) => `[PHONE_${i}]`,
  },
  // Companies House / matter references — common UK patterns.
  {
    kind: "matter_ref",
    re: /\b[A-Z]{2,}-?\d{4,}\b/g,
    placeholder: (i) => `[MATTER_${i}]`,
  },
  // Capitalised personal-name pairs (heuristic — over-redacts on titled
  // works but that's the right side to err on).
  {
    kind: "person_name",
    re: /\b[A-Z][a-z]{1,20} [A-Z][a-z]{1,20}\b/g,
    placeholder: (i) => `[PERSON_${i}]`,
  },
  // Common organisation suffixes — keep the word right before them as the
  // anchor (Acumon Intelligence Ltd → [ORG_n]).
  {
    kind: "organisation",
    re: /\b[A-Z][\w&-]{1,40}(?:\s+[A-Z][\w&-]{1,40}){0,3}\s+(?:Ltd|Limited|LLP|plc|PLC|Inc|GmbH|S\.A\.|S\.r\.l\.)\b/g,
    placeholder: (i) => `[ORG_${i}]`,
  },
];

export function redact(input: string): RedactionResult {
  const log: RedactionEntry[] = [];
  // Track replacement counters per-kind so placeholders are stable within a
  // single pass and the curator can recognise distinct entities.
  const counters: Record<string, number> = {};

  let working = input;
  for (const { kind, re, placeholder } of PATTERNS) {
    working = working.replace(re, (match, ...rest) => {
      const offset = typeof rest[rest.length - 2] === "number" ? (rest[rest.length - 2] as number) : -1;
      counters[kind] = (counters[kind] ?? 0) + 1;
      const repl = placeholder(counters[kind]);
      log.push({ kind, original: match, replacement: repl, offset });
      return repl;
    });
  }

  return { redactedText: working, log };
}

/**
 * Quick deterministic check: does the redacted text still appear to contain
 * residual identifiers from the input? Used as a smoke test in the curator
 * console before showing the candidate; a `true` here means the pipeline
 * missed something and the candidate should be flagged for special review.
 */
export function residualIdentifierCheck(redactedText: string): boolean {
  for (const { re } of PATTERNS) {
    re.lastIndex = 0;
    if (re.test(redactedText)) return true;
  }
  return false;
}
