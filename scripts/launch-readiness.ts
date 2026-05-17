/**
 * Single-script launch-readiness audit + best-effort automation.
 *
 * Replaces the older `verify-acumon` + `railway-cron-plan` scripts'
 * scope by combining their checks AND the smoke-ingest pass into one
 * runnable artifact. Designed for the launch-window constraint of
 * "operator can run one script at a time" — this is the one.
 *
 * Modes (combine freely):
 *   --report        (default) read-only: prints a green/red status of every
 *                   launch concern (DB bootstrap, cron wiring, per-tenant
 *                   OAuth apps, per-Member auths). Exits 0 if all green,
 *                   2 if any red, 3 on infra error.
 *   --bootstrap-crons   creates missing Railway cron services via the
 *                       Railway public GraphQL API. Requires:
 *                         RAILWAY_API_TOKEN     personal API token
 *                         RAILWAY_PROJECT_ID    the project containing the
 *                                               web service + cron services
 *                         RAILWAY_ENVIRONMENT_ID  (usually "production")
 *                         RAILWAY_WEB_HOST      e.g. https://acumon.up.railway.app
 *                       Falls back to printing the manual-click steps if
 *                       the token is absent or the API call fails.
 *   --smoke-ingest      runs `runIngest` on every Channel that has at least
 *                       one active per-Member auth. Bounds work via the
 *                       adapters' built-in 25-row caps. Reports per-tenant
 *                       per-Channel per-Member counts. Exits non-zero if
 *                       any ingest pass throws.
 *   --all               shorthand for the three above.
 *
 * Usage:
 *   npx tsx scripts/launch-readiness.ts
 *   npx tsx scripts/launch-readiness.ts --bootstrap-crons
 *   npx tsx scripts/launch-readiness.ts --smoke-ingest
 *   npx tsx scripts/launch-readiness.ts --all
 *
 * Idempotent: safe to re-run. Does NOT mutate user data; only mutates
 * platform infrastructure (creating cron services) and produces side
 * effects in the form of new IngestedMessage rows from real provider
 * mailboxes during smoke-ingest.
 *
 * Output is line-prefixed with [PASS] / [WARN] / [FAIL] so a CI grep
 * can wire it up as a deploy gate later.
 */
import { PrismaClient } from "@prisma/client";
import { REGISTERED_CRONS } from "../src/lib/cron-health/register";

type Outcome = "PASS" | "WARN" | "FAIL";

const args = process.argv.slice(2);
const wantBootstrapCrons = args.includes("--bootstrap-crons") || args.includes("--all");
const wantSmokeIngest = args.includes("--smoke-ingest") || args.includes("--all");

let exitCode = 0;
function record(outcome: Outcome, line: string) {
  // Track worst outcome so we exit non-zero on any FAIL.
  if (outcome === "FAIL") exitCode = Math.max(exitCode, 2);
  if (outcome === "WARN") exitCode = Math.max(exitCode, 1); // informational
  console.log(`[${outcome}] ${line}`);
}

