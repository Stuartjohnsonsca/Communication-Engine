# Handover — Communication Engine (Acumon Communications)

> A maintainer's orientation guide. Read this once after cloning the repo
> — you should have enough context to navigate the codebase and ship a
> change in under 30 minutes.
>
> README.md covers the basics (stack, env vars, dev setup). This file
> covers everything that's not obvious from the source.

## What this thing is, in three sentences

Acumon Communications is a multi-tenant SaaS for governed firm-wide
communications in professional-services firms (law, accountancy, consulting).
It **drafts** outbound client messages constrained by a firm-level rulebook
(the Firm Culture Guide) and a per-user style layer (the User Culture
Guide), **never sends** anything itself, and **scores** every actual send
retroactively against the same rules — flagging poor adherence to the
firm's Compliance Team rather than blocking the send. Every consequential
action is recorded on a per-tenant, hash-chained, immutable audit log that
procurement reviewers, regulators, and Data Protection Officers can verify
end-to-end.

## The walk so far

The product was built as a sequential walk through the PRD
(`Acumon_Communications_PRD_v0.1.docx`, also `PRD_extracted.txt`). One
commit per cohesive PRD module; **PRD §1–18 all shipped**. Verify with
`git log --oneline` — every commit's first line is the module name.

After the PRD walk, an ordered cross-cutting hardening backlog was
accepted on 2026-05-10. Items 1–10 were the original procurement-visible
list (TOTP, integration tests, real OAuth, observability, AI evals, etc.).
Items 11+ are picked autonomously by whoever's at the keyboard: the
next-highest-leverage hardening item that's still missing. **44 items
shipped so far** — see `## Shipped post-PRD hardening backlog` below.

## Tech stack

Already covered in `README.md`. The non-obvious bits:

- **Tenant isolation is double-bound:** every tenant-scoped Prisma read
  uses `tenantDb(tenantId)` (`src/lib/db.ts`) which opens a transaction,
  sets the `app.current_tenant` Postgres GUC, and runs the query under
  Row-Level Security (`prisma/rls.sql`). RLS is the enforcement; the
  explicit `where: { tenantId }` clause is defence in depth.
- **AI providers are bound per agent role** in `src/lib/ai/models.ts` so
  the quality-critical roles (Compliance Judge, statutory Verifier) can
  use Anthropic Claude while the chattier roles (drafting, sentiment)
  use cheaper Together AI / Llama. Mock provider is wired for tests.
- **The audit chain is the source of truth.** Every consequential mutation
  goes through `writeAuditEvent` (`src/lib/audit.ts`) which hashes the
  payload against the previous row's hash. A `audit_immutable()` trigger
  enforces append-only at the DB level. `verifyAuditChain` re-hashes from
  genesis. Background verification cron + tamper alerts ship as item 23.

## How to add a new module — the build pattern

The repo has a strong convention. Match it.

1. **Schema** — add the model to `prisma/schema.prisma`. Tenant-scoped
   models include `tenantId` and the appropriate index.
2. **Migration** — `prisma/migrations/NN_<slug>/migration.sql` with a
   zero-padded two-digit prefix (`check:migration-prefixes` enforces this).
3. **RLS** — if the new model is tenant-scoped, add its name to the
   `tenant_tables` array in `prisma/rls.sql`. The
   `rls-tenant-tables-coverage.test.ts` integration test will exercise
   it automatically.
4. **Lib** — module code under `src/lib/<module>/`. Use `tenantDb()` for
   reads; use `superDb` only for explicitly-audited cross-tenant work
   (the `check:tenant-scoping` lint catches accidental misuse).
5. **Pages** — under `src/app/[tenantSlug]/...`. Use `getTenantContext()`
   to resolve the session + tenant + membership.
6. **API routes** — under `src/app/api/...`. Wrap every catch with
   `safeApiError(err, {ctx})` from `@/lib/observability`. Throw typed
   errors from `@/lib/api-errors` (`ValidationError`, `ForbiddenError`,
   `NotFoundError`, `ConflictError`) so they surface at the right status.
