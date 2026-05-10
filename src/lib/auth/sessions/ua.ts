export type DeviceSummary = {
  browser: string;
  os: string;
  /** Best-effort short label: "Chrome on macOS", "Safari on iOS", "Unknown". */
  label: string;
};

/**
 * Tiny User-Agent classifier — deliberately not `ua-parser-js`. Detects the
 * common browsers and operating systems we expect in a B2B SaaS audit log;
 * everything else falls back to "Other" / "Unknown" so the UI can still
 * render the row.
 *
 * Order matters: Edge advertises itself as Chrome, Chrome as Safari, Opera
 * as Chrome — so we check the most specific token first.
 */
export function describeUserAgent(ua: string | null | undefined): DeviceSummary {
  if (!ua) return { browser: "Unknown", os: "Unknown", label: "Unknown device" };
  const browser = detectBrowser(ua);
  const os = detectOs(ua);
  const label = browser === "Unknown" && os === "Unknown" ? truncate(ua, 64) : `${browser} on ${os}`;
  return { browser, os, label };
}

function detectBrowser(ua: string): string {
  if (/Edg\//i.test(ua)) return "Edge";
  if (/OPR\//i.test(ua) || /Opera\//i.test(ua)) return "Opera";
  if (/Firefox\//i.test(ua)) return "Firefox";
  if (/Chrome\//i.test(ua) && !/Chromium\//i.test(ua)) return "Chrome";
  if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) return "Safari";
  if (/PostmanRuntime/i.test(ua)) return "Postman";
  if (/curl\//i.test(ua)) return "curl";
  if (/node-fetch/i.test(ua)) return "node-fetch";
  return "Unknown";
}

function detectOs(ua: string): string {
  if (/iPhone|iPad|iPod/i.test(ua)) return "iOS";
  if (/Android/i.test(ua)) return "Android";
  if (/Mac OS X|Macintosh/i.test(ua)) return "macOS";
  if (/Windows NT/i.test(ua)) return "Windows";
  if (/CrOS/i.test(ua)) return "ChromeOS";
  if (/Linux/i.test(ua)) return "Linux";
  return "Unknown";
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
