import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { extractGlossaryTerms } from "@/lib/ai";
import { upsertTerm, invalidateAiContext } from "@/lib/projectContext";

const CORPUS_LIMIT = 300;

// Раз в сутки пересобирает словарь внутреннего жаргона из закрытых
// тикетов — тот контекст, который потом подмешивается во все запросы к
// модели (см. src/lib/projectContext.ts).
//
// Почему по расписанию, а не на каждое сообщение: словарь строится из
// накопленной истории и за день меняется мало, а вызов модели на каждое
// входящее обращение — это десятки лишних запросов в сутки ради тех же
// самых терминов. Ночью же корпус за день уже полный.
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  if (!process.env.GROQ_API_KEY) {
    return NextResponse.json({ skipped: "no GROQ_API_KEY" });
  }

  const issues = await prisma.issue.findMany({
    where: { status: "RESOLVED" },
    orderBy: { reportDate: "desc" },
    take: CORPUS_LIMIT,
    select: { description: true, note: true },
  });
  if (issues.length === 0) {
    return NextResponse.json({ skipped: "no resolved issues" });
  }

  const terms = await extractGlossaryTerms(issues);
  if (terms === null) {
    return NextResponse.json({ skipped: "ai unavailable" });
  }

  for (const t of terms) {
    await upsertTerm(t.term, t.meaning, true);
  }
  invalidateAiContext();

  return NextResponse.json({ updated: terms.length });
}
