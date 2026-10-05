import { prisma } from "@/lib/prisma";
import { parseMessageLink } from "@/lib/botMessageDelete";
import {
  buildMessageLink,
  editMessageText,
  type TelegramEntity,
  type TelegramMessagePayload,
} from "@/lib/telegram";
import { devChatId, devMemberAnywhere, teamForTopic, type DevMember } from "@/lib/devTeams";
import { isAgentTelegramId, telegramIdToAgent } from "@/lib/agentTelegram";
import { isChatIntentEnabled } from "@/lib/settings";
import { changeIssueStatus } from "@/lib/issueStatus";
import { escalationNote } from "@/lib/escalation";

// Ручная передача разработчикам: агент пишет в топик команды в чате
// разработчиков «@разраб <ссылка на сообщение куратора> пара слов» — бот
// узнаёт по ссылке тикет и отмечает, что он передан. Тогда (а) сам бот
// передачу уже не повторит (Issue.handoffLink), (б) статус становится
// «Передано» с командой по топику и человеком по отметке — вечером не надо
// проставлять заново то, что уже сделано.

const LINK_IN_TEXT = /(?:https?:\/\/)?(?:t|telegram)\.me\/c\/\d+\/(?:\d+\/)?\d+/gi;
// Сообщения куратора, которые склеились в одно (окно 5 минут в вебхуке),
// своих строк не имеют — ищем соседей не дальше стольких сообщений назад.
const MERGED_NEIGHBOUR_SPAN = 15;
// Тот же человек в серии сообщений: «Сәлем» → скрин → «шықпай тұр».
const SAME_AUTHOR_WINDOW_MS = 10 * 60 * 1000;

type LinkTarget = { chatId: string; messageId: number };

function entityText(text: string, e: TelegramEntity): string {
  return text.slice(e.offset, e.offset + e.length);
}

// Ссылки на сообщения в группах поддержки — из текста и из-под слов
// (text_link). Ссылки на сам чат разработчиков — внутренние, не обращения.
export function extractSupportLinks(text: string, entities: TelegramEntity[] = []): LinkTarget[] {
  const raw = [
    ...(text.match(LINK_IN_TEXT) ?? []),
    ...entities.filter((e) => e.type === "text_link" && e.url).map((e) => e.url!),
  ];
  const devChat = devChatId();
  const seen = new Map<string, LinkTarget>();
  for (const link of raw) {
    const target = parseMessageLink(link);
    if (!target || target.chatId === devChat) continue;
    seen.set(`${target.chatId}:${target.messageId}`, target);
  }
  return [...seen.values()];
}

// Ежедневная сводка саппорта в чате разработчиков — много ссылок и строки
// «Статус: …». Это не передача, а отчёт, и менять по ней статусы нельзя.
export function isStatusDigest(text: string, links: LinkTarget[]): boolean {
  return links.length > 2 || /^\s*Статус\s*:/im.test(text);
}

// По ссылке на сообщение в группе поддержки — тикет, к которому оно
// относится. Агент нередко ссылается не на первое сообщение (с него завёлся
// тикет), а на то, где скриншот или суть, — поэтому не только точное
// совпадение.
export async function resolveSupportLink(target: LinkTarget): Promise<string | null> {
  const { chatId, messageId } = target;
  const row = await prisma.telegramMessage.findUnique({
    where: { chatId_messageId: { chatId, messageId } },
    select: { usedForIssueId: true, fromId: true, receivedAt: true },
  });
  if (row?.usedForIssueId) return row.usedForIssueId;

  // Пост бота «Өтініш #…» по заявке из мини-аппа.
  const post = await prisma.botReply.findFirst({
    where: { chatId, messageId },
    select: { issueId: true },
  });
  if (post) return post.issueId;

  const link = buildMessageLink(Number(chatId), messageId);
  const byLink = await prisma.issue.findFirst({
    where: { OR: [{ telegramLink: link }, { extraLinks: { has: link } }] },
    select: { id: true },
  });
  if (byLink) return byLink.id;

  // Сообщение сохранено, но к тикету не привязано: пришло в серии до того,
  // как тикет завёлся. Тикет того же автора по соседству — тот самый.
  // Соседа ищем по номеру сообщения, а не по времени: серия идёт подряд, а за
  // те же 10 минут куратор мог написать и о второй проблеме. Предыдущее
  // сообщение ближе по смыслу, чем следующее, — с него серия и началась.
  if (row?.fromId) {
    const near = await prisma.telegramMessage.findMany({
      where: {
        chatId,
        fromId: row.fromId,
        usedForIssueId: { not: null },
        receivedAt: {
          gte: new Date(row.receivedAt.getTime() - SAME_AUTHOR_WINDOW_MS),
          lte: new Date(row.receivedAt.getTime() + SAME_AUTHOR_WINDOW_MS),
        },
      },
      select: { usedForIssueId: true, messageId: true },
    });
    const distance = (id: number) => (id < messageId ? messageId - id : (id - messageId) * 2);
    near.sort((a, b) => distance(a.messageId) - distance(b.messageId));
    return near[0]?.usedForIssueId ?? null;
  }

  // Своей строки нет вовсе — сообщение склеилось с предыдущим того же
  // человека. Автора мы не знаем, поэтому берём соседей, только если все
  // они про один и тот же тикет: два разных — уже гадание.
  if (!row) {
    const neighbours = await prisma.telegramMessage.findMany({
      where: {
        chatId,
        messageId: { gte: messageId - MERGED_NEIGHBOUR_SPAN, lt: messageId },
        usedForIssueId: { not: null },
      },
      select: { usedForIssueId: true },
    });
    const ids = new Set(neighbours.map((n) => n.usedForIssueId!));
    if (ids.size === 1) return [...ids][0];
  }
  return null;
}

