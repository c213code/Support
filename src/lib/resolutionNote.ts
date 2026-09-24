import { telegramIdToAgent } from "@/lib/agentTelegram";
import { prisma } from "@/lib/prisma";
import { ownAgentTelegramIdList, QUOTE_MAX_LENGTH } from "@/lib/telegram";
import { maskSensitiveForAi } from "@/lib/textClean";

// В TelegramMessage.text ответ стрелкой хранится вместе с цитатой того, на
// что ответили: "↩️ Автор: цитата\nсвой текст" (extractReplyContextLine в
// lib/telegram.ts). Во «Входящих» это нужно — без цитаты реплика нечитаема.
// А модели для заметки — вредно: цитата — это чаще всего просьба куратора
// ("почтаға ауыстырсаңыз"), и модель пересказывала её ("Почтасы
// ауыстырылды") вместо того, что ответил агент. На копии прода с цитатой
// хранятся три реплики агентов из четырёх.
//
// quoted — исходный текст сообщения, на которое ответили (как его прислал
// Telegram, без собственной цитаты), если он известен.
export function stripReplyQuote(text: string, quoted: string | null): string {
  if (!text.startsWith("↩️ ")) return text;
  if (quoted) {
    const shown =
      quoted.length > QUOTE_MAX_LENGTH ? `${quoted.slice(0, QUOTE_MAX_LENGTH)}…` : quoted;
    const marker = `: ${shown}\n`;
    const at = text.indexOf(marker);
    if (at !== -1) return text.slice(at + marker.length).trim();
  }

  // Начало цитаты — сразу после "↩️ Автор: ".
  const colon = text.indexOf(": ");
  if (colon !== -1) {
    const quoteStart = colon + 2;

    // Длинная цитата обрезана ровно до QUOTE_MAX_LENGTH и помечена "…".
    const cut = quoteStart + QUOTE_MAX_LENGTH;
    if (text[cut] === "…" && text[cut + 1] === "\n") {
      return text.slice(cut + 2).trim();
    }

  }

  // Сохранённый текст сообщения, на которое ответили, не всегда совпадает с
  // тем, что процитировал Telegram, символ в символ: вебхук склеивает серию
  // сообщений одного человека (5 минут), и у первого сообщения серии в базе —
  // вся серия, а цитата — только его текст; бывают расхождения в пробелах; в
  // имени автора бывает своё двоеточие. Поэтому не сравниваем посимвольно, а
  // снимаем строки: цитата состоит из строк того сообщения, и ответ агента
  // начинается с первой строки, которой в нём нет.
  if (quoted) {
    const quotedLines = quoted.split("\n").map((l) => l.trim()).filter(Boolean);
    const isQuoteLine = (line: string) => {
      const t = line.trim();
      if (!t) return true;
      if (quotedLines.includes(t)) return true;
      // Последняя строка длинной цитаты обрезана и помечена "…".
      return t.endsWith("…") && quotedLines.some((l) => l.startsWith(t.slice(0, -1)));
    };
    const lines = text.split("\n");
    // Первая строка — "↩️ Автор: первая строка цитаты"; с какого двоеточия
    // начинается цитата, не гадаем: достаточно, что строка ею кончается.
    const first = lines[0].trim();
    const firstIsQuote =
      quotedLines.some((l) => first.endsWith(l)) ||
      (first.endsWith("…") && quotedLines.some((l) => first.includes(`: ${l.slice(0, 20)}`)));
    if (firstIsQuote) {
      let i = 1;
      while (i < lines.length && isQuoteLine(lines[i])) i++;
      const own = lines.slice(i).join("\n").trim();
      if (own) return own;
    }
  }

  // Исходный текст неизвестен (сообщение не сохранилось) — цитата в одну
  // строку, как почти всегда: отрезаем первую строку.
  const newline = text.indexOf("\n");
  return newline === -1 ? "" : text.slice(newline + 1).trim();
}

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

// На сколько звеньев идём вверх по цепочке ответов. Реальные цепочки
// короткие ("проблема → уточнение → ответ агента"); больше — уже не связь,
// а совпадение.
const MAX_REPLY_HOPS = 4;

// Строка общей ленты переписки: кто сказал и что.
export type ThreadLine = { from: "agent" | "curator"; text: string };

