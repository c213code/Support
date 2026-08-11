import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { findDuplicateGroups } from "@/lib/ai";

// Подсказка "похоже, это одно и то же обращение" для дня целиком — не
// автоматизация: результат только предлагается, объединяют всегда руками
// через уже существующий POST /api/issues/[id]/merge-into (см. кнопку
// "🤖 Найти дубли" во "Входящих").
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const reportDate = body?.reportDate;
  if (typeof reportDate !== "string" || !reportDate) {
    return NextResponse.json({ error: "reportDate is required" }, { status: 400 });
  }

  if (!process.env.GROQ_API_KEY) {
    return NextResponse.json({ groups: [], unavailable: true });
  }

  const issues = await prisma.issue.findMany({
    where: { reportDate },
    orderBy: { position: "asc" },
  });

  if (issues.length < 2) {
    return NextResponse.json({ groups: [] });
  }

  const rawGroups = await findDuplicateGroups(
    issues.map((i) => ({ id: i.id, description: i.description }))
  );

  if (rawGroups === null) {
    return NextResponse.json({ groups: [], unavailable: true });
  }

  const byId = new Map(issues.map((i) => [i.id, i]));
  const groups = rawGroups
    .map((ids) => ids.map((id) => byId.get(id)).filter((i) => i != null))
    .filter((group) => group.length >= 2);

  return NextResponse.json({ groups });
}
