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
  },
};
