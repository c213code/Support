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
// что сверху, это уже соседние разговоры в том же чате. Берём последние:
// решение — это конец разговора, а не его начало.
const MAX_AGENT_MESSAGES = 5;

// Сколько сообщений чата поднимаем за раз, чтобы разобрать цепочки ответов
// в памяти. За сутки в рабочей группе их сотни, но для окна "Как решили?"
// важен только участок вокруг обращения.
const MAX_WINDOW_MESSAGES = 300;

// На сколько звеньев идём вверх по цепочке ответов. Реальные цепочки
// короткие ("проблема → уточнение → ответ агента"); больше — уже не связь,
// а совпадение.
const MAX_REPLY_HOPS = 4;

export type ResolutionContext = {
  // Реплики наших агентов, относящиеся к тикету, в порядке написания.
  agentTexts: string[];
  // true — реплику удалось привязать к тикету по цепочке ответов (надёжно),
  // false — взята просто из окна времени (догадка). Влияет на то, что
  // показываем: по догадке подсказку помечаем как менее уверенную.
  exact: boolean;
};

// Почему подсказки не будет. Раньше на все случаи возвращался null, и окно
// "Как решили?" просто показывало "ИИ смотрит переписку…", а потом молча
// гасило строку — неотличимо от поломки. Причина нужна на экране: три из
// четырёх случаев чинит сам дежурный (включить тогл, вписать id, ответить
// в чате), а четвёртый — нормальная работа.
export type NoContextReason =
  // Не задан ни OWN_AGENT_TELEGRAM_IDS, ни AGENT_TELEGRAM_IDS — "своих"
  // сообщений в чате система не отличает вообще.
  | "no-agent-ids"
  // К тикету не привязано ни одного сообщения (заведён руками по ссылке).
  | "no-issue-messages"
  // В чате нет реплик наших агентов по этому обращению.
  | "no-agent-messages";

export type ResolutionContextResult =
  | { ok: true; context: ResolutionContext }
  | { ok: false; reason: NoContextReason };

