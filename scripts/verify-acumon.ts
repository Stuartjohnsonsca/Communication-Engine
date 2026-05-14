/**
 * Idempotent verifier for the Acumon operator-tenant bootstrap.
 *
 * The bootstrap itself runs automatically on every Railway deploy via
 * `npm run prisma:deploy` → `prisma/seed.ts`, which idempotently
 * upserts:
 *   - the `acumon` tenant
 *   - `stuart@acumon.com` as a FIRM_ADMIN
 *
 * This script verifies that the bootstrap succeeded against the
 * currently-pointed-at DATABASE_URL and prints a one-line status. Safe
 * to run against production (read-only). Add a FIRM_ADMIN with
 * `--add-admin <email> [<name>]` if the bootstrap is missing it.
 *
 * Usage:
 *   npx tsx scripts/verify-acumon.ts
 *   npx tsx scripts/verify-acumon.ts --add-admin alice@acumon.com "Alice Doe"
 *
 * Exits with code 0 on success, 1 on missing tenant, 2 on missing
 * FIRM_ADMIN, 3 on schema/connection error. Suitable for use as a
 * deploy gate.
 */
import { PrismaClient } from "@prisma/client";

async function main() {
  const args = process.argv.slice(2);
  const addAdminFlag = args.indexOf("--add-admin");
  const addAdminEmail = addAdminFlag >= 0 ? args[addAdminFlag + 1] : null;
  const addAdminName = addAdminFlag >= 0 ? args[addAdminFlag + 2] ?? "" : "";

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL not set");
    process.exit(3);
  }

  const prisma = new PrismaClient();
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { slug: "acumon" },
    });
    if (!tenant) {
      console.error("FAIL: acumon tenant does not exist. Run `npm run seed`.");
      process.exit(1);
    }
    console.log(`OK: tenant ${tenant.name} (${tenant.id}) status=${tenant.status}`);

    const firmAdmins = await prisma.membership.findMany({
      where: {
        tenantId: tenant.id,
        role: "FIRM_ADMIN",
        status: "ACTIVE",
      },
      include: { user: { select: { email: true, name: true } } },
    });

    if (addAdminEmail) {
      const user = await prisma.user.upsert({
        where: { email: addAdminEmail },
        create: {
          email: addAdminEmail,
          name: addAdminName || addAdminEmail,
          emailVerified: new Date(),
        },
        update: addAdminName ? { name: addAdminName } : {},
      });
      const membership = await prisma.membership.upsert({
        where: { tenantId_userId: { tenantId: tenant.id, userId: user.id } },
        create: {
          tenantId: tenant.id,
          userId: user.id,
          role: "FIRM_ADMIN",
          status: "ACTIVE",
        },
        update: { role: "FIRM_ADMIN", status: "ACTIVE" },
      });
      console.log(
        `ADDED: ${addAdminEmail} as FIRM_ADMIN (membership=${membership.id})`,
      );
    }

    if (firmAdmins.length === 0 && !addAdminEmail) {
      console.error(
        "FAIL: no ACTIVE FIRM_ADMIN on acumon tenant. " +
          "Re-run `npm run seed` or pass --add-admin <email> [<name>].",
      );
      process.exit(2);
    }

    const finalAdmins = await prisma.membership.findMany({
      where: { tenantId: tenant.id, role: "FIRM_ADMIN", status: "ACTIVE" },
      include: { user: { select: { email: true } } },
    });
    console.log(`OK: ${finalAdmins.length} ACTIVE FIRM_ADMIN(s):`);
    for (const m of finalAdmins) {
      console.log(`     - ${m.user.email} (membership=${m.id})`);
    }
    process.exit(0);
  } catch (e) {
    console.error(`SCHEMA/CONNECTION ERROR: ${e instanceof Error ? e.message : e}`);
    process.exit(3);
  } finally {
    await prisma.$disconnect();
  }
}

main();
