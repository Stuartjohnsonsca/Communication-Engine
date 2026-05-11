# Security policy

Acumon Communications takes security seriously. If you believe you have
found a vulnerability in our service or its source code, this document
explains how to report it.

## Reporting a vulnerability

**Preferred channel:** email **security@acumon.com** with a description
of the issue, the affected URL or endpoint, and reproduction steps.

If you require encrypted communication, request our PGP key by replying
to the acknowledgement email.

We will acknowledge your report within **two business days** and aim to
provide a substantive response (triage outcome, fix plan, or request for
more information) within **five business days**. Critical issues affecting
production are escalated immediately.

## What we ask of you

- **Give us reasonable time to respond.** We commit to acting promptly; we
  ask that you do not publicly disclose the issue until we have had the
  opportunity to investigate and remediate.
- **Avoid privacy violations.** Do not access, modify, or exfiltrate data
  that does not belong to you. Use a test tenant or your own account.
- **Stay within scope** (see below).
- **No social engineering or physical attacks.** Our staff are not the
  attack surface; the platform is.

## Scope

In scope:

- The deployed Acumon Communications platform at production hostnames
  (operator and any Client tenant).
- The application source in this repository, including platform configuration.
- Authentication, authorisation, multi-tenant isolation (RLS), audit chain
  integrity, sub-processor / data-residency posture, and the public
  `/status` and `/.well-known/security.txt` surfaces.

Out of scope:

- Denial-of-service or volumetric attacks against the production service.
- Findings that require an attacker with physical access to a Client's device.
- Issues already disclosed via the GitHub Security Advisories surface for
  this repository.
- Vulnerabilities in third-party dependencies for which a CVE is already
  public AND a fix is staged via Dependabot — we run a weekly dependency
  audit and your duplicate report will be acknowledged but not separately
  triaged.

## Safe harbour

If you make a good-faith effort to comply with this policy during your
security research, we will:

- Consider your research authorised and not pursue legal action against
  you or report you to law enforcement.
- Work with you to understand and remediate the issue quickly.
- Recognise your contribution publicly (with your consent) once the issue
  is fixed.

If in doubt, ask before testing.

## Coordinated disclosure

We follow the **90-day** coordinated disclosure standard. If we have not
remediated a confirmed vulnerability within 90 days of your report, you
are free to disclose publicly. We will work with you in good faith to
meet this timeline.

## What you can expect from us

- An acknowledgement of your report within 2 business days.
- Regular status updates until the issue is resolved.
- Credit in our disclosure log (with your consent) on resolution.
- A note in the audit chain of every affected Client tenant indicating
  that a security incident was investigated, per our breach-notification
  obligations (PRD §12.9).

## Machine-readable disclosure

A machine-readable `security.txt` (RFC 9116) is published at:

    https://<operator-host>/.well-known/security.txt

The `Contact:` field there mirrors this document; the `Policy:` field
links back here.