export async function collectResolutionContext(
  issueId: string
): Promise<ResolutionContextResult> {
  const ownAgentIds = ownAgentTelegramIdList();
  if (ownAgentIds.length === 0) return { ok: false, reason: "no-agent-ids" };

  // Сообщения самого обращения: по ним знаем чат, автора и с какого момента
  // смотреть. Привязка — usedForIssueId (см. ATTACH_LINK_POLICY в вебхуке).
  const issueMessages = await prisma.telegramMessage.findMany({
    where: { usedForIssueId: issueId },
    select: { chatId: true, messageId: true, fromId: true, receivedAt: true },
    orderBy: { receivedAt: "asc" },
  });
  if (issueMessages.length === 0) {
    return { ok: false, reason: "no-issue-messages" };
  }

  const chatId = issueMessages[0].chatId;
  const since = new Date(
    issueMessages[0].receivedAt.getTime() - 60 * 60 * 1000
  );
  const until = new Date(since.getTime() + LOOKBACK_HOURS * 60 * 60 * 1000);
  const issueMessageIds = new Set(issueMessages.map((m) => m.messageId));
  // Кто написал обращение. Ответ агента на ЛЮБОЕ сообщение этого человека —
  // почти наверняка про его же тикет, даже если то сообщение само тикетом не
  // стало (типичный случай: прислал почту, которую мы попросили, — она
  // отсеивается как "одни учётные данные" и остаётся без usedForIssueId).
  const reporterIds = new Set(
    issueMessages
      .map((m) => m.fromId)
      .filter((id): id is bigint => id != null)
      .map((id) => id.toString())
  );

  // Весь срез чата за окно одним запросом: дальше цепочки ответов
  // разбираются в памяти. Так дешевле, чем ходить в базу за каждым звеном,
  // и, главное, позволяет пройти цепочку вверх — агент часто отвечает не на
  // сообщение с проблемой, а на последнее сообщение человека или на свою же
  // предыдущую реплику.
  const windowMessages = await prisma.telegramMessage.findMany({
    where: { chatId, receivedAt: { gte: since, lte: until } },
    select: {
      messageId: true,
      fromId: true,
      text: true,
      replyToMessageId: true,
      usedForIssueId: true,
      receivedAt: true,
    },
    orderBy: { receivedAt: "asc" },
    take: MAX_WINDOW_MESSAGES,
  });

  const byMessageId = new Map(windowMessages.map((m) => [m.messageId, m]));

  // К какому тикету относится сообщение человека, которое само тикетом не
  // стало (прислал почту, дописал подробность). Считаем, что оно продолжает
  // последнее, о чём этот же человек писал до него: берём его ближайшее
  // предыдущее сообщение с привязкой к тикету.
  //
  // Без этой оговорки правило "ответ на сообщение автора обращения = наш
  // тикет" разъезжается: один куратор за день заводит несколько обращений,
  // и реплика по второму подставлялась бы в первый.
  function issueOfLooseMessage(message: {
    fromId: bigint | null;
    receivedAt: Date;
  }): string | null {
    if (message.fromId == null) return null;
    const authorId = message.fromId.toString();
    let found: string | null = null;
    for (const candidate of windowMessages) {
      if (candidate.receivedAt > message.receivedAt) break;
      if (candidate.fromId?.toString() !== authorId) continue;
      if (candidate.usedForIssueId) found = candidate.usedForIssueId;
    }
    return found;
  }
  const ownAgentIdSet = new Set(ownAgentIds.map((id) => id.toString()));

  // Кому принадлежит реплика агента: "ours" — этому тикету, "other" — другому
  // (её подставлять нельзя), "unknown" — по цепочке не понять.
  //
  // Идём вверх по replyToMessageId максимум MAX_REPLY_HOPS звеньев. Реальные
  // цепочки короткие ("проблема → уточнение → ответ агента"), а ограничение
  // защищает от кольца, если Telegram отдаст неожиданную пару id.
  function ownerOf(message: { replyToMessageId: number | null }): "ours" | "other" | "unknown" {
    let cursor = message.replyToMessageId;
    for (let hop = 0; cursor != null && hop < MAX_REPLY_HOPS; hop++) {
      if (issueMessageIds.has(cursor)) return "ours";

      const target = byMessageId.get(cursor);
      if (!target) return "unknown";
      if (target.usedForIssueId) {
        return target.usedForIssueId === issueId ? "ours" : "other";
      }
      // Ответ на сообщение автора обращения, которое само тикетом не стало.
      // Куда его отнести, решает предыдущая привязка этого же человека.
      if (target.fromId != null && reporterIds.has(target.fromId.toString())) {
        const owner = issueOfLooseMessage(target);
        if (owner) return owner === issueId ? "ours" : "other";
      }
      cursor = target.replyToMessageId;
    }
    return "unknown";
  }

  const agentMessages = windowMessages.filter(
    (m) => m.fromId != null && ownAgentIdSet.has(m.fromId.toString())
  );

  const linked: string[] = [];
  const loose: string[] = [];
  for (const message of agentMessages) {
    const text = message.text?.trim();
    if (!text) continue;
    const owner = ownerOf(message);
    if (owner === "ours") linked.push(text);
    // "other" отбрасываем совсем: за час в чате проходит несколько обращений,
    // и решение соседнего тикета в нашей заметке — прямая ошибка в репорте.
    else if (owner === "unknown") loose.push(text);
  }

  // Привязанные по цепочке — надёжно. Ничем не привязанные реплики берём,
  // только если надёжных нет вовсе: это уже догадка, и в окне она помечается
  // иначе ("собрано по переписке", а не "из твоего ответа").
  if (linked.length > 0) {
    return {
      ok: true,
      context: { agentTexts: linked.slice(-MAX_AGENT_MESSAGES), exact: true },
    };
  }
  if (loose.length > 0) {
    return {
      ok: true,
      context: { agentTexts: loose.slice(-MAX_AGENT_MESSAGES), exact: false },
    };
  }

  return { ok: false, reason: "no-agent-messages" };
}
