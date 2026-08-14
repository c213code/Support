// Автор тикетов, которые вебхук заводит сам (без участия агента) — по этому
// значению определяем, что тикет ещё никто не "забрал", и заменяем его на
// имя агента при первом же его действии (см. PATCH /api/issues/[id]).
export const AUTO_ISSUE_CREATOR = "Бот";

export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessagePayload;
  edited_message?: TelegramMessagePayload;
  callback_query?: TelegramCallbackQuery;
};

// Нажатие на inline-кнопку под сообщением бота — под вечерней сводкой
// (см. /api/cron/evening-report) и под карточками отдельных тикетов,
// позволяют менять статус тикета и рассылать репорт прямо из Telegram, не
// открывая сайт (см. handleCallbackQuery в вебхуке).
export type TelegramCallbackQuery = {
  id: string;
  from: {
    id: number;
    first_name?: string;
    last_name?: string;
    username?: string;
  };
  data?: string;
  message?: {
    message_id: number;
    chat: { id: number };
    // Нужна, чтобы точечно убрать одну строку кнопок (один тикет) из
    // сводного сообщения с несколькими тикетами, не трогая остальные
    // строки — см. ISSUE_STATUS_PREFIX в вебхуке.
    reply_markup?: { inline_keyboard: InlineKeyboardButton[][] };
  };
};

export type InlineKeyboardButton = { text: string; callback_data: string };
export type InlineKeyboard = InlineKeyboardButton[][];

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

// Для текста, вставляемого в сообщение с parse_mode "HTML" (см.
// sendTelegramMessage) — без экранирования "<"/">"/"&" в описании тикета
// (реальный текст от пользователя, может содержать что угодно) Telegram
// вернёт ошибку парсинга разметки и сообщение не уйдёт вообще.
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const BOT_API_TIMEOUT_MS = 5000;

// Общий вызов Telegram Bot API — для реакций, отправки сообщений с
// инлайн-кнопками и ответов на них. Намеренно не бросает исключение и
// возвращает null при любой проблеме (нет токена, нет сети, таймаут,
// Telegram ответил ошибкой): каждый из этих вызовов — бонус к основному
// действию (сохранить статус, отдать тикет), а не его часть, и не должен
// ронять его при недоступности Telegram.
async function callBotApi(
  method: string,
  payload: Record<string, unknown>
): Promise<unknown> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BOT_API_TIMEOUT_MS);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// Отражает смену статуса тикета прямо в чате — реакцией на исходное
// сообщение, без лишнего сообщения-уведомления в чат. emoji: null снимает
// реакцию (пустой список reaction). Telegram разрешает для ботов только
// фиксированный набор emoji (ReactionTypeEmoji) — не любой символ.
export async function setMessageReaction(
  chatId: string,
  messageId: number,
  emoji: string | null
): Promise<void> {
  await callBotApi("setMessageReaction", {
    chat_id: chatId,
    message_id: messageId,
    reaction: emoji ? [{ type: "emoji", emoji }] : [],
  });
}

// Отправляет сообщение (опционально с инлайн-клавиатурой) — используется
// вечерней сводкой (см. /api/cron/evening-report) и рассылкой готового
// репорта в группу по кнопке. Возвращает message_id для тех редких
// случаев, когда его потом нужно отредактировать (см.
// editMessageReplyMarkup); при неудаче — null, вызывающий код просто не
// получит id и не станет ничего редактировать.
export async function sendTelegramMessage(
  chatId: string | number,
  text: string,
  replyMarkup?: InlineKeyboard,
  // Для групп с включёнными "Темами" (форум-топики) — id темы, куда
  // должно уйти сообщение, а не просто в общий чат. Без него сообщение
  // уходит в General/основной поток группы.
  threadId?: number,
  // "HTML" — когда в text есть разметка (ссылка компактной кликабельной
  // ссылкой вместо голого URL, см. buildTelegramLink ниже). Вызывающий код
  // сам отвечает за экранирование пользовательского текста — escapeHtml.
  parseMode?: "HTML"
): Promise<{ message_id: number } | null> {
  const data = (await callBotApi("sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: replyMarkup ? { inline_keyboard: replyMarkup } : undefined,
    message_thread_id: threadId,
    parse_mode: parseMode,
  })) as { result?: { message_id?: number } } | null;

  return typeof data?.result?.message_id === "number"
    ? { message_id: data.result.message_id }
    : null;
}

// Снимает инлайн-клавиатуру с уже отправленного сообщения — после того,
// как кнопку нажали ("Отправить в группу" / смена статуса), чтобы её
// нельзя было случайно нажать второй раз.
export async function editMessageReplyMarkup(
  chatId: string | number,
  messageId: number,
  replyMarkup: InlineKeyboard | null
): Promise<void> {
  await callBotApi("editMessageReplyMarkup", {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: replyMarkup ?? [] },
  });
}

// Ответ на нажатие инлайн-кнопки — Telegram требует его в течение
// нескольких секунд, иначе кнопка у пользователя "крутится" бесконечно.
// showAlert — показать всплывающее окно вместо мелкого тоста (для явных
// отказов вроде "группа ещё не настроена").
export async function answerCallbackQuery(
  callbackQueryId: string,
  text?: string,
  showAlert = false
): Promise<void> {
  await callBotApi("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
    show_alert: showAlert,
  });
}
