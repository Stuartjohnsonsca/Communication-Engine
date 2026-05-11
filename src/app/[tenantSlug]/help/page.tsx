import { redirect } from "next/navigation";
import Link from "next/link";
import { getTenantContext } from "@/lib/tenant";

/**
 * In-product help / user guide (post-PRD hardening).
 *
 * Plain-English walkthrough of what Acumon Communications does, who
 * does what inside it, and where to find each feature. Written for a
 * non-technical reader — the kind of fee-earner or compliance officer
 * who needs a refresher without a technical onboarding session.
 *
 * Lives inside the tenant slug so it's behind login (every member
 * sees it; no per-role gating beyond "signed in to this tenant").
 * Linked from the nav as "Help & guide".
 *
 * Deliberately concrete + opinionated — generic "click here to add a
 * thing" copy is useless; we name the actual pages a reader should
 * visit for each task.
 */
export const dynamic = "force-dynamic";

export default async function HelpPage({
  params,
}: {
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");

  const role = ctx.membership.role;
  const link = (path: string, label: string) => (
    <Link href={`/${tenantSlug}${path}`} className="underline decoration-dotted">
      {label}
    </Link>
  );

  return (
    <div className="space-y-8 max-w-3xl">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Help &amp; guide</h1>
        <p className="mt-2 text-sm text-ink/70">
          A plain-English walkthrough of what this tool does and where to
          find each feature. Your current role is{" "}
          <code className="rounded bg-ink/5 px-1 text-xs">{role}</code> —
          some sections describe actions only certain roles can take.
        </p>
      </div>

      <section className="card space-y-3">
        <h2 className="text-base font-medium">What is Acumon Communications?</h2>
        <p className="text-sm text-ink/80">
          Acumon is a governed communications platform for professional-services firms.
          The short version:
        </p>
        <ul className="list-disc pl-5 text-sm text-ink/80 space-y-1">
          <li>
            We <strong>draft</strong> client-facing messages on your behalf — emails,
            replies, follow-ups — and we <strong>never send anything ourselves</strong>.
            Drafts arrive in your inbox / drafting console; you press send.
          </li>
          <li>
            Before drafting, the AI consults your firm&apos;s written rules (the{" "}
            <strong>Firm Culture Guide</strong>) and your personal style (your{" "}
            <strong>User Culture Guide</strong>) so every draft sounds like your firm
            wrote it.
          </li>
          <li>
            <strong>After</strong> every send (drafted by us OR composed entirely by
            you), we retroactively score the message against the same rules. Poor
            adherence creates a flag for your compliance team — never a block.
          </li>
          <li>
            Every consequential action is recorded on a hash-chained{" "}
            <strong>audit log</strong> that procurement reviewers, regulators, and
            your DPO can verify end to end.
          </li>
        </ul>
      </section>

      <section className="card space-y-3">
        <h2 className="text-base font-medium">Who does what</h2>
        <p className="text-sm text-ink/80">
          Different people see different controls depending on their role on this
          tenant. The five we care about:
        </p>
        <dl className="text-sm space-y-3">
          <div>
            <dt className="font-medium">Firm Administrator (<code className="text-xs">FIRM_ADMIN</code>)</dt>
            <dd className="text-ink/80">
              The senior governance role. Configures the tenant — security
              policies, who&apos;s a member, sub-processor changes, terms, billing.
              Signs off Sub-Processor objections, breaches, terminations.
            </dd>
          </div>
          <div>
            <dt className="font-medium">Firm Communications Team member (<code className="text-xs">FCT_MEMBER</code>)</dt>
            <dd className="text-ink/80">
              Compliance + culture stewards. Vote on Firm Culture Guide rules,
              triage adherence and sentiment escalations, review meeting minutes,
              handle DSARs. The day-to-day quality gate.
            </dd>
          </div>
          <div>
            <dt className="font-medium">User (<code className="text-xs">USER</code>)</dt>
            <dd className="text-ink/80">
              The fee-earner. Sees their own drafts, actions, opportunities, and
              meetings. Builds and amends their User Culture Guide. This is the
              most common role.
            </dd>
          </div>
          <div>
            <dt className="font-medium">Sales Reviewer (<code className="text-xs">SALES_REVIEWER</code>)</dt>
            <dd className="text-ink/80">
              Routes commercial opportunities flagged by the AI. Sees the Sales
              Identifier surface; does not see individual drafts or UCGs.
            </dd>
          </div>
          <div>
            <dt className="font-medium">Cross-Client Learning Curator (<code className="text-xs">CURATOR</code>)</dt>
            <dd className="text-ink/80">
              Acumon-side role. Reviews anonymised proposals that the engine
              learned from one Client and decides whether to apply them across
              opted-in tenants. You won&apos;t see this unless you&apos;re Acumon staff.
            </dd>
          </div>
        </dl>
      </section>

      <section className="card space-y-3">
        <h2 className="text-base font-medium">Your day-to-day, by role</h2>
        <div className="space-y-4 text-sm">
          <div>
            <p className="font-medium">If you&apos;re a fee-earner (USER)</p>
            <ul className="mt-1 list-disc pl-5 text-ink/80 space-y-1">
              <li>
                Drafts arrive at {link("/drafts", "Drafts")} when a client message lands
                in your connected mailbox. Read, edit, send.
              </li>
              <li>
                Tasks the engine identifies (a callback to schedule, a document to
                send) land at {link("/actions", "Actions")}.
              </li>
              <li>
                Commercial signals (a client mentioned wanting more help) land at{" "}
                {link("/opportunities", "Opportunities")} so you can decide whether to
                pursue.
              </li>
              <li>
                Your personal style guide lives at {link("/ucg", "User Culture Guide")} —
                you can amend phrasing rules at any time.
              </li>
            </ul>
          </div>
          <div>
            <p className="font-medium">If you&apos;re on the FCT</p>
            <ul className="mt-1 list-disc pl-5 text-ink/80 space-y-1">
              <li>
                Vote on Firm Culture Guide proposals at {link("/fcg", "Firm Culture Guide")}.
                A quorum is required before a rule takes effect.
              </li>
              <li>
                Messages that scored poorly against the FCG land at{" "}
                {link("/adherence/escalations", "Adherence escalations")} for review.
              </li>
              <li>
                Sentiment shifts and meeting minutes flow through{" "}
                {link("/sentiment", "Sentiment")} and {link("/meetings", "Meetings")}.
              </li>
              <li>
                Subject-access and erasure requests are handled at{" "}
                {link("/dsar", "DSAR")}.
              </li>
            </ul>
          </div>
          <div>
            <p className="font-medium">If you&apos;re a Firm Administrator</p>
            <ul className="mt-1 list-disc pl-5 text-ink/80 space-y-1">
              <li>
                Security posture lives under {link("/admin/security", "Admin → Security")} —
                require 2FA, set IP allowlists, set session timeouts, configure step-up.
              </li>
              <li>
                Member lifecycle (invite, suspend, leaver, anonymise) is at{" "}
                {link("/admin/members", "Admin → Members")} and{" "}
                {link("/admin/lifecycle", "Admin → Lifecycle")}.
              </li>
              <li>
                Programmatic access for SIEM / archive integrations:{" "}
                {link("/admin/api-keys", "API keys")} and {link("/admin/webhooks", "Webhooks")}.
              </li>
              <li>
                When procurement / regulators ask for your security posture, hit{" "}
                {link("/admin/compliance", "Admin → Compliance")} for the one-click
                evidence pack.
              </li>
              <li>
                The full immutable audit log is at {link("/admin/audit", "Admin → Audit log")}.
              </li>
            </ul>
          </div>
        </div>
      </section>

      <section className="card space-y-3">
        <h2 className="text-base font-medium">Key concepts in plain English</h2>
        <dl className="text-sm space-y-3">
          <div>
            <dt className="font-medium">Firm Culture Guide (FCG)</dt>
            <dd className="text-ink/80">
              Your firm&apos;s written rulebook for how you communicate with clients —
              tone, phrasing, what you commit to, what you don&apos;t. The AI reads it
              before drafting and is scored against it after sending.
            </dd>
          </div>
          <div>
            <dt className="font-medium">User Culture Guide (UCG)</dt>
            <dd className="text-ink/80">
              Your personal layer on top of the FCG — phrases you prefer, signatures,
              quirks. Yours alone; other members don&apos;t see it.
            </dd>
          </div>
          <div>
            <dt className="font-medium">Firm Communications Team (FCT)</dt>
            <dd className="text-ink/80">
              The internal committee that owns the FCG and reviews flagged
              communications. Membership is set by the Firm Administrator.
            </dd>
          </div>
          <div>
            <dt className="font-medium">Adherence score</dt>
            <dd className="text-ink/80">
              A 0–1 measure of how well a message followed the FCG + UCG.
              Below the threshold it&apos;s escalated to the FCT for review.
              We never block a send — we only surface the score after the fact.
            </dd>
          </div>
          <div>
            <dt className="font-medium">DPIA (Data Protection Impact Assessment)</dt>
            <dd className="text-ink/80">
              The signed document recording how personal data flows through your
              tenant. Required before the AI scan can run against real messages.
              Lives at {link("/dpia", "DPIA")}.
            </dd>
          </div>
          <div>
            <dt className="font-medium">TIA (Transfer Impact Assessment)</dt>
            <dd className="text-ink/80">
              The signed-off justification for any cross-border data transfer (e.g.
              your data passing through a sub-processor in another country). At{" "}
              {link("/compliance/transfers", "Compliance → Transfers")}.
            </dd>
          </div>
          <div>
            <dt className="font-medium">DSAR (Data Subject Access Request)</dt>
            <dd className="text-ink/80">
              When a person asks "what data do you hold about me?" (access) or "delete
              what you hold" (erasure), the request lifecycle is tracked at{" "}
              {link("/dsar", "DSAR")}. The clock starts at 14 days (standard) /
              30 days (statutory backstop).
            </dd>
          </div>
          <div>
            <dt className="font-medium">Sub-processor</dt>
            <dd className="text-ink/80">
              A third party Acumon uses to run the platform (cloud host, AI provider,
              email sender). The full live list and any pending changes are at{" "}
              {link("/switching", "Switching")} so you can object before a change takes
              effect.
            </dd>
          </div>
          <div>
            <dt className="font-medium">Audit chain</dt>
            <dd className="text-ink/80">
              An immutable, hash-linked record of every consequential action on your
              tenant. Tampering breaks the chain and triggers an alert. You can browse
              it at {link("/admin/audit", "Admin → Audit log")} or export it.
            </dd>
          </div>
          <div>
            <dt className="font-medium">Drafts-only, never sends</dt>
            <dd className="text-ink/80">
              A non-negotiable rule of the engine: nothing leaves your mailbox
              without a human pressing send. The post-send compliance check is the
              opposite of a pre-send block.
            </dd>
          </div>
        </dl>
      </section>

      <section className="card space-y-3">
        <h2 className="text-base font-medium">Where to go for what</h2>
        <p className="text-sm text-ink/80">
          A few jumping-off points if you&apos;re not sure where to start:
        </p>
        <ul className="list-disc pl-5 text-sm text-ink/80 space-y-1">
          <li>
            <strong>Just signed in for the first time?</strong> Visit{" "}
            {link("/dashboard", "Dashboard")} for the at-a-glance view, then{" "}
            {link("/ucg", "User Culture Guide")} to chat your style preferences into the engine.
          </li>
          <li>
            <strong>Looking for a specific message or person?</strong> Press
            <kbd className="ml-1 rounded border border-ink/15 bg-ink/5 px-1 font-mono text-xs">Ctrl/Cmd + K</kbd>{" "}
            anywhere to open the command palette and search drafts, members,
            audit events, sub-processors, and more.
          </li>
          <li>
            <strong>Your locale or 2FA settings?</strong> {link("/account", "My account")} has
            them both.
          </li>
          <li>
            <strong>Procurement / vendor audit asked for evidence?</strong> {" "}
            {link("/admin/compliance", "Admin → Compliance")} gives them a single
            JSON pack covering everything they typically ask about.
          </li>
          <li>
            <strong>Something not working?</strong> {link("/admin/audit", "Admin → Audit log")}{" "}
            shows what happened on your tenant — every consequential action is
            recorded. Your FIRM_ADMIN can verify the chain integrity from there.
          </li>
        </ul>
      </section>

      <section className="card space-y-3">
        <h2 className="text-base font-medium">Things we will never do</h2>
        <ul className="list-disc pl-5 text-sm text-ink/80 space-y-1">
          <li>
            Send a message to a client on your behalf. We draft only.
          </li>
          <li>
            Block a send because the AI didn&apos;t like it. We score after, escalate
            on poor adherence, and let your FCT decide.
          </li>
          <li>
            Mutate the audit chain. Anonymising a user pseudonymises the row but
            preserves the hashes — the chain stays verifiable.
          </li>
          <li>
            Share your data across tenants without your firm&apos;s explicit Cross-Client
            Learning opt-in plus a signed DPIA covering it.
          </li>
        </ul>
      </section>

      <p className="text-xs text-ink/50">
        Still stuck? Your Firm Administrator can reach Acumon support via the
        contact path in {link("/switching", "Switching")} — that page lists every
        sub-processor + escalation route.
      </p>
    </div>
  );
}
