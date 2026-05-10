import type { NextConfig } from "next";

/**
 * Security headers — applied to every response by Next.js.
 *
 * Notes on choices:
 *  - HSTS: 2-year max-age + includeSubDomains. Production-only because
 *    issuing HSTS over plain HTTP/dev breaks local Safari for that host.
 *  - CSP: `script-src 'self' 'unsafe-inline'`. Next.js App Router inlines
 *    hydration scripts and route data; a strict nonce-based CSP requires
 *    threading a per-request nonce through every layout/page that emits
 *    `<Script>` (and through Tailwind / next/font). Punted as a follow-up;
 *    the rest of the directives are tight.
 *  - `connect-src` includes `https:` so the Anthropic + Together API
 *    fetches from server components/API routes don't cause CSP report
 *    spam during development. Server-side fetches don't go through the
 *    browser's CSP — but anything XHR'd from the client does.
 *  - `frame-ancestors 'none'` is the modern equivalent of X-Frame-Options
 *    DENY; we set both for older browsers.
 *  - `Permissions-Policy` denies browser sensors we never want — camera,
 *    microphone, geolocation, payment, USB. We *do* allow `clipboard-write`
 *    for the "copy draft" UX, restricted to same-origin.
 */
const SECURITY_HEADERS = [
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "img-src 'self' data: https:",
      "font-src 'self' data:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self' 'unsafe-inline'",
      "connect-src 'self' https:",
      "upgrade-insecure-requests",
    ].join("; "),
  },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: [
      "camera=()",
      "microphone=()",
      "geolocation=()",
      "payment=()",
      "usb=()",
      "interest-cohort=()",
      "clipboard-write=(self)",
    ].join(", "),
  },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  ...(process.env.NODE_ENV === "production"
    ? [
        {
          key: "Strict-Transport-Security",
          value: "max-age=63072000; includeSubDomains; preload",
        },
      ]
    : []),
];

const nextConfig: NextConfig = {
  output: "standalone",
  experimental: {
    serverActions: {
      bodySizeLimit: "2mb",
    },
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: false,
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: SECURITY_HEADERS,
      },
    ];
  },
};

export default nextConfig;
