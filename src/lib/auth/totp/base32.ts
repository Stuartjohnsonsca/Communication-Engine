/**
 * RFC 4648 base32 (Crockford-style alphabet — actually the RFC 4648 alphabet
 * is what every authenticator app expects in otpauth:// URIs). Padding is
 * never emitted in the encode direction (otpauth URIs are typically
 * stripped of '=' to keep the QR payload small), and accepted-but-ignored
 * on decode. Whitespace and case are also tolerated on decode so a User
 * can paste their secret in any reasonable shape.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return out;
}

export function base32Decode(s: string): Uint8Array {
  const clean = s.replace(/\s+/g, "").replace(/=+$/g, "").toUpperCase();
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`base32: bad character ${JSON.stringify(ch)}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}
