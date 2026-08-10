// Автор тикетов, которые вебхук заводит сам (без участия агента) — по этому
// значению определяем, что тикет ещё никто не "забрал", и заменяем его на
// имя агента при первом же его действии (см. PATCH /api/issues/[id]).
export const AUTO_ISSUE_CREATOR = "Бот";

export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessagePayload;
  edited_message?: TelegramMessagePayload;
};

export type TelegramMessagePayload = {
  message_id: number;
  date: number;
  chat: {
    id: number;
    type: string;
    title?: string;
  };
  from?: {
    id: number;
    is_bot: boolean;
    first_name?: string;
    last_name?: string;
    username?: string;
  };
  text?: string;
  caption?: string;
  photo?: unknown[];
  sticker?: { emoji?: string };
  document?: { file_name?: string };
  voice?: unknown;
  video?: unknown;
  // Сообщение, на которое ответили ("Reply"). Telegram не разворачивает
  // цепочку глубже одного уровня — этого достаточно, обычно отвечают на
  // прямого собеседника, а не пересылают цитату из цитаты. message_id
  // нужен отдельно от текста — по нему ищем, не заведён ли уже тикет по
  // тому сообщению (см. findTicketForReply в вебхуке): частый паттерн
  // "напоминание" — отвечают на своё же старое сообщение, на которое так и
  // не ответили.
  reply_to_message?: {
    message_id: number;
    from?: TelegramMessagePayload["from"];
    text?: string;
    caption?: string;
  };
};

export function buildMessageLink(chatId: number, messageId: number): string {
  // Для супергрупп (id вида -100xxxxxxxxxx) публичная ссылка на сообщение
  // строится через внутренний id без префикса "-100".
  const idStr = String(chatId);
  const internalId = idStr.startsWith("-100") ? idStr.slice(4) : idStr.replace("-", "");
  return `https://t.me/c/${internalId}/${messageId}`;
}

export function extractAuthorName(
  from: TelegramMessagePayload["from"]
): string | null {
  if (!from) return null;
  const name = [from.first_name, from.last_name].filter(Boolean).join(" ");
  return name || from.username || null;
}

// Собственные сообщения агентов (их ответы прямо в группе) не нужны во
// "Входящих" — это не запросы от пользователей. Сравниваем по числовому
// Telegram user id (OWN_AGENT_TELEGRAM_IDS="123,456" в env) — в отличие от
// имени/фамилии id никогда не меняется и не зависит от эмодзи/оформления
// профиля, так что это надёжнее текстового сравнения.
function ownAgentTelegramIds(): Set<number> {
  const raw = process.env.OWN_AGENT_TELEGRAM_IDS ?? "";
  return new Set(
    raw
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n !== 0)
  );
}

export function isOwnAgentMessage(fromId: number | undefined): boolean {
  if (!fromId) return false;
  return ownAgentTelegramIds().has(fromId);
}

export function extractText(message: TelegramMessagePayload): string | null {
  if (message.text) return message.text;
  if (message.caption) return message.caption;
  if (message.photo) return "[Фото]";
  if (message.sticker) return `[Стикер ${message.sticker.emoji ?? ""}]`.trim();
  if (message.document) return `[Файл: ${message.document.file_name ?? ""}]`.trim();
  if (message.voice) return "[Голосовое сообщение]";
  if (message.video) return "[Видео]";
  return null;
}

const QUOTE_MAX_LENGTH = 200;

// Ответ ("Reply") на чужое сообщение сам по себе часто нечитаем без
// контекста — "Әдістеме бөлінді нұсқа салынып тұр дейді" ("дейді" —
// "говорят/сказал") ничего не значит, если не видно, на какой вопрос
// отвечают. Telegram присылает reply_to_message только при первом
// событии; отдельно его перезапрашивать не нужно — либо контекст пришёл
// вместе с сообщением, либо его нет.
export function extractReplyContextLine(
  message: TelegramMessagePayload
): string | null {
  const quoted = message.reply_to_message;
  if (!quoted) return null;

  const quotedText = quoted.text ?? quoted.caption;
  if (!quotedText) return null;

  const truncated =
    quotedText.length > QUOTE_MAX_LENGTH
      ? `${quotedText.slice(0, QUOTE_MAX_LENGTH)}…`
      : quotedText;
  const author = extractAuthorName(quoted.from);

  return `↩️ ${author ?? "Жауап"}: ${truncated}`;
}

const REACTION_TIMEOUT_MS = 5000;

// Отражает смену статуса тикета прямо в чате — реакцией на исходное
// сообщение, без лишнего сообщения-уведомления в чат. emoji: null снимает
// реакцию (пустой список reaction). Telegram разрешает для ботов только
// фиксированный набор emoji (ReactionTypeEmoji) — не любой символ.
// Намеренно не бросает исключение: реакция — бонус к статусу тикета, а не
// его часть, и не должна ронять сохранение статуса, если у бота нет прав
// на реакции в чате, сообщение удалено или Telegram недоступен.
export async function setMessageReaction(
  chatId: string,
  messageId: number,
  emoji: string | null
): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REACTION_TIMEOUT_MS);
  try {
    await fetch(`https://api.telegram.org/bot${token}/setMessageReaction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        reaction: emoji ? [{ type: "emoji", emoji }] : [],
      }),
      signal: controller.signal,
    });
  } catch {
    // см. комментарий выше — намеренно проглатываем
  } finally {
    clearTimeout(timeout);
  }
}
