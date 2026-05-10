/**
 * Resolve the client IP from request headers. Same precedence as the
 * rate-limiter's `clientIpFromHeaders` but exported here so the session
 * touch path doesn't drag the ratelimit module's public surface around;
 * keeping a parallel small helper is cheaper than refactoring the audit
 * surface of an already-shipped item.
 *
 * Precedence: first hop of X-Forwarded-For → X-Real-IP → CF-Connecting-IP
 * → Fly-Client-IP → X-Vercel-Forwarded-For → null.
 */
export function ipFromHeaders(headers: Headers | Record<string, string | undefined>): string | null {
  const get = (name: string): string | undefined => {
    if (headers instanceof Headers) return headers.get(name) ?? undefined;
    const lower = name.toLowerCase();
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === lower) return v ?? undefined;
    }
    return undefined;
  };

  const xff = get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return (
    get("x-real-ip") ??
    get("cf-connecting-ip") ??
    get("fly-client-ip") ??
    get("x-vercel-forwarded-for") ??
    null
  );
}

/**
 * Coarse IP mask for UI display. IPv4 → `a.b.c.×`. IPv6 → first 4 hextets
 * + `:…`. Leaves localhost intact for dev clarity. Never used for storage;
 * the row keeps the full IP and admins see the masked form by default with
 * a "Show" affordance.
 */
export function maskIp(ip: string | null | undefined): string {
  if (!ip) return "—";
  if (ip === "127.0.0.1" || ip === "::1" || ip === "localhost" || ip === "unknown") return ip;
  if (ip.includes(":")) {
    const parts = ip.split(":");
    return `${parts.slice(0, 4).join(":")}:…`;
  }
  const v4 = ip.split(".");
  if (v4.length === 4) return `${v4[0]}.${v4[1]}.${v4[2]}.×`;
  return ip;
}
