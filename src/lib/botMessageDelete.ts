import { prisma } from "@/lib/prisma";
import { telegramIdToAgent } from "@/lib/agentTelegram";
import {
  answerCallbackQuery,
  deleteTelegramMessage,
  editMessageText,
  forwardAndIdentify,
  sendTelegramMessage,
  type TelegramCallbackQuery,
} from "@/lib/telegram";
import {
  BOT_MESSAGE_DELETE_PREFIX,
  BOT_MESSAGE_KEEP_PREFIX,
} from "@/lib/telegramCallbacks";

// Удаление ЛЮБОГО сообщения бота в рабочей группе по ссылке: /delete <ссылка>
// в личке. Кнопки «удалить ответ» на сайте и в разборе знают только ответы
// по тикетам (BotReply); репорт, объявления /broadcast и всё остальное бот
// не запоминает — а убрать неудачное сообщение иногда надо именно их.
//
// Три шага, а не один: бот пересылает сообщение агенту (видно, что именно
// удаляется, и Telegram говорит, чьё оно), спрашивает подтверждение и только
// потом удаляет. Проверка автора обязательна: если бот — админ группы,
// Telegram дал бы ему удалить и сообщение куратора, а эта команда — только
// про сообщения самого бота. Управление — в личке, никогда в группе (там
// кнопку увидели бы и нажали коллеги, см. CLAUDE.md).

const USAGE = [
  "Пришли ссылку на сообщение бота в группе:",
  "/delete https://t.me/c/1234567890/42",
  "",
  "Ссылку даёт Telegram: зажми сообщение → «Скопировать ссылку».",
  "Удалить можно только сообщение самого бота и только в первые 48 часов — дальше Telegram не даёт.",
].join("\n");

type Target = { chatId: string; messageId: number };

// Ссылки на сообщения, которые даёт Telegram:
//   t.me/c/<внутренний id>/<сообщение>          — закрытая группа (chat_id -100…)
//   t.me/c/<внутренний id>/<тема>/<сообщение>   — группа с темами
//   t.me/<username>/<сообщение>                 — публичная группа
export function parseMessageLink(raw: string): Target | null {
  const link = raw.trim().replace(/[?#].*$/, "").replace(/\/+$/, "");
  const privateLink = link.match(/^(?:https?:\/\/)?(?:t|telegram)\.me\/c\/(\d+)\/(?:\d+\/)?(\d+)$/i);
  if (privateLink) return { chatId: `-100${privateLink[1]}`, messageId: Number(privateLink[2]) };
  const publicLink = link.match(/^(?:https?:\/\/)?(?:t|telegram)\.me\/([A-Za-z][A-Za-z0-9_]{3,})\/(\d+)$/i);
  if (publicLink) return { chatId: `@${publicLink[1]}`, messageId: Number(publicLink[2]) };
  return null;
}

// Шаг 1-2: показать сообщение агенту и спросить подтверждение.
export async function startBotMessageDelete(agentChatId: number, argText: string): Promise<void> {
  const target = parseMessageLink(argText);
  if (!target) {
    await sendTelegramMessage(agentChatId, USAGE);
    return;
  }

  const preview = await forwardAndIdentify(agentChatId, target.chatId, target.messageId);
  if (!preview) {
    await sendTelegramMessage(
      agentChatId,
      "Не получилось открыть это сообщение: ссылка неверная, бота нет в этой группе или в группе запрещена пересылка."
    );
    return;
  }
  if (!preview.fromThisBot) {
    // Копия чужого сообщения в личке агенту ни к чему — убираем.
    await deleteTelegramMessage(agentChatId, preview.copyId);
    await sendTelegramMessage(
      agentChatId,
      "Это сообщение не бота. Через бота можно удалять только его собственные сообщения."
    );
    return;
  }

  await sendTelegramMessage(
    agentChatId,
    "Удалить это сообщение бота из группы?",
    [
      [
        {
          text: "🗑 Удалить",
          callback_data: `${BOT_MESSAGE_DELETE_PREFIX}${target.chatId}:${target.messageId}`,
        },
        { text: "Оставить", callback_data: BOT_MESSAGE_KEEP_PREFIX },
      ],
    ],
    undefined,
    undefined,
    preview.copyId
  );
}

// Шаг 3: нажатие «🗑 Удалить» / «Оставить». true — нажатие наше и обработано.
export async function handleBotMessageDeleteCallback(
  query: TelegramCallbackQuery
): Promise<boolean> {
  const data = query.data ?? "";
  const isDelete = data.startsWith(BOT_MESSAGE_DELETE_PREFIX);
  if (!isDelete && data !== BOT_MESSAGE_KEEP_PREFIX) return false;

  // Кнопка приходит только агенту в личку, но удаление необратимо —
  // проверяем, кто нажал, а не полагаемся на то, где кнопка лежит.
  if (!telegramIdToAgent(query.from.id)) {
    await answerCallbackQuery(query.id, "Удалять сообщения бота могут только агенты", true);
    return true;
  }

  const prompt = query.message;
  if (!isDelete) {
    await answerCallbackQuery(query.id, "Оставил");
    if (prompt) await editMessageText(prompt.chat.id, prompt.message_id, "Оставил сообщение в группе.", null);
    return true;
  }

  // chat_id может быть "-100…" или "@username" — двоеточия в нём нет, поэтому
  // делим по последнему.
  const rest = data.slice(BOT_MESSAGE_DELETE_PREFIX.length);
  const sep = rest.lastIndexOf(":");
  const chatId = rest.slice(0, sep);
  const messageId = Number(rest.slice(sep + 1));
  if (sep <= 0 || !Number.isInteger(messageId)) {
    await answerCallbackQuery(query.id, "Неизвестное действие", true);
    return true;
  }

  const removed = await deleteTelegramMessage(chatId, messageId);
  if (!removed) {
    await answerCallbackQuery(
      query.id,
      "Telegram не дал удалить: сообщение старше 48 часов или уже удалено",
      true
    );
    return true;
  }

  // Если это был ответ бота по тикету — на сайте и в разборе он больше не
  // должен числиться «сказанным в группе».
  await prisma.botReply.updateMany({
    where: { chatId, messageId },
    data: { deleted: true },
  });
  await answerCallbackQuery(query.id, "Удалено из группы ✅");
  if (prompt) {
    await editMessageText(prompt.chat.id, prompt.message_id, "🗑 Удалено из группы.", null);
  }
  return true;
}
