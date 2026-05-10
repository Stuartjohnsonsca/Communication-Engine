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
    security: "Security",
    webhooks: "Webhooks",
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
  twofa: {
    accountHeading: "Two-factor authentication",
    enrolledDescription:
      "Two-factor authentication is enabled. You will be challenged for an authenticator code after every sign-in.",
    notEnrolledDescription:
      "Add a second factor to your account. Use any TOTP authenticator app — Google Authenticator, Authy, 1Password, Bitwarden, Microsoft Authenticator. Once enabled, you will be challenged for a 6-digit code after each sign-in.",
    enforcedNote:
      "Your Firm Administrator requires two-factor authentication for this tenant. Enroll to continue.",
    enrolledOn: "Enrolled",
    lastUsed: "Last used",
    recoveryRemaining: "Recovery codes left",
    enableButton: "Enable two-factor",
    disableButton: "Disable two-factor",
    cancel: "Cancel",
    secretLabel: "Secret (enter into authenticator app)",
    otpauthLabel: "Show otpauth URI (for QR import)",
    enterCodeLabel: "Authenticator code",
    submitCode: "Confirm",
    recoveryHeading: "Two-factor authentication is now active.",
    recoveryWarning:
      "Save these recovery codes somewhere safe. Each can be used once to sign in if you lose access to your authenticator. They will not be shown again.",
    enrollFailed: "That code didn't match. Try the next one your authenticator displays.",
    disableConfirm:
      "Enter your current authenticator code or a recovery code to confirm disabling two-factor authentication.",
    disableFailed: "That code didn't match. Try again.",
    never: "never",
    challengeHeading: "Verify it's you",
    challengeDescription:
      "Enter the 6-digit code from your authenticator app to continue. If you have lost access to your authenticator, you can enter a recovery code instead.",
    challengeHelp: "6-digit code from your authenticator app, or a recovery code.",
    continueButton: "Continue",
    badCodeError: "That code didn't match. Try the next one your authenticator displays.",
    rateLimitedError: "Too many attempts. Try again shortly.",
  },
  sessions: {
    heading: "Active sessions",
    description:
      "Every device currently signed in to your account. Revoke any session you don't recognise; revoking signs that device out on its next request. Your current device cannot revoke itself — sign out instead.",
    none: "No active sessions.",
    thisDevice: "This device",
    twofaVerified: "2FA verified",
    signedIn: "Signed in",
    lastSeen: "Last seen",
    revoke: "Revoke",
    revokeOthers: "Sign out all other devices",
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
    security: string;
    webhooks: string;
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
  twofa: {
    accountHeading: string;
    enrolledDescription: string;
    notEnrolledDescription: string;
    enforcedNote: string;
    enrolledOn: string;
    lastUsed: string;
    recoveryRemaining: string;
    enableButton: string;
    disableButton: string;
    cancel: string;
    secretLabel: string;
    otpauthLabel: string;
    enterCodeLabel: string;
    submitCode: string;
    recoveryHeading: string;
    recoveryWarning: string;
    enrollFailed: string;
    disableConfirm: string;
    disableFailed: string;
    never: string;
    challengeHeading: string;
    challengeDescription: string;
    challengeHelp: string;
    continueButton: string;
    badCodeError: string;
    rateLimitedError: string;
  };
  sessions: {
    heading: string;
    description: string;
    none: string;
    thisDevice: string;
    twofaVerified: string;
    signedIn: string;
    lastSeen: string;
    revoke: string;
    revokeOthers: string;
  };
};
