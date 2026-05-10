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
};
