import type { Dictionary } from "./en-GB";

/**
 * French — second seed locale per backlog item 10. Strings translated by the
 * implementing engineer; a Client-facing review is the runbook for an actual
 * GA-quality French rollout.
 *
 * The shape is enforced against `Dictionary` (en-GB) at compile time, so
 * adding a key in en-GB without adding it here is a build error — preferred
 * over silent fallback for translator visibility. Fallback to en-GB still
 * exists at runtime for any optional/dynamic key that may slip in.
 */
export const fr: Dictionary = {
  locale: "fr",
  nav: {
    dashboard: "Tableau de bord",
    notifications: "Notifications",
    fcg: "Guide de Culture du Cabinet",
    ucg: "Mon Guide de Culture",
    drafts: "Brouillons",
    actions: "Actions",
    meetings: "Réunions",
    opportunities: "Opportunités",
    sentiment: "Sentiment",
    adherence: "Conformité",
    adherenceEscalations: "Escalades de conformité",
    dpia: "AIPD",
    processingMap: "Responsable / Sous-traitant",
    transfers: "Transfert transfrontalier",
    breaches: "Notifications de violation",
    dsar: "Demande de droit d'accès",
    roadmap: "Feuille de route",
    risks: "Risques",
    switching: "Posture de réversibilité",
    integrations: "Intégrations",
    sla: "Niveaux de service",
    accessibility: "Accessibilité",
    languages: "Langues",
    account: "Mon compte",
    firmAdherence: "Conformité du cabinet",
    auditLog: "Journal d'audit",
    members: "Membres",
    lifecycle: "Cycle de vie",
    channels: "Canaux",
    ucgConflicts: "Conflits GCU",
    salesIdentifier: "Identificateur commercial",
    billing: "Facturation",
    sandbox: "Bac à sable",
    onboarding: "Intégration",
    termination: "Résiliation",
    terms: "Conditions",
    xcl: "Apprentissage inter-clients",
    signoff: "Questions de validation",
    security: "Sécurité",
    webhooks: "Webhooks",
    sensitivity: "Sensibilité des alertes",
    apiKeys: "Clés d'API",
    systemHealth: "Santé système",
    usage: "Usage LLM",
    draftOutcomes: "Résultats des brouillons",
    help: "Aide & guide",
  },
  shell: {
    openNavigation: "Ouvrir la navigation",
    closeNavigation: "Fermer la navigation",
    openSearch: "Ouvrir la recherche",
    searchLabel: "Recherche",
    searchPlaceholder: "Rechercher brouillons, actions, réunions, membres…",
    searchEmptyHint:
      "Saisissez au moins deux caractères. Limité au tenant — seuls les résultats que vous êtes autorisé à voir apparaissent.",
    searchNoMatches: "Aucun résultat.",
    searchKeyHint: "↑ ↓ pour naviguer · Entrée pour ouvrir · Échap pour fermer",
    signOut: "Se déconnecter",
  },
  dpia: {
    label: "AIPD",
    open: "Ouvrir l'AIPD →",
  },
  account: {
    localeHeading: "Langue de l'interface",
    localeDescription:
      "Langue dans laquelle l'interface de la plateforme (navigation, bannières, dialogues) est rendue. " +
      "Les communications rédigées utilisent la langue de la conversation, indépendamment de ce paramètre.",
    inheritFromTenant: "Hériter du paramètre par défaut du tenant ({locale})",
    save: "Enregistrer la préférence",
    saved: "Préférence enregistrée.",
    notificationPrefsHeading: "Préférences d'e-mail",
    notificationPrefsDescription:
      "Choisissez quels e-mails de notification vous souhaitez recevoir. Les éléments de votre boîte de réception in-app à /notifications ne sont pas affectés — seul l'envoi par e-mail est désactivé.",
    notificationPrefsAlwaysSentHeading: "Toujours envoyés",
    notificationPrefsAlwaysSentDescription:
      "Ces notifications relèvent d'obligations de gouvernance ou de sécurité et ne peuvent pas être désactivées.",
    notificationPrefsToggleEnable: "M'envoyer un e-mail",
    notificationPrefsToggleDisable: "Ne pas m'envoyer d'e-mail",
  },
  twofa: {
    accountHeading: "Authentification à deux facteurs",
    enrolledDescription:
      "L'authentification à deux facteurs est activée. Un code de l'application d'authentification vous sera demandé après chaque connexion.",
    notEnrolledDescription:
      "Ajoutez un second facteur à votre compte. Utilisez n'importe quelle application TOTP — Google Authenticator, Authy, 1Password, Bitwarden, Microsoft Authenticator. Une fois activée, un code à 6 chiffres vous sera demandé à chaque connexion.",
    enforcedNote:
      "Votre Administrateur du cabinet exige l'authentification à deux facteurs pour ce tenant. Inscrivez-vous pour continuer.",
    enrolledOn: "Activée le",
    lastUsed: "Dernière utilisation",
    recoveryRemaining: "Codes de récupération restants",
    enableButton: "Activer l'authentification à deux facteurs",
    disableButton: "Désactiver l'authentification à deux facteurs",
    cancel: "Annuler",
    secretLabel: "Secret (à saisir dans l'application d'authentification)",
    otpauthLabel: "Afficher l'URI otpauth (pour l'import par QR)",
    enterCodeLabel: "Code d'authentification",
    submitCode: "Confirmer",
    recoveryHeading: "L'authentification à deux facteurs est maintenant active.",
    recoveryWarning:
      "Conservez ces codes de récupération en lieu sûr. Chacun peut être utilisé une seule fois pour vous connecter si vous perdez l'accès à votre application d'authentification. Ils ne seront plus affichés.",
    enrollFailed:
      "Ce code ne correspond pas. Essayez le suivant affiché par votre application d'authentification.",
    disableConfirm:
      "Saisissez votre code d'authentification actuel ou un code de récupération pour confirmer la désactivation de l'authentification à deux facteurs.",
    disableFailed: "Ce code ne correspond pas. Réessayez.",
    never: "jamais",
    challengeHeading: "Vérification d'identité",
    challengeDescription:
      "Saisissez le code à 6 chiffres affiché par votre application d'authentification pour continuer. Si vous avez perdu l'accès à votre application, vous pouvez saisir un code de récupération à la place.",
    challengeHelp: "Code à 6 chiffres de votre application d'authentification, ou code de récupération.",
    continueButton: "Continuer",
    badCodeError:
      "Ce code ne correspond pas. Essayez le suivant affiché par votre application d'authentification.",
    rateLimitedError: "Trop de tentatives. Réessayez dans un instant.",
    stepUpHeading: "Confirmer avec votre authentificateur",
    stepUpDescription:
      "Cette action nécessite une nouvelle confirmation à deux facteurs. Saisissez le code actuel de votre application d'authentification pour continuer.",
    regenerateButton: "Régénérer les codes de récupération",
    regenerateDescription:
      "Émet une nouvelle série de codes de récupération à usage unique. Vos codes existants seront invalidés. L'authentification à deux facteurs reste activée ; l'ancien ensemble est remplacé de manière atomique. Saisissez un code d'authentification actuel pour confirmer la possession de l'appareil.",
    regenerateHeading: "Régénérer les codes de récupération",
    regenerateSuccess:
      "Nouveaux codes de récupération générés. Conservez-les dès maintenant — vos anciens codes ne fonctionnent plus.",
    regenerateFailed:
      "Ce code ne correspond pas. Essayez le suivant affiché par votre application d'authentification.",
  },
  sessions: {
    heading: "Sessions actives",
    description:
      "Chaque appareil actuellement connecté à votre compte. Révoquez toute session que vous ne reconnaissez pas ; la révocation déconnecte cet appareil à sa prochaine requête. Votre appareil actuel ne peut pas se révoquer lui-même — utilisez plutôt la déconnexion.",
    none: "Aucune session active.",
    thisDevice: "Cet appareil",
    twofaVerified: "2FA vérifié",
    newDevice: "Nouvel appareil",
    newDeviceDescription:
      "Cette connexion provient d'un appareil ou d'un réseau que vous n'avez pas utilisé auparavant. Vous devriez avoir reçu un courriel à ce moment-là. Si ce n'était pas vous, révoquez immédiatement la session et contactez votre Administrateur du cabinet.",
    signedIn: "Connecté le",
    lastSeen: "Vu pour la dernière fois",
    revoke: "Révoquer",
    revokeOthers: "Déconnecter tous les autres appareils",
  },
  notifications: {
    mutedByPreference: "désactivée selon votre préférence",
    kinds: {
      weeklyDigestLabel: "Digest hebdomadaire",
      weeklyDigestDescription:
        "Récapitulatif du lundi sur ce qui vous reste à traiter : actions ouvertes, propositions GCC à voter, escalades et échéances proches.",
      signInNewDeviceLabel: "Connexion depuis un nouvel appareil",
      signInNewDeviceDescription:
        "Envoyée lorsque vous vous connectez depuis un appareil ou un réseau inhabituel. Utile comme garde-fou contre la prise de contrôle de compte ; à désactiver si trop bruyante.",
      sentimentEscalationLabel: "Escalades de sentiment",
      sentimentEscalationAlways:
        "Transite par la gouvernance de l'équipe Culture du cabinet.",
      adherenceEscalationLabel: "Escalades de conformité",
      adherenceEscalationAlways:
        "Enregistrement de niveau audit de votre conformité côté envoi.",
      breachAckRequiredLabel: "Accusé de réception de violation",
      breachAckRequiredAlways:
        "Obligation DPA art. 33–34 pour les Administrateurs du cabinet.",
      auditChainTamperedLabel: "Intégrité de la chaîne d'audit",
      auditChainTamperedAlways:
        "Alerte de sécurité critique — l'intégrité de la chaîne relève du responsable de traitement.",
      cronStalledLabel: "Tâche planifiée bloquée",
      cronStalledAlways:
        "Alerte opérateur uniquement ; la manquer revient à annuler la tâche.",
      subprocessorChangeLabel: "Changements de sous-traitants",
      subprocessorChangeAlways:
        "Obligation de préavis DPA art. 28(2)(a).",
      totpResetByAdminLabel: "Réinitialisation 2FA par l'administrateur",
      totpResetByAdminAlways: "Avis de sécurité — jamais désactivable.",
    },
  },
  audit: {
    heading: "Journal d'audit",
    description:
      "Append-only, chaîné par hachage par tenant. Chaque action privilégiée est consignée ici. Filtrez par événement, acteur, sujet ou plage de dates ; développez une ligne pour voir la charge utile complète. Utilisez Vérifier la chaîne pour confirmer l'intégrité cryptographique depuis l'origine.",
    exportButton: "Exporter NDJSON",
    exportCsvButton: "Exporter CSV",
    filterEvent: "Type d'événement",
    filterEventAny: "Tous les événements",
    filterActor: "Acteur",
    filterSubjectType: "Type de sujet",
    filterSubjectId: "Id du sujet",
    filterSince: "Du",
    filterUntil: "Au",
    filterPageSize: "Taille de page",
    applyFilters: "Appliquer",
    resetFilters: "Réinitialiser",
    actorNotFound:
      "Aucun membre ne correspond — le filtre est appliqué sans correspondance.",
    colWhen: "Quand",
    colEvent: "Événement",
    colSubject: "Sujet",
    colActor: "Acteur",
    colHash: "Hachage",
    colDetails: "Détails",
    empty: "Aucun événement ne correspond à ces filtres.",
    showingCount: "Affichage de {shown} événements (seq {from} → {to}).",
    firstPage: "← Première page",
    olderPage: "Plus ancien →",
  },
};