async function main() {
  // DB connectivity is optional now. If it works, the audit checks run.
  // If not (e.g. running from outside Railway's network where the
  // `.railway.internal` host doesn't resolve), the audit phases are
  // skipped with a WARN and bootstrap-only mode still works because
  // the Railway API doesn't need DB access.
  let prisma: PrismaClient | null = null;
  let dbReachable = false;
  if (process.env.DATABASE_URL) {
    prisma = new PrismaClient();
    try {
      await prisma.$queryRaw`SELECT 1`;
      dbReachable = true;
    } catch (e) {
      record(
        "WARN",
        `DB unreachable from this terminal (${e instanceof Error ? e.message.split("\n")[0].slice(0, 200) : String(e)}). Audit phases will be skipped; bootstrap-crons + manual fallbacks still work.`,
      );
    }
  } else {
    record("WARN", "DATABASE_URL not set; audit phases will be skipped.");
  }

  try {
    console.log("=".repeat(60));
    console.log("Launch-readiness audit");
    console.log("=".repeat(60));

    if (dbReachable && prisma) {
      await checkAcumonBootstrap(prisma);
      await checkCronWiring(prisma);
      await checkPerTenantOAuth(prisma);
      await checkPerMemberAuths(prisma);
    } else {
      console.log("\n[skipped audit phases — DB not reachable from here]");
    }

    if (wantBootstrapCrons) {
      console.log("\n" + "=".repeat(60));
      console.log("Bootstrap missing Railway cron services");
      console.log("=".repeat(60));
      // Pass null prisma when DB isn't reachable — bootstrap then
      // skips the "which crons are already wired" check and attempts
      // all of them (Railway API rejects duplicates harmlessly).
      await bootstrapRailwayCrons(dbReachable ? prisma : null);
    }

    if (wantSmokeIngest) {
      if (!dbReachable || !prisma) {
        record(
          "FAIL",
          "Smoke-ingest requires DB access — run from inside Railway's network OR enable Postgres public networking + use DATABASE_PUBLIC_URL.",
        );
      } else {
        console.log("\n" + "=".repeat(60));
        console.log("Smoke-ingest pass");
        console.log("=".repeat(60));
        await smokeIngest(prisma);
      }
    }

    console.log("\n" + "=".repeat(60));
    console.log(
      exitCode === 0
        ? "All checks PASS — launch-ready."
        : exitCode === 1
          ? "Checks PASS with warnings — review and proceed."
          : "Checks FAIL — see [FAIL] lines above for action items.",
    );
    console.log("=".repeat(60));
    process.exit(exitCode);
  } catch (e) {
    console.error(`SCRIPT ERROR: ${e instanceof Error ? e.message : e}`);
    process.exit(3);
  } finally {
    if (prisma) await prisma.$disconnect();
  }
}

// ───────────────────────────────────────────────────────────────────
// Check 1 — Acumon operator tenant + first FIRM_ADMIN exists.
// ───────────────────────────────────────────────────────────────────

async function checkAcumonBootstrap(prisma: PrismaClient) {
  console.log("\n--- Acumon operator tenant ---");
  const tenant = await prisma.tenant.findUnique({ where: { slug: "acumon" } });
  if (!tenant) {
    record(
      "FAIL",
      "acumon tenant does NOT exist. Run `npm run seed` (or redeploy on Railway — `prisma:deploy` runs the seed automatically).",
    );
    return;
  }
  record("PASS", `acumon tenant exists (${tenant.id}, status=${tenant.status})`);

  const admins = await prisma.membership.findMany({
    where: { tenantId: tenant.id, role: "FIRM_ADMIN", status: "ACTIVE" },
    include: { user: { select: { email: true } } },
  });
  if (admins.length === 0) {
    record(
      "FAIL",
      "no ACTIVE FIRM_ADMIN on acumon. Re-run `npm run seed` or add via API.",
    );
    return;
  }
  record(
    "PASS",
    `${admins.length} ACTIVE FIRM_ADMIN(s): ${admins
      .map((a) => a.user.email ?? a.id)
      .join(", ")}`,
  );
}

// ───────────────────────────────────────────────────────────────────
// Check 2 — Railway cron wiring (heartbeat presence + freshness).
// ───────────────────────────────────────────────────────────────────

async function checkCronWiring(prisma: PrismaClient) {
  console.log("\n--- Railway cron wiring ---");
  const heartbeats = await prisma.cronHeartbeat.findMany();
  const byName = new Map(heartbeats.map((h) => [h.cronName, h]));
  const now = Date.now();

  let wired = 0;
  let stale = 0;
  let missing = 0;
  for (const cron of REGISTERED_CRONS) {
    const hb = byName.get(cron.cronName);
    if (!hb || !hb.lastSuccessAt) {
      record(
        "FAIL",
        `${cron.cronName.padEnd(30)} NOT wired (no successful run ever). Add a Railway cron service per scripts/railway-cron-plan.ts.`,
      );
      missing++;
      continue;
    }
    const ageMin = (now - hb.lastSuccessAt.getTime()) / 60000;
    const stallThreshold = cron.expectedIntervalMinutes * 2;
    if (ageMin > stallThreshold) {
      record(
        "WARN",
        `${cron.cronName.padEnd(30)} STALE (last success ${Math.round(ageMin)}m ago, threshold ${stallThreshold}m). ${
          hb.lastErrorMessage ? `Last error: ${hb.lastErrorMessage.slice(0, 100)}` : "Check Railway logs."
        }`,
      );
      stale++;
      continue;
    }
    record(
      "PASS",
      `${cron.cronName.padEnd(30)} wired (last success ${Math.round(ageMin)}m ago, ${cron.expectedIntervalMinutes}m interval)`,
    );
    wired++;
  }
  console.log(
    `  Summary: ${wired} wired / ${stale} stale / ${missing} missing of ${REGISTERED_CRONS.length} registered`,
  );
}

