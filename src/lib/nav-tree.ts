import type { Membership, Tenant } from "@prisma/client";
import { hasPermission } from "./rbac";

/**
 * Backlog item 112 — condensed grouped navigation.
 *
 * The flat 48-item left-hand nav was overwhelming on first load.
 * This module is the single source of truth for the grouped tree
 * used by both the sidebar and the per-group tile landing pages.
 *
 * Shape: top-level `NavNode`s render as sidebar entries. A node
 * with `items` (or `sections`) doubles as a tile-grid landing
 * page at `href`; a node without children renders as a direct
 * link (Dashboard, Notifications, Help, Account).
 *
 * Visibility uses the same per-entry gates the old flat nav used —
 * the goal is purely re-arrangement, not RBAC change. After filtering,
 * any group whose children all drop out is itself hidden.
 *
 * Labels are hardcoded English for now (i18n nav keys are typed
 * against the en-GB dictionary, so adding new keys would force
 * matching additions to fr.ts; the group taxonomy can be migrated
 * to i18n in a follow-up without disturbing call sites).
 */
type NavCtx = {
  membership: Pick<Membership, "role">;
  tenant: Pick<Tenant, "slug" | "isSandbox" | "onboardingPhase">;
};

export type NavLeaf = {
  id: string;
  href: string;
  label: string;
  description: string;
};

export type NavSection = {
  id: string;
  label: string;
  items: NavLeaf[];
};

export type NavNode = {
  id: string;
  href: string;
  label: string;
  description: string;
  /** Flat children for a tile-grid landing page. Mutually exclusive with `sections`. */
  items?: NavLeaf[];
  /** Section-grouped children (admin landing). Mutually exclusive with `items`. */
  sections?: NavSection[];
};

type LeafSpec = {
  id: string;
  path: string; // appended after /<tenantSlug>
  label: string;
  description: string;
  visible?: (ctx: NavCtx) => boolean;
};

type SectionSpec = {
  id: string;
  label: string;
  items: LeafSpec[];
};

type NodeSpec = {
  id: string;
  path: string;
  label: string;
  description: string;
  items?: LeafSpec[];
  sections?: SectionSpec[];
};

const perm = (action: string) => (ctx: NavCtx) =>
  hasPermission(ctx.membership.role, action);

const and =
  (...fns: Array<(ctx: NavCtx) => boolean>) =>
  (ctx: NavCtx) =>
    fns.every((f) => f(ctx));

