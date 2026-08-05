import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL!,
});

// fromId — BigInt (Telegram id может не влезать в 32-битный Int), а
// JSON.stringify не умеет сериализовать BigInt из коробки. Он нужен только
// для внутренней склейки сообщений, наружу в API-ответах не отдаём.
export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter,
    omit: { telegramMessage: { fromId: true } },
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
