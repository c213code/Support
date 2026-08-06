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
