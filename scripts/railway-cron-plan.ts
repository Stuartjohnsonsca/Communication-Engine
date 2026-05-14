/**
 * Reads REGISTERED_CRONS from the codebase and emits a printable table
 * + ready-to-paste curl commands for every cron that needs a Railway
 * service.
 *
 * Why a script and not a static checklist file: REGISTERED_CRONS is the
 * single source of truth for what crons exist (item 86's static guard
 * keeps it honest). Hardcoding a checklist would rot the moment someone
 * adds a new cron. This script regenerates the list from the live
 * registry every time.
 *
 * Usage:
 *   npx tsx scripts/railway-cron-plan.ts
 *   npx tsx scripts/railway-cron-plan.ts --base https://my-host.up.railway.app
 *   npx tsx scripts/railway-cron-plan.ts --smoke   # fires every cron once via curl
 *
 * Companion to the operator's manual click-through in Railway: each
 * cron needs its own `curlimages/curl:latest` service, scheduled per
 * the printed cron expression, with `Authorization: Bearer
 * $CRON_SECRET` header. The web service holds CRON_SECRET; reference it
 * from each cron service via Railway variable interpolation
 * (`${{Communications_Engine.CRON_SECRET}}`) so rotations propagate
 * automatically.
 */
import { REGISTERED_CRONS } from "../src/lib/cron-health/register";

type Recommendation = {
  cronName: string;
  expectedIntervalMinutes: number;
  recommendedSchedule: string;
  description: string;
};

/**
 * Map expectedIntervalMinutes → a sane default cron expression.
 * Specific crons override the default below to spread load (e.g. the
 * three daily firm-rollup crons stagger at 02:00 / 03:00 / 04:00).
 */
function defaultSchedule(name: string, intervalMinutes: number): string {
  // Per-cron overrides — match the recommended schedules in each cron's
  // route.ts comment header.
  const overrides: Record<string, string> = {
    "lifecycle-sweep": "0 3 * * *",
    "billing-close": "5 2 * * *",
    "termination": "10 2 * * *",
    "digest": "0 9 * * 1",
    "webhooks-deliver": "* * * * *",
    "health-check": "*/15 * * * *",
    "audit-verify": "30 1 * * *",
    "auto-draft": "*/5 * * * *",
    "channel-auth-expiry": "30 1 * * *",
    "draft-stale": "45 1 * * *",
    "adherence-monitor": "0 2 * * *",
    "sentiment-stale": "15 * * * *",
    "sentiment-firm-ack-monitor": "0 3 * * *",
    "adherence-firm-ack-monitor": "0 4 * * *",
    "adherence-stale": "30 * * * *",
  };
  if (overrides[name]) return overrides[name];
  // Fallback: derive from interval. Crude but only used for new crons
  // that don't yet have a recommendation pinned.
  if (intervalMinutes === 1) return "* * * * *";
  if (intervalMinutes <= 5) return `*/${intervalMinutes} * * * *`;
  if (intervalMinutes <= 60) return `*/${intervalMinutes} * * * *`;
  if (intervalMinutes <= 24 * 60) return `0 ${Math.floor(intervalMinutes / 60) % 24} * * *`;
  return "0 0 * * 0"; // weekly fallback
}

function parseArgs() {
  const args = process.argv.slice(2);
  let base = process.env.RAILWAY_HOST_URL ?? "https://YOUR-RAILWAY-HOST";
  let smoke = false;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--base") {
      base = args[i + 1] ?? base;
      i += 1;
    } else if (args[i] === "--smoke") {
      smoke = true;
    }
  }
  return { base, smoke };
}

async function main() {
  const { base, smoke } = parseArgs();

  const recs: Recommendation[] = REGISTERED_CRONS.map((c) => ({
    cronName: c.cronName,
    expectedIntervalMinutes: c.expectedIntervalMinutes,
    recommendedSchedule: defaultSchedule(c.cronName, c.expectedIntervalMinutes),
    description: c.description,
  }));

  if (smoke) {
    const secret = process.env.CRON_SECRET;
    if (!secret) {
      console.error(
        "CRON_SECRET not set in this shell. Export it first: export CRON_SECRET=...",
      );
      process.exit(2);
    }
    console.log(`# Firing every registered cron once against ${base}`);
    for (const r of recs) {
      const cmd =
        `curl -sS -H "Authorization: Bearer $CRON_SECRET" ` +
        `${base}/api/cron/${r.cronName}`;
      console.log(`echo '--- ${r.cronName} ---'`);
      console.log(cmd);
    }
    return;
  }

  console.log("Railway cron plan");
  console.log("=================");
  console.log("");
  console.log(`Web service: Communications_Engine (CRON_SECRET source)`);
  console.log(`Web URL:     ${base}`);
  console.log("");
  console.log(
    "For each row below, create a Railway service with image " +
      "`curlimages/curl:latest`, schedule = the cron expression, and " +
      "command = the printed curl line. Reference CRON_SECRET via " +
      "${{Communications_Engine.CRON_SECRET}} so rotations propagate.",
  );
  console.log("");
  console.log("Cron name                       Schedule           Interval");
  console.log("------------------------------  -----------------  ----------");
  for (const r of recs) {
    const intervalLabel =
      r.expectedIntervalMinutes < 60
        ? `${r.expectedIntervalMinutes}m`
        : r.expectedIntervalMinutes === 60
          ? "1h"
          : r.expectedIntervalMinutes < 24 * 60
            ? `${r.expectedIntervalMinutes / 60}h`
            : r.expectedIntervalMinutes === 24 * 60
              ? "1d"
              : `${r.expectedIntervalMinutes / (24 * 60)}d`;
    console.log(
      `${r.cronName.padEnd(30)}  ${r.recommendedSchedule.padEnd(17)}  ${intervalLabel}`,
    );
  }
  console.log("");
  console.log(
    "All curl commands (paste into the cron service's start command):",
  );
  console.log("");
  for (const r of recs) {
    console.log(
      `# ${r.cronName} — ${r.recommendedSchedule}`,
    );
    console.log(
      `curl -sS -H "Authorization: Bearer $CRON_SECRET" ${base}/api/cron/${r.cronName}`,
    );
    console.log("");
  }
  console.log(
    "After services are wired, run `npx tsx scripts/railway-cron-plan.ts --smoke --base " +
      `${base}\` (with CRON_SECRET exported) to fire each cron once and ` +
      "confirm authorisation. Watch /admin/health for the resulting heartbeat rows.",
  );
}

main();