const SCHEMA: NodeSpec[] = [
  // Direct top-level links — no children, no tile page.
  {
    id: "dashboard",
    path: "/dashboard",
    label: "Dashboard",
    description: "At-a-glance snapshot for this tenant.",
  },

  // Day-to-day fee-earner surfaces.
  {
    id: "work",
    path: "/work",
    label: "Work",
    description: "Drafts, actions, opportunities and meetings.",
    items: [
      {
        id: "drafts",
        path: "/drafts",
        label: "Drafts",
        description: "Outbound drafts produced from inbound mail or composed manually.",
      },
      {
        id: "actions",
        path: "/actions",
        label: "Actions",
        description: "Tasks the engine identified from your conversations.",
      },
      {
        id: "opportunities",
        path: "/opportunities",
        label: "Opportunities",
        description: "Commercial signals flagged for follow-up.",
      },
      {
        id: "meetings",
        path: "/meetings",
        label: "Meetings",
        description: "Prep notes, agendas, and minutes.",
      },
    ],
  },

  // FCG / UCG.
  {
    id: "culture",
    path: "/culture",
    label: "Culture",
    description: "The firm rulebook and your personal style layer.",
    items: [
      {
        id: "fcg",
        path: "/fcg",
        label: "Firm Culture Guide",
        description: "Propose, vote and commit firm-wide drafting rules.",
      },
      {
        id: "ucg",
        path: "/ucg",
        label: "My Culture Guide",
        description: "Your personal phrasing and signature preferences.",
      },
    ],
  },

  // Adherence + sentiment.
  {
    id: "quality",
    path: "/quality",
    label: "Quality",
    description: "Adherence scores, escalations and sentiment monitoring.",
    items: [
      {
        id: "adherence",
        path: "/dashboards",
        label: "Adherence",
        description: "Your post-send adherence scores.",
      },
      {
        id: "adherence-escalations",
        path: "/adherence/escalations",
        label: "Adherence escalations",
        description: "Messages flagged for FCT review.",
        visible: perm("adherence:read"),
      },
      {
        id: "sentiment",
        path: "/sentiment",
        label: "Sentiment",
        description: "Per-client sentiment shifts and escalations.",
      },
    ],
  },

  // Privacy + compliance.
  {
    id: "privacy",
    path: "/privacy",
    label: "Privacy",
    description: "DPIA, data flows, transfers, breaches and DSARs.",
    items: [
      {
        id: "dpia",
        path: "/dpia",
        label: "DPIA",
        description: "Data Protection Impact Assessment for this tenant.",
      },
      {
        id: "processing-map",
        path: "/compliance/processing-map",
        label: "Controller / Processor",
        description: "Per-purpose controller / processor map.",
        visible: perm("processing-map:read"),
      },
      {
        id: "transfers",
        path: "/compliance/transfers",
        label: "Cross-border transfer",
        description: "Transfer Impact Assessments for international data flows.",
        visible: perm("transfers:read"),
      },
      {
        id: "breaches",
        path: "/compliance/breaches",
        label: "Breach notifications",
        description: "Drafted regulator and client breach notifications.",
        visible: perm("breach:read"),
      },
      {
        id: "dsar",
        path: "/dsar",
        label: "DSAR",
        description: "Data Subject Access and erasure requests.",
      },
    ],
  },

  // Operations.
  {
    id: "operations",
    path: "/operations",
    label: "Operations",
    description: "Roadmap, risks, switching, integrations and service levels.",
    items: [
      {
        id: "roadmap",
        path: "/roadmap",
        label: "Roadmap",
        description: "What this tenant has scheduled.",
      },
      {
        id: "risks",
        path: "/risks",
        label: "Risks",
        description: "Operational risks raised against this tenant.",
      },
      {
        id: "switching",
        path: "/switching",
        label: "Switching posture",
        description: "Sub-processors, exports, exit-readiness evidence.",
      },
      {
        id: "integrations",
        path: "/integrations",
        label: "Integrations",
        description: "Your connected mailboxes, calendars and chat channels.",
      },
      {
        id: "sla",
        path: "/sla",
        label: "Service levels",
        description: "Tenant SLA targets and recent compliance.",
        visible: perm("sla:read"),
      },
      {
        id: "accessibility",
        path: "/accessibility",
        label: "Accessibility",
        description: "Accessibility conformance evidence.",
        visible: perm("accessibility:read"),
      },
      {
        id: "languages",
        path: "/languages",
        label: "Languages",
        description: "Interface and drafting language settings.",
        visible: perm("languages:read"),
      },
    ],
  },

  // Direct top-level link.
  {
    id: "notifications",
    path: "/notifications",
    label: "Notifications",
    description: "Your in-app inbox.",
  },

  // Admin landing — sectioned tile page.
  {
    id: "admin",
    path: "/admin",
    label: "Admin",
    description: "Tenant administration, integrations, compliance and operations.",
    sections: [
      {
        id: "people",
        label: "People",
        items: [
          {
            id: "members",
            path: "/admin/members",
            label: "Members",
            description: "Invite, suspend, and manage tenant members.",
          },
          {
            id: "lifecycle",
            path: "/admin/lifecycle",
            label: "Lifecycle",
            description: "Leaver, revoke and anonymise workflows.",
          },
          {
            id: "signoff",
            path: "/sign-off",
            label: "Sign-off questions",
            description: "Per-tenant assurance questions and responses.",
            visible: perm("signoff:read"),
          },
        ],
      },
      {
        id: "tenant",
        label: "Tenant",
        items: [
          {
            id: "security",
            path: "/admin/security",
            label: "Security",
            description: "2FA policy, IP allowlist, session timeout, step-up.",
            visible: perm("tenant:configure-totp-policy"),
          },
          {
            id: "sensitivity",
            path: "/admin/sensitivity",
            label: "Alert sensitivity",
            description: "Per-tenant cron and stale-threshold overrides.",
            visible: perm("tenant:configure-cron-thresholds"),
          },
          {
            id: "terms",
            path: "/admin/terms",
            label: "Terms",
            description: "Terms and Conditions version history.",
            visible: perm("terms:read"),
          },
          {
            id: "onboarding",
            path: "/admin/onboarding",
            label: "Onboarding",
            description: "Onboarding checklist and phase.",
            visible: (ctx) =>
              hasPermission(ctx.membership.role, "onboarding:read") &&
              ctx.tenant.onboardingPhase !== "LIVE",
          },
          {
            id: "termination",
            path: "/admin/termination",
            label: "Termination",
            description: "Exit / on-demand export workflows.",
            visible: perm("termination:read"),
          },
          {
            id: "sandbox",
            path: "/admin/sandbox",
            label: "Sandbox",
            description: "Spin up a sandbox tenant for testing.",
            visible: (ctx) =>
              hasPermission(ctx.membership.role, "sandbox:read") && !ctx.tenant.isSandbox,
          },
        ],
      },
      {
        id: "integrations",
        label: "Integrations",
        items: [
          {
            id: "channels",
            path: "/admin/channels",
            label: "Channels",
            description: "M365, Google and Slack channel connections.",
          },
          {
            id: "oauth-apps",
            path: "/admin/channels/oauth-apps",
            label: "OAuth provider apps",
            description: "Bring-your-own provider app credentials.",
            visible: perm("tenant:configure-channel-oauth-app"),
          },
          {
            id: "imap-servers",
            path: "/admin/channels/imap-servers",
            label: "IMAP servers",
            description: "Legacy and on-prem mail server config.",
            visible: perm("channels:write"),
          },
          {
            id: "webhooks",
            path: "/admin/webhooks",
            label: "Webhooks",
            description: "Outbound webhooks for SIEM and archive integrations.",
            visible: perm("webhooks:read"),
          },
          {
            id: "api-keys",
            path: "/admin/api-keys",
            label: "API keys",
            description: "Programmatic access tokens.",
            visible: perm("apikeys:read"),
          },
        ],
      },
      {
        id: "compliance",
        label: "Compliance",
        items: [
          {
            id: "audit",
            path: "/admin/audit",
            label: "Audit log",
            description: "Immutable hash-chained event log; verify integrity here.",
          },
          {
            id: "conflicts",
            path: "/admin/conflicts",
            label: "UCG conflicts",
            description: "UCG vs FCG overrides awaiting review.",
          },
          {
            id: "draft-outcomes",
            path: "/admin/drafts",
            label: "Draft outcomes",
            description: "Rollup of FCG-on-promise draft outcomes.",
            visible: perm("drafts:read-rollup"),
          },
          {
            id: "sales-identifier",
            path: "/admin/sales-identifier",
            label: "Sales Identifier",
            description: "Commercial opportunities surfaced from communications.",
          },
          {
            id: "xcl",
            path: "/admin/xcl",
            label: "Cross-Client Learning",
            description: "Anonymised proposals from one Client offered to others.",
            visible: perm("xcl:read"),
          },
        ],
      },
      {
        id: "ops",
        label: "Operations",
        items: [
          {
            id: "firm-adherence",
            path: "/admin/adherence",
            label: "Firm adherence",
            description: "Firm-wide adherence trend across all members.",
          },
          {
            id: "billing",
            path: "/admin/billing",
            label: "Billing",
            description: "Closed billing periods and current usage to date.",
            visible: perm("billing:read"),
          },
          {
            id: "usage",
            path: "/admin/usage",
            label: "LLM usage",
            description: "Per-role token and call volume.",
            visible: perm("usage:read"),
          },
          {
            id: "system-health",
            path: "/admin/health",
            label: "System health",
            description: "Cron heartbeat and worker health (Acumon-only).",
            visible: (ctx) =>
              hasPermission(ctx.membership.role, "system:cron-health:read") &&
              ctx.tenant.slug === "acumon",
          },
        ],
      },
    ],
  },

  // Direct top-level links — kept at the bottom of the sidebar.
  {
    id: "help",
    path: "/help",
    label: "Help & guide",
    description: "Plain-English walkthrough of the product.",
  },
  {
    id: "account",
    path: "/account",
    label: "My account",
    description: "Your locale, notification preferences and 2FA.",
  },
];