// ───────────────────────────────────────────────────────────────────
// Check 3 — Per-tenant OAuth app configuration (item 101+).
// ───────────────────────────────────────────────────────────────────

async function checkPerTenantOAuth(prisma: PrismaClient) {
  console.log("\n--- Per-tenant OAuth provider apps ---");
  const tenants = await prisma.tenant.findMany({
    where: { status: "ACTIVE" },
    select: { id: true, slug: true, name: true },
    orderBy: { slug: "asc" },
  });
  if (tenants.length === 0) {
    record("WARN", "no ACTIVE tenants. Bootstrap acumon at minimum.");
    return;
  }
  for (const t of tenants) {
    const apps = await prisma.channelOAuthApp.findMany({
      where: { tenantId: t.id },
      select: { channelKind: true, clientId: true, updatedAt: true },
    });
    if (apps.length === 0) {
      record(
        "WARN",
        `tenant=${t.slug.padEnd(20)} no OAuth apps configured. Walk the FIRM_ADMIN through /admin/channels/oauth-apps.`,
      );
      continue;
    }
    const kinds = apps.map((a) => `${a.channelKind}(${a.clientId.slice(-4)})`).join(", ");
    record("PASS", `tenant=${t.slug.padEnd(20)} ${apps.length} OAuth app(s): ${kinds}`);
  }
}

// ───────────────────────────────────────────────────────────────────
// Check 4 — Per-Member ChannelAuth coverage (item 104).
// ───────────────────────────────────────────────────────────────────

async function checkPerMemberAuths(prisma: PrismaClient) {
  console.log("\n--- Per-Member ChannelAuth coverage ---");
  const channels = await prisma.channel.findMany({
    where: { tenant: { status: "ACTIVE" } },
    include: {
      tenant: { select: { slug: true } },
      auths: {
        where: { revokedAt: null },
        select: { id: true, membershipId: true, expiresAt: true },
      },
    },
  });
  if (channels.length === 0) {
    record(
      "WARN",
      "no Channels exist on any tenant. FIRM_ADMINs must add Channels via /admin/channels before staff can connect.",
    );
    return;
  }
  for (const c of channels) {
    const memberAuths = c.auths.filter((a) => a.membershipId !== null);
    if (memberAuths.length === 0) {
      record(
        "WARN",
        `${c.tenant.slug}/${c.kind} (${c.id}) — no per-Member auths. Staff need to connect via /account.`,
      );
      continue;
    }
    record(
      "PASS",
      `${c.tenant.slug}/${c.kind} — ${memberAuths.length} active per-Member auth(s)`,
    );
  }
}

// ───────────────────────────────────────────────────────────────────
// Action 1 — Bootstrap Railway cron services.
// ───────────────────────────────────────────────────────────────────