7. **RBAC** — add the permission to `src/lib/rbac.ts`. Existing roles:
   `FIRM_ADMIN`, `FCT_MEMBER`, `USER`, `SALES_REVIEWER`, `CURATOR`,
   `ACUMON_ADMIN`.
8. **Audit events** — add the new event type in BOTH the Prisma enum
   AND a migration's `ALTER TYPE "AuditEventType" ADD VALUE IF NOT
   EXISTS`. Skipping the migration breaks fresh `prisma migrate deploy`.
9. **i18n** — add translation entries to BOTH `src/lib/i18n/dictionaries/
   en-GB.ts` AND `fr.ts`. The Dictionary type is strict — missing keys
   fail at build.
10. **Tests** — integration tests in `tests/integration/` run against
    real Postgres in CI. Match the existing file naming.
11. **Commit message** — `<Module>: <one-line summary>`. Push to `main`;
    Railway auto-deploys.

## Standing invariants — load-bearing across the codebase

These are the constraints future work must honour. They don't all survive
in `git log` alone — code review against this list when in doubt.

- **Audit chain is immutable.** GDPR Art. 17 erasure pseudonymises the
  User row but **never** mutates historic `AuditEvent` payloads. Future
  "redact historic payloads" work needs append-only nullification entries,
  not in-place edits. The hash chain is the legal record (Art. 17(3)(b)+(e)
  exception).
- **ApiKey hash cannot be re-keyed retroactively** (item 27). Operators
  rotate keys by re-issuing. The `keyVersion` column lets stale-version
  keys keep working until explicitly revoked.
- **Sub-processor catalogue is global**, NOT tenant-scoped (item 24).
  `SubProcessor` and `SubProcessorChange` live OUTSIDE `tenant_tables` in
  `prisma/rls.sql`. `SubProcessorObjection` IS tenant-scoped.
  Procurement-friendly: every tenant sees the same sub-processor list.
- **Webhook receiver hostnames blocked at config + delivery time**
  (item 30): includes `*.local` mDNS and `*.internal` intranet suffixes.
  Forecloses some legitimate intranets (`*.corp.local`) but matches
  industry SSRF defence. Future "per-tenant allowed CIDR list" could
  re-open this.
- **`*.invalid` is the tombstone TLD** (item 32). RFC 6761 reserved;
  never resolves. Used by erasure for User email tombstones
  (`erased-<id>@erased.invalid`).
- **`statement_timeout` clamp = 100ms..10min** (items 29, 33). Both
  `tenantDb` (default 15s, env `DB_TENANT_STATEMENT_TIMEOUT_MS`) and
  `superDbWith` (default 60s) snap explicit overrides to this window.
- **No new audit event types without a migration.** Every new
  `AuditEventType` enum value requires both a Prisma schema entry AND an
  `ALTER TYPE ... ADD VALUE IF NOT EXISTS` migration. Skipping breaks
  fresh `prisma migrate deploy`.
- **Compliance evidence pack must NOT contain secrets** (item 35).
  Explicit field whitelist on `ApiKey`, belt-and-braces serialised-output
  test. Any new field added to `ApiKey` should be evaluated against the
  pack's no-secrets invariant.
- **Webhook self-event exclusion** (items 14, 37): `WEBHOOK_DELIVERED`,
  `WEBHOOK_DEAD_LETTERED`, `WEBHOOK_SUBSCRIPTION_AUTO_DISABLED`,
  `WEBHOOK_REPLAYED`, `WEBHOOK_SUBSCRIPTION_TESTED` are excluded from
  `enqueueWebhooks` to prevent recursive flooding of a receiver's own
  subscription. Item 37's test-fire path bypasses `enqueueWebhooks`
  entirely and writes the `WebhookDelivery` directly to the target only.
- **Acumon tenant is the operator** (`slug="acumon"`). Cron + system
  audit rows land on its chain. Cross-tenant fan-outs (sub-processor
  change notice, audit-chain-tampered alerts) deliberately exclude
  Acumon from the recipient list so the announcer doesn't get notified
  of its own action. **But** Acumon is also a Client tenant — modules
  must NEVER be gated by `slug === "acumon"`. Operator-vs-Client
  distinction is RBAC (`ACUMON_ADMIN`), not slug.
- **`/api/*` responses must not leak raw error messages** (items 38, 39):
  every handler uses `safeApiError(err, {ctx})` from
  `@/lib/observability`. Typed errors (duck-typed `statusCode` in
  [400, 499]) surface their message; anything else is logged + generic
  500. UX trade-off: lib functions throwing plain `new Error("...")` now
  return 500 instead of 400-with-message — tag lib throws with the
  hierarchy in `@/lib/api-errors` to restore the helpful surface.
- **Drafts only — never send.** The engine drafts but never sends; every
  send (drafted or bypassed via the mailbox directly) is retroactively
  scored against the FCG, never blocked. Item 1's `synthesise.ts`
  catches outbound messages that bypass the drafting UI; poor adherence
  escalates rather than blocks. This is product-defining — don't add a
  pre-send gate.

## Where things live

```
src/
  app/
    [tenantSlug]/        # all signed-in tenant routes
      admin/             # FIRM_ADMIN surfaces (members, audit, security, ...)
      compliance/        # processing-map, transfers, breaches, evidence-pack
      fcg/               # Firm Culture Guide
      ucg/               # User Culture Guide
      drafts/            # drafting console
      meetings/          # meeting transcript → minutes pipeline
      ...
      help/              # in-product user guide (item 42) — start here for non-technical readers
      error.tsx, not-found.tsx  # tenant-scoped boundaries (item 44)
    api/
      v1/                # third-party API (Bearer auth via withApiKey, items 16+34)
      cron/              # Bearer-auth cron endpoints (lifecycle-sweep, audit-verify, ...)
      compliance/        # session-auth tenant-scoped routes
      health/            # liveness probe (item 38: hardened, no info leak)
    status/              # public unauthenticated status page (item 9)
    error.tsx, not-found.tsx, global-error.tsx  # root boundaries (item 44)
  lib/
    db.ts                # superDb + tenantDb + superDbWith
    audit.ts             # writeAuditEvent + canonicalJson + chain genesis
    rbac.ts              # permissions catalogue (one source of truth)
    tenant.ts            # getTenantContext (the session/tenant resolver)
    api-errors.ts        # ValidationError / ForbiddenError / NotFoundError / ConflictError
    observability/       # logger, reportError, request-id, timing, safe-api-error
    auth/
      api-keys/          # /api/v1/* bearer auth + scopes + idempotency (item 31)
      sessions/          # session revocation, timeouts, UA/IP capture
      totp/              # TOTP enrollment + step-up gate (items 12, 18)
      ip-allowlist/      # per-tenant CIDR gate (item 17)
      anomaly/           # new-device detection (item 21)
    webhooks/            # outbound webhooks: subscriptions, dispatch, deliver, SSRF, test-fire, stats
    compliance/          # breach, cross-border (TIA), processing-map, evidence-pack
    dsar/                # extract + lifecycle + erasure
    cron-health/         # cron heartbeat + stalled-cron alert (item 22)
    audit-verify/        # background chain verification (item 23)
    subprocessors/       # catalogue + change notice + objections (item 24)
    notifications/       # in-app inbox + email + digest cron
    search/              # global ⌘K command palette backend
    ratelimit/           # per-IP + per-membership API throttle
    crypto/keys.ts       # encryption key registry (item 27)
    i18n/                # homegrown micro-runtime + en-GB + fr dictionaries
prisma/
  schema.prisma          # ~50 models
  migrations/            # 00_init through 48_*, zero-padded
  rls.sql                # RLS enable + tenant_tables array
  seed.ts                # creates the Acumon operator tenant + FCT + seed users
tests/
  integration/           # vitest + real Postgres (service container in CI)
  setup-db.ts            # one-shot: prisma migrate deploy + rls.sql + app role
evals/                   # AI quality eval harness (item 5)
scripts/
  check-tenant-scoping.ts      # CI lint
  check-migration-prefixes.ts  # CI lint
  rotate-encryption-keys.ts    # ops tool (item 27)
  migrate-history-backfill.ts  # DR-safe migration prefix backfill (item 26)
docs/HANDOVER.md         # this file
README.md                # local dev quickstart + env vars
SECURITY.md              # disclosure policy (item 25)
instrumentation.ts       # Next 15 onRequestError hook (item 36)
next.config.ts           # static security headers (CSP moved to middleware)
src/middleware.ts        # request-id, CSP nonce, x-pathname
```

## Local setup, the short version

```bash
npm install
cp .env.example .env       # fill DATABASE_URL, ANTHROPIC_API_KEY, NEXTAUTH_SECRET, etc.
npm run prisma:migrate     # applies schema + rls.sql
npm run seed               # creates Acumon operator tenant + FCT + seed users
npm run dev                # http://localhost:3000
```

Magic-link sign-in: use any seeded user's email. Look at the dev-server
stdout for the link (or wire EMAIL_SERVER).

Tests:

```bash
# One-time per local Postgres:
TEST_DATABASE_URL=postgresql://localhost/acumon_test npm run test:setup-db
# Then:
TEST_DATABASE_URL=... npm test
```

CI runs the integration suite in a `postgres:16` service container — see
`.github/workflows/ci.yml`. Three lint gates:

1. `npm run typecheck` — `tsc --noEmit`
2. `npm run check:tenant-scoping` — refuses `new PrismaClient()` outside
   `src/lib/db.ts` + the audited helpers
3. `npm run check:migration-prefixes` — refuses non-zero-padded migration
   directory names

## Deployment

- Hosted on Railway. Push to `main` triggers a deploy.
  `railway.json` runs `npm run prisma:deploy && npm start`, which applies
  pending migrations + RLS + seed BEFORE serving traffic.
- Production URL: `https://communicationsengine-production.up.railway.app`
- Two Railway services:
  - `Communications_Engine` — the Next.js web service.
  - `lifecycle-sweep-cron` — `curlimages/curl:latest` on `0 3 * * *` hitting
    `/api/cron/lifecycle-sweep` with `Authorization: Bearer $CRON_SECRET`.
  - **TODO:** wire additional cron services for `/api/cron/digest`
    (Mondays 09:00 UTC), `/api/cron/audit-verify` (daily 02:30 UTC),
    `/api/cron/health-check` (every 15min), `/api/cron/webhooks-deliver`
    (every 1min), `/api/cron/termination` (daily). All Bearer-auth with
    the same `CRON_SECRET`. Item 22's heartbeat detects any of them
    silently failing to fire.
- `CRON_SECRET` is shared between the web + cron services. Configure the
  cron service's value as `${{Communications_Engine.CRON_SECRET}}` so it
  tracks the web service automatically.
- Required env vars are in `README.md`. The non-obvious ones:
  - `ENCRYPTION_KEY` / `ENCRYPTION_KEYS` — rotation registry from item 27.
    The legacy single-key form is still accepted; multi-key JSON shape is
    `{"v1":"<b64-32-bytes>", "v2":"..."}`.
  - `ENCRYPTION_KEY_ACTIVE_VERSION` — pin the active key version
    explicitly; defaults to the highest `v<N>` present.
  - `AUDIT_HASH_SEED` — once set, **never rotate**. Rotating breaks chain
    verification for every existing row.
  - `LOG_LEVEL` (`debug`/`info`/`warn`/`error`/`silent`) — defaults to
    `info` in prod, `debug` in dev.
  - `HTTP_SLOW_REQUEST_MS` (default 1000) — slow `/api/v1/*` request
    threshold from item 34.
  - `DB_SLOW_QUERY_MS` (default 500) — slow Prisma query threshold from
    item 29.
  - `OBSERVABILITY_WEBHOOK_URL` (optional) — generic JSON POST sink for
    `reportError` (item 4). `SENTRY_DSN` also accepted.

## Roles + RBAC

Five roles + an operator-side admin role:

- **`FIRM_ADMIN`** — senior governance. Configures the tenant — security
  policies, members, sub-processor objections, terms, billing.
- **`FCT_MEMBER`** — compliance + culture stewards. Votes on FCG rules,
  triages adherence + sentiment escalations, reviews meeting minutes,
  handles DSARs.
- **`USER`** — the fee-earner. Sees their own drafts, actions,
  opportunities, meetings.
- **`SALES_REVIEWER`** — routes commercial opportunities flagged by the AI.
- **`CURATOR`** — Acumon-side. Reviews anonymised Cross-Client Learning
  proposals.
- **`ACUMON_ADMIN`** — Acumon staff who configure the global surfaces
  (Roadmap, Risks, Sub-Processors, Integrations).

Source of truth: `src/lib/rbac.ts`. Every permission name is referenced
from `hasPermission` / `requirePermission` calls — grep before adding.

## Shipped post-PRD hardening backlog

44 items shipped. Full per-item summary lives in commit messages; the
short table is in
`C:\Users\stuart\.claude\projects\C--Users-stuart--claude-projects-Communication-Engine\memory\project_post_prd_backlog.md`
on Stuart's machine. The headline ones a new maintainer should know:

| Cluster | Items |
|---|---|
| **Security / auth** | TOTP (12), session mgmt (13, 15), API keys (16), IP allowlist (17), step-up (18, 19), sign-in anomaly (21), CSP nonce (28), encryption rotation (27) |
| **Audit / observability** | Observability + security headers (4), audit list UI (20), chain verification (23), cron heartbeat (22), DB slow-query log (29), HTTP slow request (34), instrumentation.ts (36), safeApiError (38, 39), webhook stats (40), error boundaries (44) |
| **Compliance** | Sub-processor change notice (24), security disclosure (25), GDPR Art. 17 erasure (32), evidence pack (35), public /status (9, 43) |
| **Webhooks** | Subscriptions + delivery (14), SSRF (30), test-fire (37), 24h stats (40) |
| **API hardening** | Idempotency keys (31), safeApiError + typed errors (38, 39, 41), superDb statement_timeout (33) |
| **Product** | Mobile drawer (7), command palette (8), public /status (9), i18n (10), help page (42) |

## In-product user guide

The non-technical surface lives at `/[tenantSlug]/help`. Open it as any
signed-in member; it's the right starting point for someone who needs to
understand what the product does without reading any code. Linked from
the tenant sidebar as "Help & guide".

## Conventions you might not guess from the source

- **One commit per shipped item.** Don't batch unrelated changes. The
  commit message subject is the running map of what shipped.
- **Always push after a successful commit.** Don't sit on local commits.
- **Match existing patterns.** When in doubt, find a similar shipped
  feature (e.g. item 24 for cron-driven cross-tenant fan-out) and copy
  its shape — naming, RBAC, audit event placement.
- **No new dependencies without strong justification.** The codebase has
  resisted bolt-on libraries (homegrown i18n in item 10, homegrown
  observability in item 4, homegrown SSRF defence in item 30) when a
  ~150-line module does the job.
- **Tests run against real Postgres.** Don't mock the database. RLS only
  fires against a real DB; mocking it would lie.
- **Comments are sparse.** When you do write one, explain WHY, not WHAT.
  The codebase's voice is direct; match it.
