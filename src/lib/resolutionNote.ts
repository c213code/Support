import { prisma } from "@/lib/prisma";
import { ownAgentTelegramIdList } from "@/lib/telegram";

// Заметка "как решили" уходит прямо в репорт боссам, и к вечеру уже никто
// не помнит, чем закончилось обращение. Но ответ там почти всегда уже
// написан — своими же руками, в рабочем чате: "жасалды", "админкадан
// өшіріп бердік, қайта кірсін". Дежурному остаётся набрать то же самое
// второй раз, теперь для репорта.
//
// Этот модуль достаёт из истории чата реплики агентов, относящиеся к
// конкретному тикету, чтобы из них можно было собрать готовую заметку (см.
// summarizeResolutionNote в lib/ai.ts). Ничего не решает сам: агент видит
// подсказку в окне "Как решили?" и правит её, прежде чем она уйдёт в репорт.

// Реплики агента ищем в пределах того же дня и с запасом по времени: тикет
// живёт день (reportDate), а решают его обычно в течение часов. Более
// старое — уже другая история в том же чате.
const LOOKBACK_HOURS = 24;

// Сколько реплик отдаём модели. Обычно решение — одно-два сообщения; всё,
// что сверху, это уже соседние разговоры в том же чате.
const MAX_AGENT_MESSAGES = 5;

export type ResolutionContext = {
  // Реплики наших агентов, относящиеся к тикету, в порядке написания.
  agentTexts: string[];
  // true — нашли по точному Telegram Reply на сообщение тикета (надёжно),
  // false — по времени/чату (догадка). Влияет на то, что показываем: по
  // догадке подсказку помечаем как менее уверенную.
  exact: boolean;
};

export async function collectResolutionContext(
  issueId: string
): Promise<ResolutionContext | null> {
  const ownAgentIds = ownAgentTelegramIdList();
  if (ownAgentIds.length === 0) return null;

  // Сообщения самого обращения: по ним знаем чат и с какого момента
  // смотреть. Привязка — usedForIssueId (см. ATTACH_LINK_POLICY в вебхуке).
  const issueMessages = await prisma.telegramMessage.findMany({
    where: { usedForIssueId: issueId },
    select: { chatId: true, messageId: true, receivedAt: true },
    orderBy: { receivedAt: "asc" },
  });
  if (issueMessages.length === 0) return null;

  const chatId = issueMessages[0].chatId;
  const since = new Date(
    issueMessages[0].receivedAt.getTime() - 60 * 60 * 1000
  );
  const until = new Date(since.getTime() + LOOKBACK_HOURS * 60 * 60 * 1000);
  const issueMessageIds = issueMessages.map((m) => m.messageId);

  // Точное попадание: агент ответил Telegram-реплаем на сообщение этого
  // тикета. Тут гадать не о чем — это реплика ровно по этому обращению.
  const exactReplies = await prisma.telegramMessage.findMany({
    where: {
      chatId,
      fromId: { in: ownAgentIds },
      replyToMessageId: { in: issueMessageIds },
    },
    select: { text: true },
    orderBy: { receivedAt: "asc" },
    take: MAX_AGENT_MESSAGES,
  });

  const exactTexts = exactReplies
    .map((m) => m.text?.trim())
    .filter((t): t is string => Boolean(t));
  if (exactTexts.length > 0) return { agentTexts: exactTexts, exact: true };

  // Реплая нет — берём то, что агенты писали в этом чате после обращения.
  // Это уже догадка: в чате могли параллельно обсуждать соседний тикет.
  // Поэтому помечаем exact = false, а решение всё равно за человеком.
  const nearby = await prisma.telegramMessage.findMany({
    where: {
      chatId,
      fromId: { in: ownAgentIds },
      receivedAt: { gte: issueMessages[0].receivedAt, lte: until },
    },
    select: { text: true },
    orderBy: { receivedAt: "asc" },
    take: MAX_AGENT_MESSAGES,
  });

  const nearbyTexts = nearby
    .map((m) => m.text?.trim())
    .filter((t): t is string => Boolean(t));
  if (nearbyTexts.length === 0) return null;

  return { agentTexts: nearbyTexts, exact: false };
}
