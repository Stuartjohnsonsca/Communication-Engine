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
    sensitivity: "Alert sensitivity",
    oauthApps: "OAuth provider apps",
    imapServers: "IMAP servers",
    apiKeys: "API keys",
    systemHealth: "System health",
    usage: "LLM usage",
    draftOutcomes: "Draft outcomes",
    help: "Help & guide",
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
    notificationPrefsHeading: "Email preferences",
    notificationPrefsDescription:
      "Choose which notification emails you want to receive. Items in your in-app inbox at /notifications are unaffected — only the email side is muted.",
    notificationPrefsAlwaysSentHeading: "Always sent",
    notificationPrefsAlwaysSentDescription:
      "These notifications carry governance or security obligations and cannot be muted.",
    notificationPrefsToggleEnable: "Email me",
    notificationPrefsToggleDisable: "Don't email me",
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
    stepUpHeading: "Confirm with your authenticator",
    stepUpDescription:
      "This action requires a fresh second-factor confirmation. Enter the current code from your authenticator app to proceed.",
    regenerateButton: "Regenerate recovery codes",
    regenerateDescription:
      "Issue a fresh set of single-use recovery codes. Your existing codes will be invalidated. Two-factor authentication stays enabled; the prior set is replaced atomically. Enter a current authenticator code to confirm device possession.",
    regenerateHeading: "Regenerate recovery codes",
    regenerateSuccess:
      "New recovery codes generated. Save them now — your previous codes no longer work.",
    regenerateFailed: "That code didn't match. Try the next one your authenticator displays.",
  },
  sessions: {
    heading: "Active sessions",
    description:
      "Every device currently signed in to your account. Revoke any session you don't recognise; revoking signs that device out on its next request. Your current device cannot revoke itself — sign out instead.",
    none: "No active sessions.",
    thisDevice: "This device",
    twofaVerified: "2FA verified",
    newDevice: "New device",
    newDeviceDescription:
      "This sign-in came from a device or network you haven't used before. You should have received an email at the time. If it wasn't you, revoke the session immediately and contact your Firm Administrator.",
    signedIn: "Signed in",
    lastSeen: "Last seen",
    revoke: "Revoke",
    revokeOthers: "Sign out all other devices",
  },
  notifications: {
    mutedByPreference: "muted by your preference",
    kinds: {
      weeklyDigestLabel: "Weekly digest",
      weeklyDigestDescription:
        "Monday summary of what's outstanding for you: open actions, FCG proposals to vote on, escalations and approaching expiries.",
      signInNewDeviceLabel: "New device sign-in",
      signInNewDeviceDescription:
        "Sent when you sign in from a device or network you haven't used before. Useful as a tripwire for account takeover; you can mute it if it's noisy.",
      sentimentEscalationLabel: "Sentiment escalations",
      sentimentEscalationAlways: "Routes through Firm Culture Team governance.",
      adherenceEscalationLabel: "Adherence escalations",
      adherenceEscalationAlways: "Audit-grade record of your own send-side compliance.",
      breachAckRequiredLabel: "Breach acknowledgement",
      breachAckRequiredAlways: "DPA art. 33–34 obligation for Firm Administrators.",
      auditChainTamperedLabel: "Audit chain integrity",
      auditChainTamperedAlways: "Critical security alert — chain integrity is a controllership concern.",
      cronStalledLabel: "Platform cron stalled",
      cronStalledAlways: "Operator-only alert; missing it defeats the cron.",
      subprocessorChangeLabel: "Sub-processor changes",
      subprocessorChangeAlways: "DPA art. 28(2)(a) prior-notice obligation.",
      totpResetByAdminLabel: "Two-factor reset by admin",
      totpResetByAdminAlways: "Security advisory — never muted.",
    },
  },
  audit: {
    heading: "Audit log",
    description:
      "Append-only, hash-chained per tenant. Every privileged action lands here. Filter by event, actor, subject, or date range; expand a row to see the full payload. Use Verify chain to confirm cryptographic integrity from genesis.",
    exportButton: "Export NDJSON",
    exportCsvButton: "Export CSV",
    filterEvent: "Event type",
    filterEventAny: "Any event",
    filterActor: "Actor",
    filterSubjectType: "Subject type",
    filterSubjectId: "Subject id",
    filterSince: "From",
    filterUntil: "To",
    filterPageSize: "Page size",
    applyFilters: "Apply",
    resetFilters: "Reset",
    actorNotFound: "No member matched — filter applied as no-match.",
    colWhen: "When",
    colEvent: "Event",
    colSubject: "Subject",
    colActor: "Actor",
    colHash: "Hash",
    colDetails: "Details",
    empty: "No events match these filters.",
    showingCount: "Showing {shown} events (seq {from} → {to}).",
    firstPage: "← First page",
    olderPage: "Older →",
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
    sensitivity: string;
    oauthApps: string;
    imapServers: string;
    apiKeys: string;
    systemHealth: string;
    usage: string;
    draftOutcomes: string;
    help: string;
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
    notificationPrefsHeading: string;
    notificationPrefsDescription: string;
    notificationPrefsAlwaysSentHeading: string;
    notificationPrefsAlwaysSentDescription: string;
    notificationPrefsToggleEnable: string;
    notificationPrefsToggleDisable: string;
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
    stepUpHeading: string;
    stepUpDescription: string;
    regenerateButton: string;
    regenerateDescription: string;
    regenerateHeading: string;
    regenerateSuccess: string;
    regenerateFailed: string;
  };
  sessions: {
    heading: string;
    description: string;
    none: string;
    thisDevice: string;
    twofaVerified: string;
    newDevice: string;
    newDeviceDescription: string;
    signedIn: string;
    lastSeen: string;
    revoke: string;
    revokeOthers: string;
  };
  notifications: {
    mutedByPreference: string;
    kinds: {
      weeklyDigestLabel: string;
      weeklyDigestDescription: string;
      signInNewDeviceLabel: string;
      signInNewDeviceDescription: string;
      sentimentEscalationLabel: string;
      sentimentEscalationAlways: string;
      adherenceEscalationLabel: string;
      adherenceEscalationAlways: string;
      breachAckRequiredLabel: string;
      breachAckRequiredAlways: string;
      auditChainTamperedLabel: string;
      auditChainTamperedAlways: string;
      cronStalledLabel: string;
      cronStalledAlways: string;
      subprocessorChangeLabel: string;
      subprocessorChangeAlways: string;
      totpResetByAdminLabel: string;
      totpResetByAdminAlways: string;
    };
  };
  audit: {
    heading: string;
    description: string;
    exportButton: string;
    exportCsvButton: string;
    filterEvent: string;
    filterEventAny: string;
    filterActor: string;
    filterSubjectType: string;
    filterSubjectId: string;
    filterSince: string;
    filterUntil: string;
    filterPageSize: string;
    applyFilters: string;
    resetFilters: string;
    actorNotFound: string;
    colWhen: string;
    colEvent: string;
    colSubject: string;
    colActor: string;
    colHash: string;
    colDetails: string;
    empty: string;
    showingCount: string;
    firstPage: string;
    olderPage: string;
  };
};
