# AI eval harness

Golden-set runner for the AI agents (judge, draft, adherence, sentiment, opportunity, FCG chat, UCG chat). PRD §17 lists "judge inconsistency" as a Medium-risk item; the mitigation is **drift detection**, not drift blocking. This harness exists to make drift visible.

## Run locally

```sh
npm run eval:judge        # one role
npm run eval:all          # everything
npm run eval:judge -- --json    # machine-readable output
npm run eval:judge -- --only=^002    # filter to specific fixture(s)
```

The harness picks up your environment's provider configuration:

- With `ANTHROPIC_API_KEY` set → judge runs against Anthropic Sonnet, others fall back per `src/lib/ai/models.ts`.
- With `TOGETHER_API_KEY` set → most roles run against Together's Llama 3.3 70B Turbo.
- With neither → everything runs against the mock provider, and `liveOnly` fixtures are skipped.

## Layout

```
evals/
  lib/                 — types, matchers, runner, reporter
  cli.ts               — CLI entry; mapped to `npm run eval:*` scripts
  <role>/run.ts        — adapter calling the role's agent function
  <role>/fixtures/*.json — golden cases
```

Each fixture:

```jsonc
{
  "name": "001-smoke-pass",
  "tags": ["smoke"],
  "liveOnly": false,            // optional; default false
  "input": { /* opaque, passed straight to the adapter */ },
  "expected": {                  // path → matcher (used when no per-provider override)
    "overall": { "in": ["pass", "partial"] },
    "rulings.0.verdict": { "in": ["fail", "not_applicable"] }
  },
  "expectedByProvider": {        // optional; lets us state mock-friendly shape checks
    "mock": {
      "overall": { "type": "string" }
    }
  }
}
```

Supported matchers (see [evals/lib/match.ts](lib/match.ts)):

- direct value (deep-equals)
- `{ "in": [...] }` — value must be one of
- `{ "min": n, "max": m }` — numeric range
- `{ "contains": "...", "ignoreCase": true }` — substring
- `{ "matches": "regex", "flags": "i" }` — regex
- `{ "length": { "min": n, "max": m } }` — array/string/object key length
- `{ "type": "string|number|boolean|object|array|null" }`
- `{ "exists": true|false }`

Paths use simple dotted notation: `rulings.0.verdict`, `perDimension.tone.score`. No globbing.

## CI

The harness runs as a non-blocking job in [.github/workflows/ci.yml](../.github/workflows/ci.yml). `continue-on-error: true` means drift in any single case will print to the Actions log without failing the workflow. Promote drift to a blocking gate later, once we've observed baseline noise from real provider runs.
