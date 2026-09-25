import { prisma } from "@/lib/prisma";
import { ownAgentTelegramIdList } from "@/lib/telegram";

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

// Сколько звеньев цепочки реплаев проходим вверх в поисках тикета. Реальные
// цепочки короткие; предел защищает от кольца.
const MAX_REPLY_HOPS = 4;

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
  //
  // Идём вверх по цепочке реплаев, пока не найдём сообщение с тикетом: ответ
  // куратора на нашу реплику сам к тикету не привязан, и «жөнделді» реплаем
  // на него (25.09, тикет Мадины от 23.09) раньше не находил тикета вовсе —
  // хотя двумя звеньями выше стояла наша реплика по нему.
  let cursor = replyToMessageId;
  for (let hop = 0; cursor != null && hop < MAX_REPLY_HOPS; hop++) {
    const replied = await prisma.telegramMessage.findUnique({
      where: { chatId_messageId: { chatId, messageId: cursor } },
      select: { usedForIssueId: true, agentIssueId: true, replyToMessageId: true },
    });
    // Ответ на своё же сообщение ведёт к тикету, который оно обсуждало.
    const target = replied?.usedForIssueId ?? replied?.agentIssueId ?? null;
    if (target) return { kind: "found", issueId: target, reason: "reply" };

    // Ответ на сообщение самого бота. Их нет в TelegramMessage — Telegram не
    // присылает боту его же сообщения, — но BotReply помнит, к какому тикету
    // каждое. Так устроен весь тикет из формы: в группе он и есть пост бота
    // «Өтініш #…», и дежурный отвечает стрелкой именно на него. Раньше такой
    // ответ ни к чему не привязывался, и «Как решили?» его не видела.
    const botPost = await prisma.botReply.findUnique({
      where: { chatId_messageId: { chatId, messageId: cursor } },
      select: { issueId: true },
    });
    if (botPost) return { kind: "found", issueId: botPost.issueId, reason: "reply" };
    cursor = replied?.replyToMessageId ?? null;
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

  // Клиенты — все, кто не агент. Нужны, чтобы заметить обращение, по
  // которому тикет НЕ завёлся: 24.09 в Сервисе второй куратор спросил про
  // ошибку со скриншотом, тикета не было, и ответ ему уехал в тикет первого
  // куратора — «свой разговор» и «ближайшее обращение» видели только
  // сообщения с тикетом.
  const agents = new Set(ownAgentTelegramIdList());
  if (agentTelegramId != null) agents.add(agentTelegramId);
  const clientMessages = window.filter((m) => m.fromId != null && !agents.has(m.fromId));
  const openAuthors = new Set(openRequests.map((m) => m.fromId));

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
      const authors = new Set(
        (
          await prisma.telegramMessage.findMany({
            where: { usedForIssueId: mine.agentIssueId, fromId: { not: null } },
            distinct: ["fromId"],
            select: { fromId: true },
          })
        ).map((m) => m.fromId)
      );
      // Прервал любой клиент, кроме автора этого тикета, — даже если по его
      // сообщению тикета нет: моя следующая фраза может отвечать ему.
      const interrupted = clientMessages.some(
        (m) =>
          m.receivedAt > mine.receivedAt &&
          !authors.has(m.fromId) &&
          m.usedForIssueId !== mine.agentIssueId
      );
      if (!interrupted) {
        return { kind: "found", issueId: mine.agentIssueId, reason: "own-thread" };
      }
    }
  }

  // 3. Ближайшее обращение выше — так же, как читает человек, открывший
  // чат: последнее, что написал клиент перед этой репликой.
  if (open.size === 0) return { kind: "none" };
  // Последним написал клиент, у которого тикета нет (и он не автор ни одного
  // открытого) — агент, скорее всего, отвечает ему. Подставить сюда
  // единственный открытый тикет — значит приписать ему чужой разговор.
  const lastClient = clientMessages[0];
  if (lastClient && lastClient.usedForIssueId == null && !openAuthors.has(lastClient.fromId)) {
    return { kind: "none" };
  }
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