export type ResolutionContext = {
  // Реплики наших агентов, относящиеся к тикету, в порядке написания.
  agentTexts: string[];
  // Реплики агентов вместе с ответами автора обращения, по времени. Нужна
  // вечернему разбору: итог часто пишет сам куратор («Методист ашып
  // берді», «шешілді, рахмет»), а по одним репликам агентов разговор
  // выглядит оборванным вопросом.
  thread: ThreadLine[];
  // Кто ответил в чате — автор последней реплики, надёжно привязанной к
  // тикету. Его имя, а не того, кто перетащил карточку, идёт в «X шешті»:
  // закрыть мог Ерош, а ответить — Алпа. У догадки по окну времени (exact:
  // false) автора нет — ошибиться с именем в отчёте боссам хуже, чем
  // оставить того, кто закрыл.
  resolver: { fromId: bigint | null; authorName: string | null } | null;
  // true — реплику удалось привязать к тикету (надёжно), false — взята
  // просто из окна времени (догадка). Влияет на то, что показываем: по
  // догадке подсказку помечаем как менее уверенную.
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

type ChatMessage = {
  messageId: number;
  fromId: bigint | null;
  authorName: string | null;
  text: string | null;
  replyToMessageId: number | null;
  usedForIssueId: string | null;
  agentIssueId: string | null;
  receivedAt: Date;
};

const MESSAGE_FIELDS = {
  messageId: true,
  fromId: true,
  authorName: true,
  text: true,
  replyToMessageId: true,
  usedForIssueId: true,
  agentIssueId: true,
  receivedAt: true,
} as const;

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
  // Тикет из формы входящих сообщений не имеет вовсе: в группе он — пост
  // бота «Өтініш #…» (BotReply), и дежурный отвечает стрелкой на него.
  // Раньше здесь сразу сдавались с «к тикету не привязано сообщение из
  // чата», хотя ответ в чате был. Теперь опорой служит сам пост: из него
  // чат и время, а ответ на него находит цепочка ответов ниже (ownerOf).
  let anchor: { chatId: string; at: Date } | null = issueMessages[0]
    ? { chatId: issueMessages[0].chatId, at: issueMessages[0].receivedAt }
    : null;
  if (!anchor) {
    const post = await prisma.botReply.findFirst({
      where: { issueId, deleted: false },
      orderBy: { sentAt: "asc" },
      select: { chatId: true, sentAt: true },
    });
    if (post) anchor = { chatId: post.chatId, at: post.sentAt };
  }
  if (!anchor) {
    return { ok: false, reason: "no-issue-messages" };
  }

  const chatId = anchor.chatId;
  const since = new Date(anchor.at.getTime() - 60 * 60 * 1000);
  const until = new Date(since.getTime() + LOOKBACK_HOURS * 60 * 60 * 1000);
  const issueMessageIds = new Set(issueMessages.map((m) => m.messageId));
  // Кто написал обращение. Ответ агента на ЛЮБОЕ сообщение этого человека —
  // почти наверняка про его же тикет, даже если то сообщение само тикетом не
  // стало (типичный случай: прислал почту, которую мы попросили, — она
  // отсеивается как "одни учётные данные" и остаётся без usedForIssueId).
  const reporterIds = issueMessages
    .map((m) => m.fromId)
    .filter((id): id is bigint => id != null);
  const reporterIdSet = new Set(reporterIds.map((id) => id.toString()));

  // Реплики агентов берём прицельно, а не срезом всего чата: раньше
  // поднимались первые 300 сообщений окна, и в оживлённой группе ответ,
  // написанный через пару часов, просто не доезжал до разбора — подсказка
  // говорила "в чате нет твоих ответов", хотя ответ был.
  //
  // Плюс все реплики, которые вебхук уже привязал к этому тикету
  // (agentIssueId), даже вне окна: он решал это в момент сообщения — по
  // стрелке, по своему разговору, по ближайшему обращению (lib/agentThread.ts).
  const [windowAgentMessages, linkedByWebhook, reporterMessages, botReplies] =
    await Promise.all([
      prisma.telegramMessage.findMany({
        where: {
          chatId,
          receivedAt: { gte: since, lte: until },
          fromId: { in: ownAgentIds },
        },
        select: MESSAGE_FIELDS,
      }),
      prisma.telegramMessage.findMany({
        where: { agentIssueId: issueId, fromId: { in: ownAgentIds } },
        select: MESSAGE_FIELDS,
      }),
      reporterIds.length > 0
        ? prisma.telegramMessage.findMany({
            where: { chatId, receivedAt: { lte: until }, fromId: { in: reporterIds } },
            select: MESSAGE_FIELDS,
            orderBy: { receivedAt: "asc" },
          })
        : Promise.resolve([] as ChatMessage[]),
      // Сообщения самого бота ("жақсы, қарап береміз"). Telegram не шлёт их
      // вебхуку, в TelegramMessage их нет — но BotReply помнит, к какому
      // тикету каждое. Агент часто отвечает стрелкой именно на них.
      prisma.botReply.findMany({
        where: { chatId },
        select: { messageId: true, issueId: true, text: true },
      }),
    ]);

  const agentMessages = new Map<number, ChatMessage>();
  for (const message of [...windowAgentMessages, ...linkedByWebhook]) {
    agentMessages.set(message.messageId, message);
  }
  const botMessageIssue = new Map(botReplies.map((b) => [b.messageId, b.issueId]));
  const botMessageText = new Map(botReplies.map((b) => [b.messageId, b.text]));

  // Звенья цепочек ответов, до которых идём вверх, подгружаем по id — сколько
  // нужно, а не заранее весь чат.
  const known = new Map<number, ChatMessage>();
  for (const message of [...agentMessages.values(), ...reporterMessages]) {
    known.set(message.messageId, message);
  }
  let pending = [...agentMessages.values()].map((m) => m.replyToMessageId);
  for (let hop = 0; hop < MAX_REPLY_HOPS; hop++) {
    const missing = [
      ...new Set(
        pending.filter(
          (id): id is number =>
            id != null && !known.has(id) && !botMessageIssue.has(id)
        )
      ),
    ];
    if (missing.length === 0) break;
    const fetched = await prisma.telegramMessage.findMany({
      where: { chatId, messageId: { in: missing } },
      select: MESSAGE_FIELDS,
    });
    for (const message of fetched) known.set(message.messageId, message);
    pending = fetched.map((m) => m.replyToMessageId);
  }

  // К какому тикету относится сообщение человека, которое само тикетом не
  // стало (прислал почту, дописал подробность). Считаем, что оно продолжает
  // последнее, о чём этот же человек писал до него: берём его ближайшее
  // предыдущее сообщение с привязкой к тикету.
  //
  // Без этой оговорки правило "ответ на сообщение автора обращения = наш
  // тикет" разъезжается: один куратор за день заводит несколько обращений,
  // и реплика по второму подставлялась бы в первый.
  function issueOfLooseMessage(message: ChatMessage): string | null {
    if (message.fromId == null) return null;
    const authorId = message.fromId.toString();
    let found: string | null = null;
    for (const candidate of reporterMessages) {
      if (candidate.receivedAt > message.receivedAt) break;
      if (candidate.fromId?.toString() !== authorId) continue;
      if (candidate.usedForIssueId) found = candidate.usedForIssueId;
    }
    return found;
  }

  // Кому принадлежит реплика агента: "ours" — этому тикету, "other" — другому
  // (её подставлять нельзя), "unknown" — не понять.
  function ownerOf(message: ChatMessage): "ours" | "other" | "unknown" {
    // Решение вебхука — первым: оно принято в момент сообщения и учитывает
    // то, чего цепочка ответов не видит, — реплику без стрелки, которая
    // продолжает свой же разговор ("қазір қараймын" → "өшірілді").
    if (message.agentIssueId) {
      return message.agentIssueId === issueId ? "ours" : "other";
    }

    // Иначе идём вверх по replyToMessageId максимум MAX_REPLY_HOPS звеньев.
    // Реальные цепочки короткие, а ограничение защищает от кольца, если
    // Telegram отдаст неожиданную пару id.
    let cursor = message.replyToMessageId;
    for (let hop = 0; cursor != null && hop < MAX_REPLY_HOPS; hop++) {
      if (issueMessageIds.has(cursor)) return "ours";

      const botIssue = botMessageIssue.get(cursor);
      if (botIssue) return botIssue === issueId ? "ours" : "other";

      const target = known.get(cursor);
      if (!target) return "unknown";
      if (target.usedForIssueId) {
        return target.usedForIssueId === issueId ? "ours" : "other";
      }
      if (target.agentIssueId) {
        return target.agentIssueId === issueId ? "ours" : "other";
      }
      // Ответ на сообщение автора обращения, которое само тикетом не стало.
      // Куда его отнести, решает предыдущая привязка этого же человека.
      if (target.fromId != null && reporterIdSet.has(target.fromId.toString())) {
        const owner = issueOfLooseMessage(target);
        if (owner) return owner === issueId ? "ours" : "other";
      }
      cursor = target.replyToMessageId;
    }
    return "unknown";
  }

  const ordered = [...agentMessages.values()].sort(
    (a, b) => a.receivedAt.getTime() - b.receivedAt.getTime()
  );
  const linked: string[] = [];
  const linkedMessages: { message: ChatMessage; text: string }[] = [];
  const loose: string[] = [];
  // Исходный текст сообщения, на которое ответили: у сохранённого сообщения
  // в базе может быть своя цитата — срезаем и её, Telegram цитирует без неё.
  function quotedTextOf(message: ChatMessage): string | null {
    const replyTo = message.replyToMessageId;
    if (replyTo == null) return null;
    const bot = botMessageText.get(replyTo);
    if (bot != null) return bot;
    const target = known.get(replyTo);
    if (!target?.text) return null;
    return stripReplyQuote(target.text, null);
  }

  let lastLinked: ChatMessage | null = null;
  for (const message of ordered) {
    // Реплики уходят внешней модели — почты, телефоны и пароли маскируем.
    const text = message.text
      ? maskSensitiveForAi(stripReplyQuote(message.text, quotedTextOf(message)))
      : "";
    if (!text) continue;
    const owner = ownerOf(message);
    if (owner === "ours") {
      linked.push(text);
      linkedMessages.push({ message, text });
      lastLinked = message;
    }
    // "other" отбрасываем совсем: за час в чате проходит несколько обращений,
    // и решение соседнего тикета в нашей заметке — прямая ошибка в репорте.
    else if (owner === "unknown") loose.push(text);
  }

  // Привязанные — надёжно. Ничем не привязанные реплики берём, только если
  // надёжных нет вовсе: это уже догадка, и в окне она помечается иначе
  // ("собрано по переписке", а не "из твоего ответа").
  if (linked.length > 0) {
    // Ответы куратора — только после первой нашей реплики (до неё идёт само
    // обращение, оно уже в описании) и только те, что про этот тикет
    // наверняка: привязанные к нему или ответ стрелкой на реплику по нему.
    // Сообщения без стрелки не берём: куратор за день пишет несколько
    // обращений подряд, и следующее его обращение читалось бы как ответ по
    // этому («Тс осылай ашылмай тұр» после «Методист ашып берді»).
    const agentIdSet = new Set(ownAgentIds.map((id) => id.toString()));
    const firstAt = linkedMessages[0].message.receivedAt;
    const curatorLines: { message: ChatMessage; text: string }[] = [];
    for (const message of reporterMessages) {
      if (message.receivedAt <= firstAt || !message.text) continue;
      if (message.fromId != null && agentIdSet.has(message.fromId.toString())) continue;
      const belongs =
        message.usedForIssueId != null
          ? message.usedForIssueId === issueId
          : message.replyToMessageId != null && ownerOf(message) === "ours";
      if (!belongs) continue;
      const text = maskSensitiveForAi(stripReplyQuote(message.text, quotedTextOf(message)));
      if (text) curatorLines.push({ message, text });
    }
    const thread: ThreadLine[] = [
      ...linkedMessages.map((l) => ({ ...l, from: "agent" as const })),
      ...curatorLines.map((l) => ({ ...l, from: "curator" as const })),
    ]
      .sort((a, b) => a.message.receivedAt.getTime() - b.message.receivedAt.getTime())
      .slice(-MAX_AGENT_MESSAGES * 2)
      .map(({ from, text }) => ({ from, text }));
    return {
      ok: true,
      context: {
        agentTexts: linked.slice(-MAX_AGENT_MESSAGES),
        thread,
        exact: true,
        resolver: lastLinked
          ? { fromId: lastLinked.fromId, authorName: lastLinked.authorName }
          : null,
      },
    };
  }
  if (loose.length > 0) {
    return {
      ok: true,
      context: {
        agentTexts: loose.slice(-MAX_AGENT_MESSAGES),
        thread: loose.slice(-MAX_AGENT_MESSAGES).map((text) => ({ from: "agent" as const, text })),
        exact: false,
        resolver: null,
      },
    };
  }

  return { ok: false, reason: "no-agent-messages" };
}

// Как назвать того, кто ответил, в «X шешті». Сначала — имя аккаунта по его
// Telegram-id («Алпа»), как пишут в отчёте. Если id не сопоставлен
// (сменный под «Дежурным», или AGENT_TELEGRAM_IDS не заполнен) — имя из
// Telegram до первой «|»: у своих оно вида «Тикош | сервис қолдау», и в
// отчёт должно попасть «Тикош», а не должность.
export function resolverName(context: ResolutionContext): string | null {
  const resolver = context.resolver;
  if (!resolver) return null;
  if (resolver.fromId != null) {
    const agent = telegramIdToAgent(Number(resolver.fromId));
    if (agent) return agent;
  }
  const shown = resolver.authorName?.split("|")[0]?.trim();
  return shown || null;
}
