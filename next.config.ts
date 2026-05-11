import type { NextConfig } from "next";

/**
 * Static security headers — applied to every response by Next.js.
 *
 * The Content-Security-Policy header is NOT here: it's set per-request
 * by `src/middleware.ts` so each response carries a fresh CSP nonce.
 * See `src/lib/security/csp.ts` for the CSP construction.
 *
 * Notes on the rest:
 *  - HSTS: 2-year max-age + includeSubDomains. Production-only because
 *    issuing HSTS over plain HTTP/dev breaks local Safari for that host.
 *  - `Permissions-Policy` denies browser sensors we never want — camera,
 *    microphone, geolocation, payment, USB. We *do* allow `clipboard-write`
 *    for the "copy draft" UX, restricted to same-origin.
 *  - X-Frame-Options DENY duplicates `frame-ancestors 'none'` in the CSP
 *    for older browsers that don't honour CSP frame-ancestors.
 */
const SECURITY_HEADERS = [
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
  // /.well-known/security.txt (RFC 9116) — Next.js App Router doesn't serve
  // dot-prefixed folders as routes, so we rewrite the canonical URL to a
  // dynamic route handler that re-stamps the `Expires:` field within the
  // spec's 1-year ceiling on each render.
  async rewrites() {
    return [
      { source: "/.well-known/security.txt", destination: "/api/security-txt" },
    ];
  },
};

export default nextConfig;