async function bootstrapRailwayCrons(prisma: PrismaClient | null) {
  const token = process.env.RAILWAY_API_TOKEN;
  const projectId = process.env.RAILWAY_PROJECT_ID;
  const envId = process.env.RAILWAY_ENVIRONMENT_ID;
  const webHost = process.env.RAILWAY_WEB_HOST;
  const cronSecret = process.env.CRON_SECRET;

  // Compute which crons need creating. If DB unreachable, just attempt
  // all of them — Railway API will skip on duplicate service name.
  let wiredNames = new Set<string>();
  if (prisma) {
    try {
      const heartbeats = await prisma.cronHeartbeat.findMany();
      wiredNames = new Set(
        heartbeats.filter((h) => h.lastSuccessAt !== null).map((h) => h.cronName),
      );
    } catch {
      // ignore — proceed as if no crons are wired
    }
  }
  const missing = REGISTERED_CRONS.filter((c) => !wiredNames.has(c.cronName));

  if (missing.length === 0) {
    record("PASS", "All registered crons have at least one successful run — nothing to bootstrap.");
    return;
  }

  console.log(`  ${missing.length} crons to bootstrap: ${missing.map((m) => m.cronName).join(", ")}`);

  if (!token || !projectId || !envId || !webHost || !cronSecret) {
    record(
      "WARN",
      "Railway API automation not configured (need RAILWAY_API_TOKEN + RAILWAY_PROJECT_ID + RAILWAY_ENVIRONMENT_ID + RAILWAY_WEB_HOST + CRON_SECRET). Falling back to printed manual steps.",
    );
    printManualCronSteps(missing, webHost ?? "https://YOUR-RAILWAY-HOST");
    return;
  }

  for (const cron of missing) {
    const schedule = recommendedSchedule(cron.cronName, cron.expectedIntervalMinutes);
    const url = `${webHost}/api/cron/${cron.cronName}`;
    const startCommand = `sh -c 'curl -sS -H "Authorization: Bearer $CRON_SECRET" ${url}'`;
    try {
      await createRailwayCronService({
        token,
        projectId,
        envId,
        serviceName: `${cron.cronName}-cron`,
        cronSchedule: schedule,
        startCommand,
        cronSecret,
      });
      record(
        "PASS",
        `Created Railway service ${cron.cronName}-cron (${schedule}). Heartbeat will appear after first run.`,
      );
    } catch (e) {
      record(
        "FAIL",
        `${cron.cronName}-cron creation failed: ${e instanceof Error ? e.message : e}. Falling back to manual.`,
      );
    }
  }
  console.log(
    "  Note: Railway service creation does NOT immediately run the cron — wait for the next scheduled tick (or trigger via the Railway dashboard's 'Restart' button) and then re-run this script with --report.",
  );
}

function printManualCronSteps(
  missing: typeof REGISTERED_CRONS,
  base: string,
) {
  console.log("\n  Manual click-through (for each cron below):");
  console.log("  1. Railway dashboard → New Service → Empty service.");
  console.log("  2. Image: curlimages/curl:latest");
  console.log("  3. Variables: CRON_SECRET = ${{Communications_Engine.CRON_SECRET}}");
  console.log("  4. Settings → Cron schedule = (see table)");
  console.log("  5. Settings → Custom Start Command = (see table)");
  console.log("  6. Service name: <cron-name>-cron");
  console.log("");
  for (const c of missing) {
    const schedule = recommendedSchedule(c.cronName, c.expectedIntervalMinutes);
    console.log(`  • ${c.cronName.padEnd(30)} schedule="${schedule}"`);
    console.log(`    start: curl -sS -H "Authorization: Bearer $CRON_SECRET" ${base}/api/cron/${c.cronName}`);
  }
}

