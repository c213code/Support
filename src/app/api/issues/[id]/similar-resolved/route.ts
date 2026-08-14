import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { findSimilarResolved } from "@/lib/solutionLibrary";

type Params = { params: Promise<{ id: string }> };

// "Как мы это решали в прошлый раз" для окна "Как решили?" на сайте —
// только подсказка, применяет её агент нажатием (см. ResolveDialog).
export async function GET(_request: NextRequest, { params }: Params) {
  const { id } = await params;
  const issue = await prisma.issue.findUnique({
    where: { id },
    select: { id: true, description: true },
  });
  if (!issue) {
    return NextResponse.json({ error: "issue not found" }, { status: 404 });
  }

  return NextResponse.json({ suggestions: await findSimilarResolved(issue) });
}
