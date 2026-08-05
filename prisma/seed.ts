import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { OFFICIAL_GROUPS } from "../src/lib/groups";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

async function main() {
  for (const group of OFFICIAL_GROUPS) {
    await prisma.groupPreset.upsert({
      where: { name: group.name },
      update: { emoji: group.emoji, order: group.order },
      create: group,
    });
  }
  console.log("Group presets seeded ✅");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
