/**
 * Verify a tenant's audit chain offline by re-walking the hash chain over
 * an exported NDJSON file. Used when reviewing a downloaded audit export.
 *
 * Usage:
 *   tsx scripts/verify-audit-chain.ts <tenantId> path/to/audit-export.ndjson
 */
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const SEED = process.env.AUDIT_HASH_SEED ?? "acumon-genesis-2026";

function sha256(s: string) {
  return createHash("sha256").update(s).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

async function main() {
  const [, , tenantId, path] = process.argv;
  if (!tenantId || !path) {
    console.error("Usage: tsx scripts/verify-audit-chain.ts <tenantId> <path>");
    process.exit(2);
  }

  const text = await readFile(path, "utf8");
  let prev = sha256(`${SEED}|${tenantId}|genesis`);
  let n = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const e = JSON.parse(line);
    if (e.tenantId !== tenantId) {
      console.error(`tenantId mismatch on event #${e.seq}`);
      process.exit(1);
    }
    if (e.prevHash !== prev) {
      console.error(`prevHash mismatch at seq ${e.seq}`);
      process.exit(1);
    }
    const expected = sha256([prev, tenantId, e.seq, e.eventType, e.createdAt, canonicalJson(e.payload)].join("\n"));
    if (expected !== e.hash) {
      console.error(`hash mismatch at seq ${e.seq}`);
      process.exit(1);
    }
    prev = e.hash;
    n++;
  }
  console.log(`OK — verified ${n} events.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
