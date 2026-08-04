import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const groups = await prisma.groupPreset.findMany({
    orderBy: { order: "asc" },
  });
  return NextResponse.json({ groups });
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (!body?.name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  const max = await prisma.groupPreset.findFirst({
    orderBy: { order: "desc" },
  });

  const group = await prisma.groupPreset.upsert({
    where: { name: body.name },
    update: { emoji: body.emoji ?? undefined },
    create: {
      name: body.name,
      emoji: body.emoji ?? null,
      order: (max?.order ?? 0) + 1,
    },
  });

  return NextResponse.json({ group }, { status: 201 });
}
