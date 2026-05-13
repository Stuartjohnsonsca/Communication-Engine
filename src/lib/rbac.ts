import type { Role } from "@prisma/client";

/**
 * Permission matrix per PRD §4. `*` = all roles.
 * Format: `{resource}:{action}`.
 */
export const PERMISSIONS: Record<string, Role[]> = {
  // FCG
  "fcg:read":            ["FIRM_ADMIN", "FCT_MEMBER", "USER", "SALES_REVIEWER"],
  "fcg:propose":         ["FIRM_ADMIN", "FCT_MEMBER", "USER"],
  "fcg:vote":            ["FCT_MEMBER", "FIRM_ADMIN"],
  "fcg:commit":          ["FCT_MEMBER", "FIRM_ADMIN"],
  "fcg:emergency":       ["FIRM_ADMIN"],
  // Firm Culture Scan (PRD §5.1.1). The Firm Administrator initiates scans;
  // the FCT can read scan history for governance oversight (the audit chain
  // anchors what corpus was sampled and what the model proposed).
  "fcg:scan:read":       ["FIRM_ADMIN", "FCT_MEMBER"],
  "fcg:scan:run":        ["FIRM_ADMIN"],

  // UCG
  "ucg:read:self":       ["USER", "FCT_MEMBER", "FIRM_ADMIN", "SALES_REVIEWER"],
  "ucg:read:any":        ["FCT_MEMBER", "FIRM_ADMIN"],
  "ucg:write:self":      ["USER", "FCT_MEMBER", "FIRM_ADMIN", "SALES_REVIEWER"],
  "ucg:override":        ["FCT_MEMBER", "FIRM_ADMIN"],

  // Drafting
  "draft:read:self":     ["USER", "FCT_MEMBER", "FIRM_ADMIN", "SALES_REVIEWER"],
  "draft:create":        ["USER", "FCT_MEMBER", "FIRM_ADMIN", "SALES_REVIEWER"],

  // Meetings (PRD §7.4) — any User can schedule a meeting they are running
  // and draft its paper. The paper-author defaults to the meeting creator
  // unless an FCT/admin reassigns it.
  "meeting:create":      ["USER", "FCT_MEMBER", "FIRM_ADMIN", "SALES_REVIEWER"],
  "meeting:write":       ["USER", "FCT_MEMBER", "FIRM_ADMIN", "SALES_REVIEWER"],
  "meeting:read":        ["USER", "FCT_MEMBER", "FIRM_ADMIN", "SALES_REVIEWER"],

  // Admin
  "members:read":        ["FIRM_ADMIN", "FCT_MEMBER"],
  "members:write":       ["FIRM_ADMIN"],
  "channels:write":      ["FIRM_ADMIN"],

  // Item 58 — tenant-level auto-draft pause toggle. Operationally
  // invasive (pauses background production for every Member in the
  // tenant), so FIRM_ADMIN only. FCT can see the state on
  // /admin/channels via existing surface but cannot flip it.
  "auto-draft:pause":    ["FIRM_ADMIN"],
  // Item 62 — operator unquarantine of inbound that failed
  // `QUARANTINE_THRESHOLD` consecutive draft attempts. Retry budget
  // is reset by the action, so re-flipping it could thrash; gate to
  // FIRM_ADMIN (same posture as pause).
  "auto-draft:unquarantine": ["FIRM_ADMIN"],
  "audit:read":          ["FIRM_ADMIN", "FCT_MEMBER"],
  "audit:export":        ["FIRM_ADMIN"],

  // DPIA Helper (PRD §12.2). FCT can see attestation status; only the Firm
  // Administrator (in tandem with the Client DPO offline) can sign one off.
  "dpia:read":           ["FIRM_ADMIN", "FCT_MEMBER"],
  "dpia:write":          ["FIRM_ADMIN"],

  // DSAR module (PRD §12.4). FCT can see and progress requests; only the
  // Firm Administrator can mark a DSAR fulfilled (tight to the Client's
  // statutory accountability). Subjects download their own data via the
  // standard ACCESS export, not via a separate role.
  "dsar:read":           ["FIRM_ADMIN", "FCT_MEMBER"],
  "dsar:write":          ["FIRM_ADMIN", "FCT_MEMBER"],
  "dsar:fulfill":        ["FIRM_ADMIN"],

  // Sales Identifier
  "opportunity:review":  ["SALES_REVIEWER", "FIRM_ADMIN"],

  // User Lifecycle (PRD §14.3). FCT can see the lifecycle console (the FCT
  // is notified on revocation and tracks anonymisation timing); only the
  // Firm Administrator can mark a member as leaver or reverse it. Self-serve
  // revocation lives outside the role gate — any member can revoke their
  // own access from /account.
  "lifecycle:read":      ["FIRM_ADMIN", "FCT_MEMBER"],
  "lifecycle:write":     ["FIRM_ADMIN"],

  // Billing (PRD §15). Commercial concern — kept to the Firm Administrator
  // alone. The FCT does not see invoices or pricing.
  "billing:read":        ["FIRM_ADMIN"],
  "billing:manage":      ["FIRM_ADMIN"],

  // Item 55 — LLM usage observability. Token counts + estimated cost
  // are operational/commercial data; same posture as billing (FIRM_ADMIN
  // only). The FCT does not see model spend.
  "usage:read":          ["FIRM_ADMIN"],

  // Item 56 — draft outcome rollup. The "is the engine actually
  // producing useful drafts?" page (acceptance/send rate, source
  // split, regeneration, latency). FCT can read for governance
  // oversight — the rollup answers whether the FCG is producing
  // on-promise drafts, which is squarely within their remit. The
  // FCT does NOT see per-User cost (`usage:read` stays FIRM_ADMIN);
  // outcome metrics are non-commercial.
  "drafts:read-rollup":  ["FIRM_ADMIN", "FCT_MEMBER"],

  // Item 83 — sentiment responses export. The "every signal in the
  // window with full ack metadata" CSV that pairs with the in-page
  // response-time card. Same governance-not-commercial posture as
  // `drafts:read-rollup`: FCT_MEMBER reads sentiment for governance
  // oversight (item 79's pillar — they need the same evidence record
  // as FIRM_ADMIN to back the response-time numbers up). No per-User
  // cost data in the export — response-time only.
  "sentiment:export":    ["FIRM_ADMIN", "FCT_MEMBER"],

  // Roadmap (PRD §16). The product roadmap is published to every Client per
  // §15.3 switching/lock-in posture, so any signed-in role can read. Mutating
  // status / exit criteria is operator-only and additionally gated to the
  // Acumon-internal tenant in the page handler — there's no concept of a
  // per-Client roadmap, only one product plan.
  "roadmap:read":        ["FIRM_ADMIN", "FCT_MEMBER", "USER", "SALES_REVIEWER", "CURATOR", "ACUMON_ADMIN"],
  "roadmap:manage":      ["FIRM_ADMIN", "ACUMON_ADMIN"],

  // Risks Register (PRD §17). Same posture as the Roadmap (§16): published to
  // every Client per §15.3 transparency, so every signed-in role can read.
  // Status / severity / notes / periodic-review ticks are operator-only and
  // additionally gated to the Acumon-internal tenant in the page handler.
  "risks:read":          ["FIRM_ADMIN", "FCT_MEMBER", "USER", "SALES_REVIEWER", "CURATOR", "ACUMON_ADMIN"],
  "risks:manage":        ["FIRM_ADMIN", "ACUMON_ADMIN"],

  // Open Questions for Sign-Off (PRD §18). Each tenant has its own copy of
  // the ten PRD questions and answers them for themselves (their retention
  // period, their quorum default, their pricing position, etc.). Tenant
  // isolation is enforced by RLS on `SignOffQuestion` and by tenant-scoped
  // queries in `src/lib/signoff/index.ts`; this matrix only governs WHO
  // within a tenant may read or manage. Commercial-sensitive content
  // (pricing tiers, partner discounts) keeps this to the Firm Administrator;
  // the FCT can read for governance oversight but does not edit.
  "signoff:read":        ["FIRM_ADMIN", "FCT_MEMBER"],
  "signoff:manage":      ["FIRM_ADMIN"],

  // Terms and Conditions persistence (PRD §15.4). FCT can read for
  // governance oversight (DPA / SLA terms tie into their compliance work);
  // only FIRM_ADMIN records / activates / amends.
  "terms:read":          ["FIRM_ADMIN", "FCT_MEMBER"],
  "terms:manage":        ["FIRM_ADMIN"],

  // Switching and lock-in posture (PRD §15.3). Read is universal — every
  // signed-in role sees the sub-processor list and the switching commitments.
  // Manage is Acumon-side, gated additionally on `tenant.slug === "acumon"`
  // in the page handler — same shape as Roadmap (§16) and Risks (§17).
  "switching:read":      ["FIRM_ADMIN", "FCT_MEMBER", "USER", "SALES_REVIEWER", "CURATOR", "ACUMON_ADMIN"],
  "subprocessors:manage":["FIRM_ADMIN", "ACUMON_ADMIN"],
  // Post-PRD hardening item 24 — sub-processor change objections. Only the
  // Firm Administrator of a Client tenant can lodge or withdraw an objection
  // (it's a contractual posture decision, not a day-to-day operation). FCT
  // can read the objection state for governance oversight via switching:read.
  "subprocessor-objections:raise": ["FIRM_ADMIN"],

  // Post-PRD hardening — compliance evidence pack export (audit-ready
  // security posture snapshot for SOC 2 / ISO 27001 / vendor audits).
  // FIRM_ADMIN only because the pack covers configuration the FCT
  // doesn't own (API keys, IP allowlist, encryption key rotation
  // history). Read-only by nature; the audit chain records every
  // export with the actor for forensic correlation.
  "compliance:export-evidence-pack": ["FIRM_ADMIN", "ACUMON_ADMIN"],

  // Tenant Termination (PRD §14.4). Notice / reverse / export generation are
  // controllership decisions — restricted to the FIRM_ADMIN. The FCT can read
  // the lifecycle status for governance oversight (any export pulled is in
  // their concern) but cannot trigger termination.
  "termination:read":    ["FIRM_ADMIN", "FCT_MEMBER"],
  "termination:manage":  ["FIRM_ADMIN"],

  // Sandbox / Dry-Run (PRD §14.2). Provisioning and outcome recording are
  // operator decisions — restricted to the FIRM_ADMIN of the parent tenant.
  // FCT reads the sandbox status (cohort, candidate FCGs) for governance
  // oversight but does not provision or conclude.
  "sandbox:read":        ["FIRM_ADMIN", "FCT_MEMBER"],
  "sandbox:manage":      ["FIRM_ADMIN"],

  // Cross-Client Learning (PRD §11). Three permissions:
  //   xcl:opt-in   — flip the per-tenant lawful-basis gate. Restricted to the
  //                  Firm Administrator (controllership decision per §11.2).
  //   xcl:read     — read the queue / opt-in status. FCT can see for governance
  //                  oversight; CURATOR + ACUMON_ADMIN see the whole queue.
  //   xcl:curate   — review candidates and record re-identification tests.
  //                  Acumon-side; the page handler also gates on
  //                  `tenant.slug === "acumon"` for FIRM_ADMIN.
  "xcl:opt-in":          ["FIRM_ADMIN"],
  "xcl:read":            ["FIRM_ADMIN", "FCT_MEMBER", "CURATOR", "ACUMON_ADMIN"],
  "xcl:curate":          ["CURATOR", "ACUMON_ADMIN", "FIRM_ADMIN"],
  "tenant:provision":    ["ACUMON_ADMIN"],

  // Backlog item 10 — UI internationalisation. Setting the tenant-wide
  // default UI locale (the value Memberships inherit when they have no
  // explicit preference) is a Firm Administrator decision; per-User
  // preferences are not gated and are always editable on /account.
  "tenant:configure-locale": ["FIRM_ADMIN"],

  // Integration Tiers (PRD §10). Same posture as the Roadmap (§16), Risks
  // (§17) and Sub-Processors (§15.3): the catalogue is published to every
  // Client per §15.3 transparency, so any signed-in role can read. Mutating
  // status / scope / new entries is operator-only and additionally gated to
  // the Acumon-internal tenant in the page handler — there's no concept of
  // a per-Client integration roadmap, only one product-wide list.
  "integrations:read":   ["FIRM_ADMIN", "FCT_MEMBER", "USER", "SALES_REVIEWER", "CURATOR", "ACUMON_ADMIN"],
  "integrations:manage": ["FIRM_ADMIN", "ACUMON_ADMIN"],

  // Controller / Processor Map (PRD §12.1). FCT + FIRM_ADMIN read for
  // governance oversight; the page itself is also indirectly visible via
  // the DPIA workspace which already has fct/firm_admin scoping. Mutating
  // the matrix is operator-only and gated to the Acumon tenant — the
  // controller/processor model is product-wide, not per-Client. We do not
  // expose this to USER / SALES_REVIEWER because the legal classification
  // is governance-grade content (DPO-level reading), not operational copy.
  "processing-map:read":   ["FIRM_ADMIN", "FCT_MEMBER", "ACUMON_ADMIN", "CURATOR"],
  "processing-map:manage": ["FIRM_ADMIN", "ACUMON_ADMIN"],

  // Cross-Border Transfer (PRD §12.6). Per-tenant Transfer Impact
  // Assessments — record who signed, the SCC + TIA document references,
  // and the effective dates. FCT can read for governance oversight (TIA
  // expiry is a quarterly review item); FIRM_ADMIN records / revokes.
  "transfers:read":   ["FIRM_ADMIN", "FCT_MEMBER"],
  "transfers:manage": ["FIRM_ADMIN"],

  // Breach Notification (PRD §12.9). Two surfaces:
  //   breach:read    — every Client can read notifications addressed to
  //                    them (FCT + FIRM_ADMIN; the FCT is included so
  //                    governance has eyes on incidents in this tenant).
  //   breach:notify  — Client-side acknowledgement (FIRM_ADMIN records
  //                    that they have received and read the notice; this
  //                    is contractually relevant under the DPA).
  //   breach:manage  — Acumon-side incident lifecycle (record incident,
  //                    triage, contain, resolve; dispatch notifications).
  //                    Page handler additionally gates on tenant.slug ===
  //                    "acumon" so even FIRM_ADMINs of other tenants
  //                    cannot record incidents.
  "breach:read":   ["FIRM_ADMIN", "FCT_MEMBER"],
  "breach:notify": ["FIRM_ADMIN"],
  "breach:manage": ["FIRM_ADMIN", "ACUMON_ADMIN"],

  // Service Levels (PRD §13). The SLA target catalogue is universal-read
  // (transparent commitment); each tenant's measurements are read by FCT
  // + FIRM_ADMIN; recording measurements is gated to Acumon operators
  // (page handler also gates on tenant.slug === "acumon" for some paths).
  "sla:read":       ["FIRM_ADMIN", "FCT_MEMBER", "USER", "SALES_REVIEWER", "CURATOR", "ACUMON_ADMIN"],
  "sla:manage":     ["FIRM_ADMIN", "ACUMON_ADMIN"],

  // Localisation (PRD §13.5). The supported-languages registry is
  // universal-read; mutations gated to Acumon operators.
  "languages:read":   ["FIRM_ADMIN", "FCT_MEMBER", "USER", "SALES_REVIEWER", "CURATOR", "ACUMON_ADMIN"],
  "languages:manage": ["FIRM_ADMIN", "ACUMON_ADMIN"],

  // Accessibility statement (PRD §13.4). Universal-read; published
  // versions managed by Acumon operators.
  "accessibility:read":   ["FIRM_ADMIN", "FCT_MEMBER", "USER", "SALES_REVIEWER", "CURATOR", "ACUMON_ADMIN"],
  "accessibility:manage": ["FIRM_ADMIN", "ACUMON_ADMIN"],

  // Client Onboarding (PRD §14.1). FCT can read for governance oversight
  // (the FCT is appointed as part of the configuration phase and tracks
  // FCG approval); only FIRM_ADMIN ticks items / advances phases. The
  // checklist itself is per-tenant; there is no Acumon-tenant gate.
  "onboarding:read":   ["FIRM_ADMIN", "FCT_MEMBER"],
  "onboarding:manage": ["FIRM_ADMIN"],

  // Adherence escalations (post-PRD backlog item 1). Anyone with a
  // membership can read their own escalations queue; the page itself
  // widens to firm-wide for FCT / FIRM_ADMIN via members:read so
  // governance retains the same visibility it has on sentiment.
  // Acknowledge is allowed for the assignee or any FCT / FIRM_ADMIN —
  // enforced inside the route, mirroring sentiment acknowledge.
  "adherence:read":        ["FIRM_ADMIN", "FCT_MEMBER", "USER", "SALES_REVIEWER"],
  "adherence:acknowledge": ["FIRM_ADMIN", "FCT_MEMBER", "USER", "SALES_REVIEWER"],

  // Post-PRD hardening item 12 — TOTP 2FA. Every Membership can enroll
  // / disable / verify their own TOTP. Only FIRM_ADMIN can flip the
  // tenant-wide `requireTotp` flag (the policy that mandates enrollment
  // for every Membership in the tenant). There is no operator-wide gate
  // — 2FA is universal-baseline; tenant policy is a per-tenant decision.
  "auth:configure-totp":        ["FIRM_ADMIN", "FCT_MEMBER", "USER", "SALES_REVIEWER", "CURATOR", "ACUMON_ADMIN"],
  "tenant:configure-totp-policy": ["FIRM_ADMIN"],

  // Post-PRD hardening item 13 — session management. Every Membership can
  // list and revoke their own sessions (universal). FIRM_ADMINs of a tenant
  // can additionally see and revoke any session belonging to a User who has
  // an ACTIVE membership in that tenant — incident-response handle when a
  // member's credentials are compromised or their laptop walks out. The
  // affected User is the one whose User.id owns the Session row, regardless
  // of which tenant they were viewing when the session was created; sessions
  // are per-User not per-Membership.
  "auth:read-own-sessions":      ["FIRM_ADMIN", "FCT_MEMBER", "USER", "SALES_REVIEWER", "CURATOR", "ACUMON_ADMIN"],
  "auth:revoke-own-sessions":    ["FIRM_ADMIN", "FCT_MEMBER", "USER", "SALES_REVIEWER", "CURATOR", "ACUMON_ADMIN"],
  "tenant:revoke-member-sessions": ["FIRM_ADMIN"],
  // Post-PRD hardening item 15 — idle + absolute session timeout. The Firm
  // Administrator configures the per-tenant thresholds; the layout-level
  // and cron-level enforcers read those thresholds (null = inherit platform
  // default).
  "tenant:configure-session-timeout": ["FIRM_ADMIN"],

  // Post-PRD hardening item 14 — outbound webhook delivery. The Firm
  // Administrator subscribes HTTPS receivers to audit-event types and
  // receives signed POSTs whenever any matching event lands on the chain.
  // The FCT can read for governance oversight (knowing what data leaves the
  // platform is part of their compliance remit) but does not configure or
  // mutate. The signing secret is shown to the FIRM_ADMIN once on creation
  // and never read back, so even FCT visibility never exposes it.
  "webhooks:read":      ["FIRM_ADMIN", "FCT_MEMBER"],
  "webhooks:configure": ["FIRM_ADMIN"],

  // Post-PRD hardening item 16 — programmatic API keys. Issuing a key
  // binds the integrator caller to the issuing Membership's role at
  // request time (intersected with the key's scopes), so the act of
  // issuing one is a controllership decision: limited to FIRM_ADMIN.
  // The FCT can read the list (knowing what programmatic credentials
  // exist is part of their governance remit, same posture as
  // `webhooks:read`) but cannot create or revoke. Every Membership
  // can read AND revoke keys IT created — `apikeys:manage-own` —
  // because a key inherits its creator's permissions and revocation
  // by the creator is symmetric with creation. FIRM_ADMIN
  // additionally can revoke any key in the tenant (incident response
  // when a key is suspected leaked).
  "apikeys:read":        ["FIRM_ADMIN", "FCT_MEMBER"],
  "apikeys:create":      ["FIRM_ADMIN"],
  "apikeys:revoke-any":  ["FIRM_ADMIN"],
  "apikeys:manage-own":  ["FIRM_ADMIN", "FCT_MEMBER", "USER", "SALES_REVIEWER", "CURATOR", "ACUMON_ADMIN"],

  // Post-PRD hardening item 17 — tenant IP allowlist. Restricting
  // authenticated access to specific networks is a procurement-driven
  // posture decision, kept to the Firm Administrator. There is no
  // read gate beyond the page-level FIRM_ADMIN check — the list is
  // visible to anyone who reaches /admin/security, which itself is
  // already FIRM_ADMIN-only.
  "tenant:configure-ip-allowlist": ["FIRM_ADMIN"],

  // Post-PRD hardening item 19 — admin-initiated TOTP reset for
  // locked-out members. Only FIRM_ADMIN can clear another User's
  // 2FA enrollment. The action is step-up gated and audited; the
  // affected User is also notified (email + in-app inbox) so a
  // FIRM_ADMIN cannot quietly disable a colleague's 2FA without
  // them noticing.
  "tenant:reset-member-totp": ["FIRM_ADMIN"],

  // Post-PRD hardening item 22 — cron heartbeat monitoring. The
  // /admin/health page is Acumon-side only (cron schedules are
  // platform-wide, not per-tenant); the page handler additionally
  // gates on `tenant.slug === "acumon"` so even FIRM_ADMINs of
  // other tenants cannot view operator infrastructure status.
  // Read-only — there are no mutating actions on the page.
  "system:cron-health:read": ["FIRM_ADMIN", "ACUMON_ADMIN"],
};

export function hasPermission(role: Role, action: string): boolean {
  const allowed = PERMISSIONS[action];
  if (!allowed) return false;
  return allowed.includes(role);
}

export function requirePermission(role: Role | undefined, action: string): asserts role is Role {
  if (!role || !hasPermission(role, action)) {
    throw new PermissionError(action, role);
  }
}

export class PermissionError extends Error {
  status = 403;
  constructor(public action: string, public role?: Role) {
    super(`Permission denied: role=${role ?? "anon"} cannot ${action}`);
    this.name = "PermissionError";
  }
}
