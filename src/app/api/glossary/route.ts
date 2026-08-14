import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentIdentity } from "@/lib/auth";
import { extractGlossaryTerms } from "@/lib/ai";
import {
  listGlossary,
  upsertTerm,
  deleteTerm,
  invalidateAiContext,
} from "@/lib/projectContext";

// Сколько истории показываем модели при пересборке словаря.
const CORPUS_LIMIT = 300;

export async function GET() {
  return NextResponse.json({ terms: await listGlossary() });
}

// Три действия одним роутом: пересобрать словарь из истории (rebuild),
// поправить/добавить термин руками (upsert), удалить (delete).
//
// Пересборка — только по явному нажатию или по cron, но не на каждое
// сообщение: словарь строится из уже решённых тикетов и за день почти не
// меняется, а поход в модель на каждое обращение сжёг бы квоту впустую.
export async function POST(request: NextRequest) {
  const identity = await getCurrentIdentity();
  if (!identity) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);

  if (body?.action === "delete" && typeof body.id === "string") {
    await deleteTerm(body.id);
    return NextResponse.json({ ok: true });
  }

  if (typeof body?.term === "string" && typeof body?.meaning === "string") {
    // auto: false — вписанное человеком, пересборка это не перезапишет.
    await upsertTerm(body.term, body.meaning, false);
    return NextResponse.json({ ok: true });
  }

  if (body?.action !== "rebuild") {
    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  }

  if (!process.env.GROQ_API_KEY) {
    return NextResponse.json({ error: "ИИ недоступен — проверь GROQ_API_KEY" }, { status: 400 });
  }

  const issues = await prisma.issue.findMany({
    where: { status: "RESOLVED" },
    orderBy: { reportDate: "desc" },
    take: CORPUS_LIMIT,
    select: { description: true, note: true },
  });
  if (issues.length === 0) {
    return NextResponse.json({ error: "Нет решённых тикетов — не из чего собирать" }, { status: 400 });
  }

  const terms = await extractGlossaryTerms(issues);
  if (terms === null) {
    return NextResponse.json({ error: "ИИ недоступен, попробуй позже" }, { status: 503 });
  }

  for (const t of terms) {
    await upsertTerm(t.term, t.meaning, true);
  }
  invalidateAiContext();

  return NextResponse.json({ added: terms.length, terms: await listGlossary() });
}
