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
