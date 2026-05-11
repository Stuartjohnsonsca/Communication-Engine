export { dispatchNotification } from "./dispatch";
export type { NotificationKind, DispatchInput, DispatchResult } from "./dispatch";
export { sendNotificationEmail, isMailerConfigured } from "./mailer";
export { runWeeklyDigest, isoWeekKey } from "./digest";
export type { DigestRunResult } from "./digest";
export {
  aggregateForMembership,
  digestHasContent,
} from "./aggregate";
export type { MembershipDigest } from "./aggregate";
export { getNavBadges } from "./badges";
export type { NavBadges } from "./badges";
export {
  dispatchSentimentEscalation,
  dispatchAdherenceEscalation,
  dispatchBreachAckRequired,
} from "./immediate";
export {
  OPT_OUTABLE_KINDS,
  isOptOutable,
  getEmailEnabled,
  listPreferences,
  setEmailEnabled,
} from "./preferences";
export type { OptOutableKind } from "./preferences";
