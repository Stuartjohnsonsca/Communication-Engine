/**
 * RFC 9116 "A File Format to Aid in Security Vulnerability Disclosure"
 * (security.txt) builder + parser.
 *
 * The format is a plain-text file with `Field-Name: value` lines, blank
 * line(s) and `#`-prefixed comments permitted. Field names are
 * case-insensitive; values are line-terminated; multi-value fields are
 * encoded as multiple lines with the same name.
 *
 * Hard requirements per spec:
 *   - At least one `Contact:` line is REQUIRED (Section 2.5.4).
 *   - Exactly one `Expires:` line is REQUIRED, ISO 8601 UTC, must be in
 *     the future and SHOULD be less than a year out (Section 2.5.5).
 *   - `Canonical:` SHOULD be present so receivers can verify they reached
 *     the canonical URL.
 *
 * We render the file dynamically from a route handler so `Expires:` stays
 * fresh without a CI cron rotating a static asset.
 */

const MAX_FUTURE_DAYS = 364; // RFC: less than a year. 364 gives margin.
const DEFAULT_FUTURE_DAYS = 350; // ~11 months — comfortably under the cap.

export type SecurityTxtOptions = {
  /** Required: at least one contact target. mailto:, https:, or tel:. */
  contacts: string[];
  /** Optional: signed-PGP key URL. */
  encryption?: string | null;
  /** Optional: vulnerability-acknowledgements URL. */
  acknowledgments?: string | null;
  /** Optional: human-readable disclosure policy URL. */
  policy?: string | null;
  /** Optional: hiring page (RFC 9116 includes this — defenders welcome). */
  hiring?: string | null;
  /** Optional: BCP-47 preferred languages (e.g. ["en"], ["en", "fr"]). */
  preferredLanguages?: string[];
  /**
   * Optional: list of canonical URLs at which this file is published.
   * Receivers compare against the URL they fetched to detect spoofing.
   */
  canonical: string[];
  /**
   * Optional: expiry timestamp. Defaults to `now + DEFAULT_FUTURE_DAYS`.
   * Must be in the future and within RFC's 1-year ceiling.
   */
  expiresAt?: Date;
  /** Injectable "now" for deterministic tests. */
  now?: Date;
};

export class SecurityTxtValidationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "SecurityTxtValidationError";
  }
}

const MAILTO = /^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/i;
const TEL = /^tel:[+0-9()\- ]+$/i;

