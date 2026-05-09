# Acumon Communications (Communication Engine)

Multi-tenant SaaS for governed firm-wide communications. Built to the PRD held locally as `Acumon_Communications_PRD_v0.1.docx`.

## Stack

Next.js 15 (App Router, TypeScript) · Postgres + Prisma · NextAuth v5 magic-link · pluggable LLM providers (Anthropic Claude · Together AI Llama · mock) bound per agent role · Tailwind CSS · Railway deploy.

## Phase 1 (built)

- Multi-tenant data model covering all PRD entities; Phase 2+ tables present so migrations don't churn.
- Postgres RLS + Prisma client extension for tenant isolation.
- Append-only audit log with sha256 hash chain and DB-level immutability trigger.
- Magic-link auth (NextAuth v5) and tenant-scoped RBAC.
- **Firm Culture Guide** — chat-with-Claude drafting, quorum voting, version history.
- **User Culture Guide** — chat drafting with LLM-as-judge compliance gate.
- **Drafting demo** — paste an inbound email, get a draft constrained by FCG + UCG with action extraction and holding-response logic.

## Phase 2+ (scaffolded)

UI stubs and schema present for: M365/Google/Slack OAuth ingestion, calendar/meeting prep, transcript minutes, adherence scoring, sentiment monitoring, Sales Identifier, DPIA Helper, DSAR module, Cross-Client Learning curator console.

## Local development

```bash
npm install
cp .env.example .env          # fill in DATABASE_URL, ANTHROPIC_API_KEY, NEXTAUTH_SECRET, etc.
npm run prisma:migrate        # creates schema and applies RLS
npm run seed                  # creates Acumon Intelligence tenant with FCT + users
npm run dev
```

Open http://localhost:3000, log in as `stuart@acumon.com` (or any seeded user) via magic link, then visit `/acumon/fcg/chat`.

## Railway deployment

Push to `main`. Railway auto-builds via `nixpacks.toml`. Required env vars:

| Var | Purpose |
|---|---|
| `DATABASE_URL`, `DIRECT_URL` | Postgres (use Railway's managed plugin) |
| `NEXTAUTH_URL` | `https://communicationsengine-production.up.railway.app` |
| `NEXTAUTH_SECRET` | `openssl rand -base64 32` |
| `ANTHROPIC_API_KEY` | Anthropic console (used by default for the Compliance Judge + statutory Verifier — the quality-critical roles) |
| `TOGETHER_API_KEY` | api.together.xyz (used by default for FCG/UCG chat, drafting, sentiment) |
| `LLM_<ROLE>` | Optional per-role override, format `provider:model` (see `src/lib/ai/models.ts`) |
| `EMAIL_SERVER`, `EMAIL_FROM` | SMTP for magic links |
| `ENCRYPTION_KEY` | `openssl rand -base64 32` (AES-GCM for OAuth tokens — Phase 2) |
| `AUDIT_HASH_SEED` | Any non-empty string (do not rotate) |
| `CRON_SECRET` | Bearer token shared with the Railway cron service(s) |

Healthcheck: `/api/health`.

### Scheduled jobs

Both cron endpoints require `Authorization: Bearer $CRON_SECRET` and are idempotent.

| Endpoint | Schedule (UTC) | Purpose |
|---|---|---|
| `/api/cron/lifecycle-sweep` | `0 3 * * *` | PRD §14.3 — flip revoke / leaver memberships at end of grace |
| `/api/cron/billing-close` | `5 3 1 * *` | PRD §15.1 — close the previous month's `BillingPeriod` for every active/sandbox tenant |

## Verification

See `Phase 1 verification` in the build plan (`/plans/`).
