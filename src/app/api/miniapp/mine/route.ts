import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { describeFields, findLabel } from "@/lib/submissionLabels";
import type { IssueStatus } from "@/lib/status";
import type { MySubmission } from "@/lib/miniappClient";
import { submissionFormEnabled, verifyInitData } from "@/lib/miniapp";

// За сколько показывать обращения: месяц — достаточно, чтобы увидеть всё
// недавнее, и список не растёт бесконечно.
const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
// Предохранитель на случай куратора, который подаёт очень много.
const MAX_ITEMS = 100;

// «Менің өтініштерім»: обращения куратора за месяц со статусом и историей.
//
// POST, а не GET: подпись Telegram (initData) передаём в теле, чтобы она не
// оседала в логах запросов вместе с адресом. Маршрут открыт без куки агента
// (proxy.ts пропускает /api/miniapp/) — кто спрашивает, узнаём по подписи, и
// отдаём строго его обращения.
export async function POST(request: NextRequest) {
  if (!submissionFormEnabled()) {
    return NextResponse.json({ error: "Форма әзірге өшірулі" }, { status: 503 });
  }

  const body = await request.json().catch(() => null);
  const initData = typeof body?.initData === "string" ? body.initData.slice(0, 8192) : "";
  const check = verifyInitData(initData);
  if (!check.ok) {
    console.warn(`[miniapp] список обращений: initData отклонена: ${check.reason}`);
    return NextResponse.json(
      {
        error:
          check.reason === "expired"
            ? "Форма бір тәуліктен бұрын ашылған — оны жауып, боттан қайта ашыңыз"
            : "Форманы боттан қайта ашыңыз",
      },
      { status: 401 }
    );
  }

  const rows = await prisma.issueSubmission.findMany({
    where: {
      telegramUserId: check.user.id,
      createdAt: { gte: new Date(Date.now() - WINDOW_MS) },
    },
    orderBy: { createdAt: "desc" },
    take: MAX_ITEMS,
    select: {
      id: true,
      createdAt: true,
      rawText: true,
      labelId: true,
      labelFields: true,
      photoFileIds: true,
      issue: {
        select: {
          status: true,
          note: true,
          groupName: true,
          groupEmoji: true,
          events: { orderBy: { at: "asc" }, select: { to: true, at: true } },
        },
      },
    },
  });

  const labelOf = (row: { labelId: string | null; issue: { groupName: string } }) =>
    row.labelId ? findLabel(row.issue.groupName, row.labelId) : null;

  const items: MySubmission[] = rows.map((row) => ({
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    text: row.rawText,
    // То же, что видит дежурный на карточке: название проблемы и поля с
    // подписями. Без них в списке лежал бы склеенный текст всех ответов.
    labelTitle: labelOf(row)?.title ?? null,
    fields: (() => {
      const label = labelOf(row);
      return label
        ? describeFields(label, (row.labelFields ?? {}) as Record<string, string | string[]>)
        : [];
    })(),
    groupName: row.issue.groupName,
    groupEmoji: row.issue.groupEmoji,
    status: row.issue.status,
    note: row.issue.status === "RESOLVED" ? row.issue.note?.trim() || null : null,
    // Первый шаг — сама подача: при заведении тикета IssueEvent не пишется.
    // События раньше подачи отбрасываем: после склейки заявка живёт на
    // основном тикете, и его история до этого момента к куратору не
    // относится — выглядела бы как «моё обращение взяли в работу раньше, чем я
    // его отправил».
    history: [
      { status: "SENT" as IssueStatus, at: row.createdAt.toISOString() },
      ...row.issue.events
        .filter((event) => event.at >= row.createdAt)
        .map((event) => ({ status: event.to, at: event.at.toISOString() })),
    ],
    photoCount: row.photoFileIds.length || 1,
  }));

  // Нерешённые сверху: это то, за чем куратор открыл список. Сортировка
  // стабильная, так что внутри каждой группы остаётся «сначала новые».
  items.sort((a, b) => Number(a.status === "RESOLVED") - Number(b.status === "RESOLVED"));

  return NextResponse.json({ items });
}
