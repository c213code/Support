import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

const GROUPS = [
  { name: "Әдістеме & IT", emoji: "🎲", order: 1 },
  { name: "Сату - Платформа", emoji: "💵", order: 2 },
  { name: "IT & Product", emoji: "📚", order: 3 },
  { name: "IT + Сервис", emoji: "📥", order: 4 },
];

async function main() {
  for (const group of GROUPS) {
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
