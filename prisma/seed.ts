import { PrismaClient } from "@prisma/client";
import { writeAuditEvent } from "../src/lib/audit";

const prisma = new PrismaClient();

async function main() {
  console.log("Seeding Acumon Intelligence tenant…");

  const tenant = await prisma.tenant.upsert({
    where: { slug: "acumon" },
    create: {
      slug: "acumon",
      name: "Acumon Intelligence",
      jurisdiction: "UK",
      status: "ACTIVE",
      quorumPct: 50,
      votingWindowDays: 5,
    },
    update: {},
  });
  console.log(`Tenant: ${tenant.name} (${tenant.id})`);

  // ─── Cleanup any previously-seeded demo placeholders ─────────────────────
  // Earlier seeds inserted fictional FCT/User/Sales/Curator rows under the
  // *.example domain. Real members will be invited through the admin UI; the
  // demo placeholders should not persist.
  const purgedMemberships = await prisma.membership.deleteMany({
    where: { tenantId: tenant.id, user: { email: { contains: "@acumon.example" } } },
  });
  const purgedUsers = await prisma.user.deleteMany({
    where: { email: { contains: "@acumon.example" } },
  });
  if (purgedMemberships.count || purgedUsers.count) {
    console.log(`  cleaned ${purgedMemberships.count} memberships, ${purgedUsers.count} users`);
  }

  // The previous Stuart record on @johnsonsca.com is preserved (avoids
  // orphaning audit events) but its membership is suspended so it doesn't
  // inflate the quorum count: with stuart@acumon.com as the sole active
  // member, a single APPROVE vote crosses the simple-majority threshold.
  const suspended = await prisma.membership.updateMany({
    where: {
      tenantId: tenant.id,
      user: { email: "stuart@johnsonsca.com" },
      status: "ACTIVE",
    },
    data: { status: "SUSPENDED" },
  });
  if (suspended.count) {
    console.log(`  suspended ${suspended.count} legacy stuart@johnsonsca.com membership`);
  }

  // ─── Seed only the real principal: stuart@acumon.com as FIRM_ADMIN ──────
  const realSeeds = [
    { email: "stuart@acumon.com", name: "Stuart Johnson", role: "FIRM_ADMIN" as const },
  ];

  for (const u of realSeeds) {
    const user = await prisma.user.upsert({
      where: { email: u.email },
      create: { email: u.email, name: u.name, emailVerified: new Date() },
      update: { name: u.name },
    });
    await prisma.membership.upsert({
      where: { tenantId_userId: { tenantId: tenant.id, userId: user.id } },
      create: { tenantId: tenant.id, userId: user.id, role: u.role, status: "ACTIVE" },
      update: { role: u.role, status: "ACTIVE" },
    });
    console.log(`  member: ${u.email} (${u.role})`);
  }

  // Initial audit event on first run only
  const existingEvents = await prisma.auditEvent.count({ where: { tenantId: tenant.id } });
  if (existingEvents === 0) {
    await writeAuditEvent({
      tenantId: tenant.id,
      eventType: "TENANT_PROVISIONED",
      subjectType: "Tenant",
      subjectId: tenant.id,
      payload: { jurisdiction: "UK", source: "seed" },
    });
  }

  console.log("\nSeed complete. Sign in at /login as stuart@acumon.com.");
  console.log("Add additional Firm Culture Team / User memberships through the admin UI.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