function validContactTarget(s: string): boolean {
  if (MAILTO.test(s) || TEL.test(s)) return true;
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

function validUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

function isoMaybeMs(d: Date): string {
  // ISO 8601 in UTC, second precision — RFC 9116 examples use second.
  return new Date(Math.floor(d.getTime() / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function validBcp47(s: string): boolean {
  // Permissive: ALPHA{2,3}(-ALPHA{2,8})*  — good enough for declaring
  // "en" / "en-GB" / "fr"; not exhaustive.
  return /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(s);
}

export function buildSecurityTxt(opts: SecurityTxtOptions): string {
  const now = opts.now ?? new Date();
  if (!opts.contacts.length) {
    throw new SecurityTxtValidationError(
      "contact-required",
      "RFC 9116 §2.5.4: at least one Contact: line is required",
    );
  }
  for (const c of opts.contacts) {
    if (!validContactTarget(c)) {
      throw new SecurityTxtValidationError(
        "contact-invalid",
        `RFC 9116 §2.5.4: Contact value "${c}" must be mailto:, tel:, http(s)://`,
      );
    }
  }

  const expiresAt =
    opts.expiresAt ?? new Date(now.getTime() + DEFAULT_FUTURE_DAYS * 24 * 60 * 60 * 1000);
  if (expiresAt.getTime() <= now.getTime()) {
    throw new SecurityTxtValidationError(
      "expires-not-future",
      "RFC 9116 §2.5.5: Expires must be in the future",
    );
  }
  const maxFuture = now.getTime() + MAX_FUTURE_DAYS * 24 * 60 * 60 * 1000;
  if (expiresAt.getTime() > maxFuture) {
    throw new SecurityTxtValidationError(
      "expires-too-far",
      `RFC 9116 §2.5.5: Expires must be < 1 year (max ${MAX_FUTURE_DAYS} days)`,
    );
  }

  for (const c of opts.canonical) {
    if (!validUrl(c)) {
      throw new SecurityTxtValidationError(
        "canonical-invalid",
        `Canonical must be a valid URL: ${c}`,
      );
    }
  }
  if (opts.encryption && !validUrl(opts.encryption)) {
    throw new SecurityTxtValidationError("encryption-invalid", "Encryption must be a URL");
  }
  if (opts.acknowledgments && !validUrl(opts.acknowledgments)) {
    throw new SecurityTxtValidationError(
      "acknowledgments-invalid",
      "Acknowledgments must be a URL",
    );
  }
  if (opts.policy && !validUrl(opts.policy)) {
    throw new SecurityTxtValidationError("policy-invalid", "Policy must be a URL");
  }
  if (opts.hiring && !validUrl(opts.hiring)) {
    throw new SecurityTxtValidationError("hiring-invalid", "Hiring must be a URL");
  }
  for (const l of opts.preferredLanguages ?? []) {
    if (!validBcp47(l)) {
      throw new SecurityTxtValidationError(
        "preferred-languages-invalid",
        `Preferred-Languages tag "${l}" is not a valid BCP-47 code`,
      );
    }
  }

  const lines: string[] = [];
  // Leading comment for human readers who follow the URL out of curiosity.
  lines.push("# Acumon Communications — security disclosure (RFC 9116).");
  lines.push("# See SECURITY.md in the repository for the full policy.");
  lines.push("");
  for (const c of opts.contacts) lines.push(`Contact: ${c}`);
  lines.push(`Expires: ${isoMaybeMs(expiresAt)}`);
  if (opts.preferredLanguages && opts.preferredLanguages.length > 0) {
    lines.push(`Preferred-Languages: ${opts.preferredLanguages.join(", ")}`);
  }
  for (const url of opts.canonical) lines.push(`Canonical: ${url}`);
  if (opts.encryption) lines.push(`Encryption: ${opts.encryption}`);
  if (opts.acknowledgments) lines.push(`Acknowledgments: ${opts.acknowledgments}`);
  if (opts.policy) lines.push(`Policy: ${opts.policy}`);
  if (opts.hiring) lines.push(`Hiring: ${opts.hiring}`);
  lines.push("");
  return lines.join("\n");
}

// ─── Parser (used by tests + by /api/security-txt's self-validation) ─────

export type ParsedSecurityTxt = {
  contacts: string[];
  expires: Date | null;
  canonical: string[];
  preferredLanguages: string[];
  encryption: string | null;
  acknowledgments: string | null;
  policy: string | null;
  hiring: string | null;
  /** Field names found that aren't recognised — kept for diagnostic. */
  unknown: Array<{ name: string; value: string }>;
};

export function parseSecurityTxt(text: string): ParsedSecurityTxt {
  const out: ParsedSecurityTxt = {
    contacts: [],
    expires: null,
    canonical: [],
    preferredLanguages: [],
    encryption: null,
    acknowledgments: null,
    policy: null,
    hiring: null,
    unknown: [],
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const sep = line.indexOf(":");
    if (sep < 0) continue;
    const name = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();
    if (!value) continue;
    switch (name) {
      case "contact":
        out.contacts.push(value);
        break;
      case "expires": {
        const d = new Date(value);
        if (!Number.isNaN(d.getTime())) out.expires = d;
        break;
      }
      case "canonical":
        out.canonical.push(value);
        break;
      case "preferred-languages":
        out.preferredLanguages = value.split(/\s*,\s*/).filter(Boolean);
        break;
      case "encryption":
        out.encryption = value;
        break;
      case "acknowledgments":
      case "acknowledgements":
        out.acknowledgments = value;
        break;
      case "policy":
        out.policy = value;
        break;
      case "hiring":
        out.hiring = value;
        break;
      default:
        out.unknown.push({ name, value });
    }
  }
  return out;
}

// ─── Defaults from env ────────────────────────────────────────────────────

export type DisclosureEnv = {
  contactEmail: string;
  policyUrl: string;
  acknowledgmentsUrl: string | null;
  preferredLanguages: string[];
};

export function disclosureFromEnv(env: NodeJS.ProcessEnv = process.env): DisclosureEnv {
  return {
    contactEmail: env.SECURITY_CONTACT_EMAIL?.trim() || "security@acumon.com",
    policyUrl:
      env.SECURITY_POLICY_URL?.trim() ||
      "https://github.com/Stuartjohnsonsca/Communication-Engine/blob/main/SECURITY.md",
    acknowledgmentsUrl: env.SECURITY_ACKNOWLEDGMENTS_URL?.trim() || null,
    preferredLanguages: (env.SECURITY_PREFERRED_LANGUAGES?.split(",") ?? ["en"])
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

/**
 * Build the security.txt body for a request that arrived at `requestUrl`.
 * The Canonical: field is derived from the request URL so a deployment
 * behind multiple hostnames still reports the URL the receiver fetched.
 */
export function buildForRequest(
  requestUrl: URL,
  env: DisclosureEnv = disclosureFromEnv(),
  now: Date = new Date(),
): string {
  // Always include the /.well-known/security.txt canonical, NOT the
  // /api/security-txt rewrite target — the public-facing URL is what
  // matters per RFC.
  const origin = `${requestUrl.protocol}//${requestUrl.host}`;
  const canonical = [`${origin}/.well-known/security.txt`];
  return buildSecurityTxt({
    contacts: [`mailto:${env.contactEmail}`],
    expiresAt: new Date(now.getTime() + DEFAULT_FUTURE_DAYS * 24 * 60 * 60 * 1000),
    preferredLanguages: env.preferredLanguages,
    canonical,
    policy: env.policyUrl,
    acknowledgments: env.acknowledgmentsUrl,
    now,
  });
}
