/**
 * Backlog item 10 — UI internationalisation.
 *
 * en-GB is the canonical dictionary. Other locales must export an object of
 * the same shape (TypeScript enforces this via the `Dictionary` type that
 * derives its keys from this file). Missing keys at runtime fall back to the
 * en-GB value via `getT`.
 *
 * Scope is the persistent navigation chrome and a few headline messages —
 * not the entire product. The PRD §13.5 commitment is "interface language
 * support shipping with en-GB plus one more as proof"; further surfaces are
 * additive once a Client requests them. Strings are organised by the screen
 * or component they belong to so a translator can work top-down without
 * needing the React tree.
 */
export const enGB: Dictionary = {
  locale: "en-GB",
  nav: {
    dashboard: "Dashboard",
    notifications: "Notifications",
    fcg: "Firm Culture Guide",
    ucg: "My Culture Guide",
    drafts: "Drafts",
    actions: "Actions",
    meetings: "Meetings",
    opportunities: "Opportunities",
    sentiment: "Sentiment",
    adherence: "Adherence",
    adherenceEscalations: "Adherence escalations",
    dpia: "DPIA",
    processingMap: "Controller / Processor",
    transfers: "Cross-border transfer",
    breaches: "Breach notifications",
    dsar: "DSAR",
    roadmap: "Roadmap",
    risks: "Risks",
    switching: "Switching posture",
    integrations: "Integrations",
    sla: "Service levels",
    accessibility: "Accessibility",
    languages: "Languages",
    account: "My account",
    firmAdherence: "Firm adherence",
    auditLog: "Audit log",
    members: "Members",
    lifecycle: "Lifecycle",
    channels: "Channels",
    ucgConflicts: "UCG conflicts",
    salesIdentifier: "Sales Identifier",
    billing: "Billing",
    sandbox: "Sandbox",
    onboarding: "Onboarding",
    termination: "Termination",
    terms: "Terms",
    xcl: "Cross-Client Learning",
    signoff: "Sign-off questions",
  },
  shell: {
    openNavigation: "Open navigation",
    closeNavigation: "Close navigation",
    openSearch: "Open search",
    searchLabel: "Search",
    searchPlaceholder: "Search drafts, actions, meetings, members…",
    searchEmptyHint:
      "Type at least two characters. Tenant-scoped — only results you have permission to see appear.",
    searchNoMatches: "No matches.",
    searchKeyHint: "↑ ↓ to navigate · Enter to open · Esc to close",
    signOut: "Sign out",
  },
  dpia: {
    label: "DPIA",
    open: "Open DPIA →",
  },
  account: {
    localeHeading: "Interface language",
    localeDescription:
      "The language the platform chrome (navigation, banners, dialogs) is rendered in. " +
      "Drafted communications use the language of the conversation, regardless of this setting.",
    inheritFromTenant: "Inherit from tenant default ({locale})",
    save: "Save preference",
    saved: "Preference saved.",
  },
};

/**
 * Dictionary shape — every string is just `string` so other locales can
 * hold different translations. The literal-keyed structure (nav, shell,
 * dpia, account) is what TypeScript enforces; values are free.
 */
export type Dictionary = {
  locale: string;
  nav: {
    dashboard: string;
    notifications: string;
    fcg: string;
    ucg: string;
    drafts: string;
    actions: string;
    meetings: string;
    opportunities: string;
    sentiment: string;
    adherence: string;
    adherenceEscalations: string;
    dpia: string;
    processingMap: string;
    transfers: string;
    breaches: string;
    dsar: string;
    roadmap: string;
    risks: string;
    switching: string;
    integrations: string;
    sla: string;
    accessibility: string;
    languages: string;
    account: string;
    firmAdherence: string;
    auditLog: string;
    members: string;
    lifecycle: string;
    channels: string;
    ucgConflicts: string;
    salesIdentifier: string;
    billing: string;
    sandbox: string;
    onboarding: string;
    termination: string;
    terms: string;
    xcl: string;
    signoff: string;
  };
  shell: {
    openNavigation: string;
    closeNavigation: string;
    openSearch: string;
    searchLabel: string;
    searchPlaceholder: string;
    searchEmptyHint: string;
    searchNoMatches: string;
    searchKeyHint: string;
    signOut: string;
  };
  dpia: {
    label: string;
    open: string;
  };
  account: {
    localeHeading: string;
    localeDescription: string;
    inheritFromTenant: string;
    save: string;
    saved: string;
  };
};