/** Resolve the schema to the concrete tree this user can see. */
export function buildNavTree(ctx: NavCtx, tenantSlug: string): NavNode[] {
  const out: NavNode[] = [];
  for (const node of SCHEMA) {
    const href = `/${tenantSlug}${node.path}`;
    if (node.sections) {
      const sections: NavSection[] = [];
      for (const sec of node.sections) {
        const items = filterItems(sec.items, ctx, tenantSlug);
        if (items.length) sections.push({ id: sec.id, label: sec.label, items });
      }
      if (sections.length) {
        out.push({
          id: node.id,
          href,
          label: node.label,
          description: node.description,
          sections,
        });
      }
      continue;
    }
    if (node.items) {
      const items = filterItems(node.items, ctx, tenantSlug);
      if (items.length) {
        out.push({
          id: node.id,
          href,
          label: node.label,
          description: node.description,
          items,
        });
      }
      continue;
    }
    // Leaf — no gating in v1 (all direct top-level links are universal).
    out.push({
      id: node.id,
      href,
      label: node.label,
      description: node.description,
    });
  }
  return out;
}

function filterItems(items: LeafSpec[], ctx: NavCtx, tenantSlug: string): NavLeaf[] {
  return items
    .filter((it) => (it.visible ? it.visible(ctx) : true))
    .map((it) => ({
      id: it.id,
      href: `/${tenantSlug}${it.path}`,
      label: it.label,
      description: it.description,
    }));
}

export function findNavNode(tree: NavNode[], id: string): NavNode | undefined {
  return tree.find((n) => n.id === id);
}
