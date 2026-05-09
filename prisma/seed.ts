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

  const userSeeds = [
    { email: "stuart@acumon.com", name: "Stuart Johnson", role: "FIRM_ADMIN" as const },
    { email: "alice.fct@acumon.example", name: "Alice Singh", role: "FCT_MEMBER" as const },
    { email: "bob.fct@acumon.example", name: "Bob Mensah", role: "FCT_MEMBER" as const },
    { email: "carol.fct@acumon.example", name: "Carol Reyes", role: "FCT_MEMBER" as const },
    { email: "david.fct@acumon.example", name: "David O'Connor", role: "FCT_MEMBER" as const },
    { email: "eve.user@acumon.example", name: "Eve Tanaka", role: "USER" as const },
    { email: "frank.user@acumon.example", name: "Frank Müller", role: "USER" as const },
    { email: "grace.user@acumon.example", name: "Grace Olufemi", role: "USER" as const },
    { email: "harry.sales@acumon.example", name: "Harry Petrov", role: "SALES_REVIEWER" as const },
    { email: "ivy.curator@acumon.example", name: "Ivy Lambert", role: "CURATOR" as const },
  ];

  for (const u of userSeeds) {
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

  // Audit: tenant provisioned + members joined (only on first run)
  const existingEvents = await prisma.auditEvent.count({ where: { tenantId: tenant.id } });
  if (existingEvents === 0) {
    await writeAuditEvent({
      tenantId: tenant.id,
      eventType: "TENANT_PROVISIONED",
      subjectType: "Tenant",
      subjectId: tenant.id,
      payload: { jurisdiction: "UK", source: "seed" },
    });
    for (const u of userSeeds) {
      const user = await prisma.user.findUnique({ where: { email: u.email } });
      if (!user) continue;
      const m = await prisma.membership.findUnique({
        where: { tenantId_userId: { tenantId: tenant.id, userId: user.id } },
      });
      if (!m) continue;
      await writeAuditEvent({
        tenantId: tenant.id,
        eventType: "USER_JOINED",
        actorMembershipId: null,
        subjectType: "Membership",
        subjectId: m.id,
        payload: { email: u.email, role: u.role, source: "seed" },
      });
    }
    console.log(`  + audit: tenant provisioned, ${userSeeds.length} members joined`);
  }

  console.log("\nSeed complete. Open http://localhost:3000 and sign in as one of:");
  for (const u of userSeeds) console.log(`  - ${u.email}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