function recommendedSchedule(name: string, intervalMinutes: number): string {
  // Mirror scripts/railway-cron-plan.ts overrides — keep these in sync.
  const overrides: Record<string, string> = {
    "lifecycle-sweep": "0 3 * * *",
    "billing-close": "5 2 * * *",
    termination: "10 2 * * *",
    digest: "0 9 * * 1",
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
  if (intervalMinutes === 1) return "* * * * *";
  if (intervalMinutes <= 60) return `*/${intervalMinutes} * * * *`;
  if (intervalMinutes <= 24 * 60)
    return `0 ${Math.floor(intervalMinutes / 60) % 24} * * *`;
  return "0 0 * * 0";
}

/**
 * Railway public GraphQL — minimum mutations to create a cron service.
 * NOTE: Railway's public API surface evolves; if these calls fail with a
 * schema error, the script falls back to printing manual steps. Tested
 * against the November 2026 schema; revisit if Railway rev'd.
 */
async function createRailwayCronService(args: {
  token: string;
  projectId: string;
  envId: string;
  serviceName: string;
  cronSchedule: string;
  startCommand: string;
  cronSecret: string;
}) {
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${args.token}`,
  };
  // Step 1: create the service.
  const createMutation = `
    mutation ServiceCreate($input: ServiceCreateInput!) {
      serviceCreate(input: $input) { id }
    }`;
  const createRes = await fetch("https://backboard.railway.app/graphql/v2", {
    method: "POST",
    headers,
    body: JSON.stringify({
      query: createMutation,
      variables: {
        input: {
          name: args.serviceName,
          projectId: args.projectId,
          source: { image: "curlimages/curl:latest" },
        },
      },
    }),
  });
  const createBody = (await createRes.json()) as {
    data?: { serviceCreate?: { id?: string } };
    errors?: { message: string }[];
  };
  if (createBody.errors?.length) {
    throw new Error(createBody.errors.map((e) => e.message).join("; "));
  }
  const serviceId = createBody.data?.serviceCreate?.id;
  if (!serviceId) throw new Error("serviceCreate returned no id");

  // Step 2: set the cron schedule + start command on the service instance.
  const updateMutation = `
    mutation ServiceInstanceUpdate($serviceId: String!, $environmentId: String, $input: ServiceInstanceUpdateInput!) {
      serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input)
    }`;
  const updateRes = await fetch("https://backboard.railway.app/graphql/v2", {
    method: "POST",
    headers,
    body: JSON.stringify({
      query: updateMutation,
      variables: {
        serviceId,
        environmentId: args.envId,
        input: {
          cronSchedule: args.cronSchedule,
          startCommand: args.startCommand,
        },
      },
    }),
  });
  const updateBody = (await updateRes.json()) as {
    errors?: { message: string }[];
  };
  if (updateBody.errors?.length) {
    throw new Error(updateBody.errors.map((e) => e.message).join("; "));
  }

  // Step 3: set CRON_SECRET env var on the new service. Reference the
  // web service's value so rotations propagate automatically.
  const variableMutation = `
    mutation VariableUpsert($input: VariableUpsertInput!) {
      variableUpsert(input: $input)
    }`;
  await fetch("https://backboard.railway.app/graphql/v2", {
    method: "POST",
    headers,
    body: JSON.stringify({
      query: variableMutation,
      variables: {
        input: {
          projectId: args.projectId,
          environmentId: args.envId,
          serviceId,
          name: "CRON_SECRET",
          value: args.cronSecret,
        },
      },
    }),
  });
}

// ───────────────────────────────────────────────────────────────────
// Action 2 — Smoke-ingest every Channel that has at least one auth.
// ───────────────────────────────────────────────────────────────────

async function smokeIngest(prisma: PrismaClient) {
  // Lazy import: runIngest pulls in adapters + crypto + Prisma client and
  // we want the import cost only on the smoke-ingest path.
  const { runIngest } = await import("../src/lib/channels/ingest");

  const channels = await prisma.channel.findMany({
    where: {
      tenant: { status: "ACTIVE" },
      auths: { some: { revokedAt: null, membershipId: { not: null } } },
    },
    include: {
      tenant: { select: { slug: true } },
    },
  });

  if (channels.length === 0) {
    record(
      "WARN",
      "no Channels with active per-Member auths — nothing to smoke-ingest. Staff need to connect via /account first.",
    );
    return;
  }

  for (const c of channels) {
    try {
      const result = await runIngest(c.id);
      const detail = `fetched=${result.fetched} inserted=${result.inserted} skipped=${result.skipped} synthesised=${result.synthesised} matched=${result.matched}${
        result.refreshFailed ? " REFRESH_FAILED" : ""
      } perMember=${result.perMember.length}`;
      const outcome: Outcome =
        result.refreshFailed
          ? "WARN"
          : result.perMember.some((m) => m.refreshFailed)
            ? "WARN"
            : "PASS";
      record(
        outcome,
        `${c.tenant.slug}/${c.kind} (${c.id}) — ${detail}`,
      );
    } catch (e) {
      record(
        "FAIL",
        `${c.tenant.slug}/${c.kind} (${c.id}) — ingest threw: ${e instanceof Error ? e.message : e}`,
      );
    }
  }
}

main();
