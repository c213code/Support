import { prisma } from "@/lib/prisma";

// К какому тикету относится реплика агента, написанная БЕЗ Reply.
//
// Стрелка реплая закрывает 90 % случаев: в выгрузке четырёх групп из 1 316
// реплик вида "ауыстырылды"/"өшірілді" 1 189 отвечают на конкретное
// сообщение. Оставшиеся 127 раньше пропадали: бот брал тикет, только если
// в чате за день был открыт ровно один, а в Сервисе и Сату их всегда
// несколько.
//
// Эти 127 распадаются на два одинаково частых случая:
//   • 68 — реплика идёт сразу за сообщением клиента ("өшіріп бере аласыз
//     ба?" → "өшірілді");
//   • 59 — реплика идёт следом за своей же предыдущей ("Окей, қазір" в
//     18:34, "өшірілді" в 18:38).
//
// Отсюда порядок поиска ниже. А в 35 % случаев без стрелки в чате за
// последние полчаса писал не один человек — там гадать нельзя, и функция
// честно возвращает список кандидатов, чтобы бот спросил в личке.

// Окно поиска. Когда клиент в чате один, разрыв между его сообщением и
// репликой агента: медиана 4,5 минуты, 90-й перцентиль 19. Полчаса берём с
// запасом — дальше это уже другой разговор, а не задержка с ответом.
const WINDOW_MINUTES = 30;

// Сколько сообщений чата поднимаем за раз. За полчаса в рабочей группе их
// десятки; сотня — потолок на случай аврала.
const MAX_WINDOW_MESSAGES = 100;

// Сколько тикетов предлагаем на выбор, когда однозначно не выходит. Больше
// трёх кнопок в личке — это уже не подсказка, а форма.
const MAX_CANDIDATES = 3;

export type AgentTarget =
  | { kind: "found"; issueId: string; reason: "reply" | "own-thread" | "last-request" }
  | { kind: "ambiguous"; candidates: { id: string; description: string }[] }
  | { kind: "none" };

// Статусы, при которых тикет ещё "живой": закрытые в кандидаты не берём,
// иначе реплика по новому обращению уедет в решённое вчера.
const OPEN_STATUSES = ["SENT", "IN_PROGRESS", "PENDING", "ESCALATED"] as const;

export async function resolveAgentTarget(params: {
  chatId: string;
  messageId: number;
  replyToMessageId: number | null;
  agentTelegramId: bigint | null;
  sentAt: Date;
}): Promise<AgentTarget> {
  const { chatId, messageId, replyToMessageId, agentTelegramId, sentAt } = params;

  // 1. Стрелка реплая — самый точный признак, проверяется первым.
  if (replyToMessageId != null) {
    const replied = await prisma.telegramMessage.findUnique({
      where: { chatId_messageId: { chatId, messageId: replyToMessageId } },
      select: { usedForIssueId: true, agentIssueId: true },
    });
    // Ответ на своё же сообщение ведёт к тикету, который оно обсуждало.
    const target = replied?.usedForIssueId ?? replied?.agentIssueId ?? null;
    if (target) return { kind: "found", issueId: target, reason: "reply" };
  }

  const since = new Date(sentAt.getTime() - WINDOW_MINUTES * 60 * 1000);
  const window = await prisma.telegramMessage.findMany({
    where: {
      chatId,
      receivedAt: { gte: since, lte: sentAt },
      messageId: { not: messageId },
    },
    select: {
      messageId: true,
      fromId: true,
      text: true,
      usedForIssueId: true,
      agentIssueId: true,
      receivedAt: true,
    },
    orderBy: { receivedAt: "desc" },
    take: MAX_WINDOW_MESSAGES,
  });

  // Обращения в окне, у которых тикет ещё открыт. Считаем их до всех
  // решений: и "свой разговор", и "ближайшее обращение выше" опираются на
  // то, что здесь нашлось.
  const requests = window.filter(
    (m) => m.usedForIssueId != null && m.fromId !== agentTelegramId
  );
  const issueIds = Array.from(
    new Set(requests.map((m) => m.usedForIssueId).filter((id): id is string => id != null))
  );
  const openIssues = issueIds.length
    ? await prisma.issue.findMany({
        where: { id: { in: issueIds }, status: { in: [...OPEN_STATUSES] } },
        select: { id: true, description: true },
      })
    : [];
  const open = new Map(openIssues.map((i) => [i.id, i.description]));
  // window отсортировано от новых к старым, поэтому первое совпадение —
  // самое свежее.
  const openRequests = requests.filter(
    (m) => m.usedForIssueId != null && open.has(m.usedForIssueId)
  );

  // 2. Свой же разговор: последняя собственная реплика, про которую уже
  // известно, о каком тикете она была. Это случай "Окей, қазір" → через
  // четыре минуты "өшірілді": второе сообщение продолжает первое.
  //
  // Но только пока за это время не пришло НОВОЕ обращение: если после моей
  // реплики написал другой человек, моя следующая фраза с тем же успехом
  // отвечает ему, и "продолжаю свой разговор" превращается в догадку.
  // Тогда идём дальше и, если кандидатов несколько, спрашиваем.
  if (agentTelegramId != null) {
    const mine = window.find(
      (m) => m.fromId === agentTelegramId && m.agentIssueId != null
    );
    if (mine?.agentIssueId) {
      const interrupted = openRequests.some(
        (r) =>
          r.receivedAt > mine.receivedAt && r.usedForIssueId !== mine.agentIssueId
      );
      if (!interrupted) {
        return { kind: "found", issueId: mine.agentIssueId, reason: "own-thread" };
      }
    }
  }

  // 3. Ближайшее обращение выше — так же, как читает человек, открывший
  // чат: последнее, что написал клиент перед этой репликой.
  if (open.size === 0) return { kind: "none" };
  if (open.size === 1) {
    return { kind: "found", issueId: [...open.keys()][0], reason: "last-request" };
  }

  // Открытых тикетов в окне несколько. Ближайший по времени — правдоподобная
  // догадка, но именно правдоподобная: за полчаса в Сату успевают написать
  // трое, и ошибка уедет в репорт боссам. Поэтому не выбираем, а
  // возвращаем список — спросит человек.
  const ordered: { id: string; description: string }[] = [];
  for (const message of openRequests) {
    const id = message.usedForIssueId;
    if (!id || ordered.some((c) => c.id === id)) continue;
    ordered.push({ id, description: open.get(id) ?? "" });
    if (ordered.length === MAX_CANDIDATES) break;
  }
  return { kind: "ambiguous", candidates: ordered };
}
