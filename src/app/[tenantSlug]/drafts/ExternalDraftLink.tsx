"use client";

/**
 * Backlog item 113 — deep-link pill rendered inside the per-draft card
 * on the /drafts list. The card itself is wrapped in a Next `<Link>`
 * to the in-app draft detail page; this anchor stops propagation so
 * clicking "Open in Outlook" goes to the mailbox without also
 * navigating the underlying tab to the in-app draft.
 */
export function ExternalDraftLink({
  href,
  label,
}: {
  href: string;
  label: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="tag bg-sky-100 text-sky-900 hover:bg-sky-200"
    >
      Open in {label} ↗
    </a>
  );
}