// Кого отметили: text_mention несёт id сразу, @username — узнаём по своим же
// сообщениям из чата разработчиков (TelegramMessage.fromUsername).
async function mentionedMembers(text: string, entities: TelegramEntity[]): Promise<DevMember[]> {
  const ids = new Set<number>();
  for (const e of entities) {
    if (e.type === "text_mention" && e.user) ids.add(e.user.id);
  }
  const usernames = entities
    .filter((e) => e.type === "mention")
    .map((e) => entityText(text, e).replace(/^@/, ""))
    .filter(Boolean);
  const devChat = devChatId();
  if (usernames.length > 0 && devChat) {
    const authors = await prisma.telegramMessage.findMany({
      where: {
        chatId: devChat,
        fromUsername: { in: usernames, mode: "insensitive" },
        fromId: { not: null },
      },
      distinct: ["fromUsername"],
      select: { fromId: true },
    });
    for (const a of authors) ids.add(Number(a.fromId));
  }
  return [...ids].map(devMemberAnywhere).filter((m): m is DevMember => m !== null);
}

// Агент передал сам — черновик бота (lib/handoffDraft.ts) снимается, чтобы
// бот не повторил в чате разработчиков то, что там уже прозвучало.
async function cancelPendingHandoff(issueId: string, manualLink: string): Promise<void> {
  const row = await prisma.pendingHandoff.findUnique({ where: { issueId } });
  if (!row) return;
  await prisma.pendingHandoff.delete({ where: { id: row.id } });
  await editMessageText(
    row.chatId,
    row.messageId,
    `✅ Уже передано вручную: ${manualLink}\nЧерновик бота не отправлен.`,
    null
  );
}

export function devMessageLink(message: TelegramMessagePayload): string {
  const base = buildMessageLink(message.chat.id, message.message_id);
  if (!message.message_thread_id) return base;
  return base.replace(/\/(\d+)$/, `/${message.message_thread_id}/$1`);
}

export async function detectManualHandoff(
  message: TelegramMessagePayload,
  ownText: string
): Promise<void> {
  const entities = message.entities ?? message.caption_entities ?? [];
  const links = extractSupportLinks(ownText, entities);
  if (links.length === 0 || isStatusDigest(ownText, links)) return;

  const issueIds = new Set<string>();
  for (const link of links) {
    const issueId = await resolveSupportLink(link);
    if (issueId) issueIds.add(issueId);
  }
  if (issueIds.size === 0) return;

  const authorId = message.from?.id;
  // Ссылку на передачу ставим от кого угодно — разработчики о тикете уже
  // знают. А статус меняем только по слову нашего агента: разработчик,
  // который просто цитирует ссылку («у тебя воспроизводится?»), тикет никуда
  // не передаёт.
  const fromAgent = authorId != null && isAgentTelegramId(authorId);
  const canChangeStatus = fromAgent && (await isChatIntentEnabled());
  const topicTeam = teamForTopic(message.message_thread_id);
  const mentioned = canChangeStatus ? await mentionedMembers(ownText, entities) : [];

  for (const issueId of issueIds) {
    const issue = await prisma.issue.findUnique({
      where: { id: issueId },
      select: { status: true, handoffLink: true, note: true },
    });
    if (!issue) continue;

    if (!issue.handoffLink) {
      const link = devMessageLink(message);
      await prisma.issue.update({
        where: { id: issueId },
        data: { handoffLink: link, handoffAt: new Date() },
      });
      await cancelPendingHandoff(issueId, link);
    }

    if (!canChangeStatus || issue.status === "RESOLVED" || issue.status === "ESCALATED") continue;

    // Человек — только если однозначно: отметили одного (из команды топика,
    // если топик известен). Отметили четверых фронтов — передано команде.
    const candidates = topicTeam ? mentioned.filter((m) => m.team === topicTeam) : mentioned;
    const assignee = candidates.length === 1 ? candidates[0] : null;
    const team = topicTeam ?? assignee?.team ?? null;
    const autoNote = !issue.note?.trim() || issue.note.trim().startsWith("Передано:");

    // source "chat": передачу сделали словами в другом чате, это вывод бота,
    // а не нажатие кнопки, — в группу куратора бот не пишет, только ставит
    // реакцию (см. reactToStatusChange).
    await changeIssueStatus({
      issueId,
      status: "ESCALATED",
      ...(team ? { escalatedTeam: team } : {}),
      escalatedAssignee: assignee?.name ?? null,
      ...(team && autoNote ? { note: escalationNote(team, assignee?.name ?? "") } : {}),
      actor: telegramIdToAgent(authorId!),
      source: "chat",
    });
  }
}
