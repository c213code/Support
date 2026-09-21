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
    // Текст сообщения, под которым нажали кнопку. Читается, чтобы достать
    // из него уже показанную человеку заметку: в callback_data (64 байта)
    // она не помещается, а пересчитывать её моделью заново — значит
    // отметить тикет не тем текстом, который человек видел, когда нажимал.
    text?: string;
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
  // Telegram отдаёт один снимок несколькими размерами, от превью к оригиналу
  // (см. largestPhotoFileId). Сами байты у нас не хранятся — только file_id,
  // как и у фото из формы мини-аппа.
  photo?: Array<{ file_id?: string }>;
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

// Имя нужно и для нажатия на кнопку (TelegramCallbackQuery.from), где поля
// is_bot нет, — поэтому параметр описан по тем полям, которые реально
// читаются, а не целым типом отправителя сообщения.
export function extractAuthorName(
  from:
    | { first_name?: string; last_name?: string; username?: string }
    | undefined
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
//
// Если переменная не задана, берём те же id из AGENT_TELEGRAM_IDS
// ("Ерош:123,Алпа:456" — см. lib/agentTelegram.ts): это по определению те
// же самые люди, просто с именами. Без фолбэка забытая OWN_AGENT_TELEGRAM_IDS
// молча ломает всё, что опирается на "это наш агент": сообщения агентов
// заводят тикеты как клиентские, а подсказка "как решили" не находит в чате
// ни одной своей реплики. Причём выглядит это не как ошибка, а как будто
// фичи просто не работают.
function ownAgentTelegramIds(): Set<number> {
  const explicit = new Set(
    (process.env.OWN_AGENT_TELEGRAM_IDS ?? "")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n !== 0)
  );
  if (explicit.size > 0) return explicit;

  return new Set(
    (process.env.AGENT_TELEGRAM_IDS ?? "")
      .split(",")
      .map((pair) => Number(pair.split(":")[1]?.trim()))
      .filter((n) => Number.isFinite(n) && n !== 0)
  );
}

export function isOwnAgentMessage(fromId: number | undefined): boolean {
  if (!fromId) return false;
  return ownAgentTelegramIds().has(fromId);
}

// Те же id списком — для проверки "не ответил ли живой человек раньше
// бота" (см. agentAlreadyReplied в lib/botReply.ts), где нужен фильтр по
// TelegramMessage.fromId, а он BigInt.
export function ownAgentTelegramIdList(): bigint[] {
  return Array.from(ownAgentTelegramIds(), (id) => BigInt(id));
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

// file_id самого крупного размера присланного фото. Telegram шлёт один
// снимок несколькими размерами по возрастанию, последний — оригинал; мелкие
// нужны ленте чатов, а не нам: на скриншоте куратора важно прочитать текст
// ошибки (см. lib/submissionChat.ts).
export function largestPhotoFileId(
  message: TelegramMessagePayload
): string | undefined {
  const sizes = message.photo ?? [];
  return sizes[sizes.length - 1]?.file_id;
}

// Экспорт — ради lib/resolutionNote.ts: там цитату нужно срезать обратно,
// а для этого знать, до какой длины её обрезали.
export const QUOTE_MAX_LENGTH = 200;

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
    if (!res.ok) {
      // Telegram объясняет отказ в description ("chat not found", "Only HTTPS
      // links are allowed") — без этой строки любой сбой здесь неотличим в
      // логах от успеха. Только метод и ответ: в URL запроса — токен бота.
      const detail = (await res.json().catch(() => null)) as { description?: string } | null;
      console.warn(`[telegram] ${method} ${res.status}: ${detail?.description ?? ""}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn(`[telegram] ${method} не выполнен: ${err instanceof Error ? err.name : "ошибка"}`);
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
  // "HTML" — когда в text есть разметка (компактная кликабельная ссылка
  // вместо голого URL — см. escapeHtml выше). Вызывающий код сам отвечает
  // за экранирование пользовательского текста этим хелпером.
  parseMode?: "HTML",
  // Ответить реплаем на конкретное сообщение. Для автоответов в рабочие
  // группы это обязательно: там за минуту проходит несколько обращений, и
  // ответ без привязки непонятно к чему относится.
  // allow_sending_without_reply: исходное сообщение могли удалить, пока мы
  // отвечали — тогда лучше отправить без привязки, чем не отправить вовсе.
  replyToMessageId?: number
): Promise<{ message_id: number } | null> {
  const data = (await callBotApi("sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: replyMarkup ? { inline_keyboard: replyMarkup } : undefined,
    message_thread_id: threadId,
    parse_mode: parseMode,
    reply_to_message_id: replyToMessageId,
    allow_sending_without_reply: replyToMessageId != null ? true : undefined,
  })) as { result?: { message_id?: number } } | null;

  return typeof data?.result?.message_id === "number"
    ? { message_id: data.result.message_id }
    : null;
}

// Загрузка файла требует multipart/form-data, а callBotApi шлёт JSON — отсюда
// отдельный вызов. Таймаут длиннее: фото весит больше, чем текст.
const BOT_UPLOAD_TIMEOUT_MS = 20000;

// Подпись к фото у Telegram — 1024 символа, дальше он отклоняет запрос целиком.
export const CAPTION_LIMIT = 1024;

// Результат загрузки фото. Причина отказа нужна вызывающему коду, чтобы
// сказать правду: "канал настроен неверно" (config) куратор не исправит —
// это к тому, кто настраивал форму; "Telegram не принял фото" (photo) — к
// выбору другого фото; "не дозвонились" (network) — к повтору. Без этого
// разделения неверный TELEGRAM_STORAGE_CHAT_ID выглядел для куратора как
// "плохое фото", а для команды — как тишина.
export type PhotoUpload =
  | { ok: true; fileIds: string[] }
  | { ok: false; kind: "config" | "photo" | "network"; description: string };

type SentPhoto = { photo?: Array<{ file_id?: string }> };

// Telegram отдаёт несколько размеров одного фото — нужен самый крупный.
function largestFileId(message: SentPhoto): string | undefined {
  const sizes = message.photo ?? [];
  return sizes[sizes.length - 1]?.file_id;
}

// Ошибки, которые значат "бот не может писать в этот чат", а не "плохое фото".
const CHAT_CONFIG_ERROR = /chat not found|not enough rights|not a member|CHAT_WRITE_FORBIDDEN|bot was kicked/i;

// Кладёт фото обращения в чат (для формы мини-аппа — в закрытый служебный
// канал) и возвращает file_id каждого: по ним фото потом достаются через
// getFile, сами байты у нас не хранятся.
//
// Несколько фото уходят ОДНИМ альбомом (sendMediaGroup) — в канале это одно
// сообщение с одной подписью, а не пять подряд с «фото 2», «фото 3».
// Альбом Telegram принимает от двух фото, поэтому одно отправляется обычным
// sendPhoto.
export async function uploadPhotos(
  chatId: string,
  photos: Blob[],
  caption?: string
): Promise<PhotoUpload> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return { ok: false, kind: "config", description: "TELEGRAM_BOT_TOKEN не задан" };
  if (photos.length === 0) return { ok: false, kind: "photo", description: "нет фото" };

  const single = photos.length === 1;
  const method = single ? "sendPhoto" : "sendMediaGroup";
  const form = new FormData();
  form.append("chat_id", chatId);
  if (single) {
    form.append("photo", photos[0], "photo.jpg");
    if (caption) form.append("caption", caption.slice(0, 1024));
  } else {
    // У альбома подпись одна — на первом фото; Telegram показывает её под
    // всей группой. Сами файлы прикладываются отдельными частями и
    // связываются с описанием через attach://.
    form.append(
      "media",
      JSON.stringify(
        photos.map((_, index) => ({
          type: "photo",
          media: `attach://photo${index}`,
          ...(index === 0 && caption ? { caption: caption.slice(0, 1024) } : {}),
        }))
      )
    );
    photos.forEach((photo, index) =>
      form.append(`photo${index}`, photo, `photo-${index + 1}.jpg`)
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BOT_UPLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      body: form,
      signal: controller.signal,
    });
    const data = (await res.json().catch(() => null)) as {
      ok?: boolean;
      description?: string;
      result?: SentPhoto | SentPhoto[];
    } | null;
    if (!res.ok || !data?.ok) {
      // description у Telegram без секретов ("chat not found", "not enough
      // rights") — ровно то, что нужно, чтобы понять, почему форма не работает.
      const description = `${res.status}: ${data?.description ?? ""}`;
      console.warn(`[telegram] ${method} ${description}`);
      const config =
        res.status === 401 || res.status === 403 || CHAT_CONFIG_ERROR.test(data?.description ?? "");
      return { ok: false, kind: config ? "config" : "photo", description };
    }
    const sent = Array.isArray(data.result) ? data.result : data.result ? [data.result] : [];
    const fileIds = sent
      .map(largestFileId)
      .filter((fileId): fileId is string => Boolean(fileId));
    if (fileIds.length !== photos.length) {
      // Частичный ответ хуже отказа: часть фото осталась бы без file_id, и
      // агент открыл бы обращение с дырой вместо скриншота.
      console.error(
        `[telegram] ${method} ответил ok, но file_id пришло ${fileIds.length} из ${photos.length}`
      );
      return { ok: false, kind: "photo", description: "ответ без file_id" };
    }
    return { ok: true, fileIds };
  } catch (err) {
    // Только имя ошибки: в причине сетевой ошибки fetch может оказаться URL,
    // а в нём — токен бота.
    const name = err instanceof Error ? err.name : "ошибка";
    console.warn(`[telegram] ${method} не выполнен: ${name}`);
    return { ok: false, kind: "network", description: name };
  } finally {
    clearTimeout(timeout);
  }
}

// Ссылка на скачивание файла по file_id. Действует минимум час; ботам
// отдаются файлы до 20 МБ (фото из формы сжаты на телефоне задолго до этого).
// В ссылке зашит токен бота — отдавать её в браузер нельзя, только качать
// сервером (см. GET /api/issues/[id]/photo).
// Отправляет в чат фото, которые у нас уже есть как file_id (лежат в
// служебном канале после uploadPhotos). Байты не перезагружаются: тот же бот
// шлёт file_id как есть — это один JSON-запрос вместо мегабайтов трафика.
//
// Возвращает message_id первого сообщения: по нему строится ссылка на
// обращение в группе и к нему же привязываются ответы коллег.
export async function sendStoredPhotos(
  chatId: string,
  fileIds: string[],
  caption?: string
): Promise<{ message_id: number } | null> {
  if (fileIds.length === 0) return null;

  // Альбом Telegram принимает от двух фото; подпись у альбома одна — на
  // первом, иначе она повторится под каждым.
  const single = fileIds.length === 1;
  const data = (await callBotApi(
    single ? "sendPhoto" : "sendMediaGroup",
    single
      ? { chat_id: chatId, photo: fileIds[0], caption: caption?.slice(0, CAPTION_LIMIT) }
      : {
          chat_id: chatId,
          media: fileIds.map((fileId, index) => ({
            type: "photo",
            media: fileId,
            ...(index === 0 && caption ? { caption: caption.slice(0, CAPTION_LIMIT) } : {}),
          })),
        }
  )) as { result?: { message_id?: number } | Array<{ message_id?: number }> } | null;

  const first = Array.isArray(data?.result) ? data?.result[0] : data?.result;
  return typeof first?.message_id === "number" ? { message_id: first.message_id } : null;
}

export async function getFileDownloadUrl(fileId: string): Promise<string | null> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  const data = (await callBotApi("getFile", { file_id: fileId })) as {
    result?: { file_path?: string };
  } | null;
  const path = data?.result?.file_path;
  return path ? `https://api.telegram.org/file/bot${token}/${path}` : null;
}

// Сообщение с кнопкой, открывающей мини-апп. Отдельно от sendTelegramMessage:
// там клавиатура — только callback-кнопки, и разбор нажатий (webhook/
// callbacks.ts) рассчитывает, что у каждой кнопки есть callback_data.
// web_app-кнопки Telegram показывает только в личке — это и есть наш случай.
// false — Telegram кнопку не принял (причина — в логе callBotApi): вызывающий
// код должен ответить человеку иначе, а не оставить его без ответа.
export async function sendWebAppButton(
  chatId: number | string,
  text: string,
  buttonText: string,
  url: string
): Promise<boolean> {
  const data = await callBotApi("sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: { inline_keyboard: [[{ text: buttonText, web_app: { url } }]] },
  });
  return data !== null;
}

// Кнопка меню бота (синяя слева от поля ввода) открывает мини-апп в одно
// касание — без /start и без поиска старого сообщения с кнопкой.
//
// chatId = null — значение по умолчанию для всех чатов бота, в том числе тех,
// кто ему ещё не писал. С chatId — тому же человеку сразу, не дожидаясь, пока
// Telegram подхватит новое значение по умолчанию.
//
// Эта кнопка занимает место списка команд, поэтому агентам команды отдаём
// через setChatCommands ниже — они остаются доступны по вводу "/".
export async function setWebAppMenuButton(
  chatId: number | null,
  text: string,
  url: string
): Promise<boolean> {
  const data = await callBotApi("setChatMenuButton", {
    chat_id: chatId ?? undefined,
    menu_button: { type: "web_app", text, web_app: { url } },
  });
  return data !== null;
}

// Список команд для конкретного чата: Telegram показывает его при вводе "/".
// Только для агентов (scope = их чат), чтобы кураторам не подсказывать
// внутренние команды.
export async function setChatCommands(
  chatId: number,
  commands: Array<{ command: string; description: string }>
): Promise<boolean> {
  const data = await callBotApi("setMyCommands", {
    commands,
    scope: { type: "chat", chat_id: chatId },
  });
  return data !== null;
}

// Удаляет сообщение бота. Telegram разрешает это только в течение 48 часов
// после отправки — позже вернёт ошибку, и вызывающий код должен честно
// сказать об этом человеку, а не молчать (см. src/lib/botReply.ts).
// Возвращает true, только если Telegram подтвердил удаление.
export async function deleteTelegramMessage(
  chatId: string | number,
  messageId: number
): Promise<boolean> {
  const data = (await callBotApi("deleteMessage", {
    chat_id: chatId,
    message_id: messageId,
  })) as { ok?: boolean; result?: boolean } | null;

  return data?.result === true;
}

// Пересылает сообщение (для /delete — агенту в личку, чтобы он видел, что
// удаляет) и говорит, чьё оно: в пересланной копии Telegram указывает
// настоящего автора (forward_origin). Другого способа узнать автора
// сообщения по ссылке в Bot API нет — getMessage у ботов нет, а бот-админ
// группы может удалить и чужое сообщение, так что проверять автора надо.
// null — переслать не вышло (неверная ссылка, бота нет в группе, в группе
// запрещена пересылка); причина — в логе callBotApi.
export async function forwardAndIdentify(
  toChatId: number,
  fromChatId: string,
  messageId: number
): Promise<{ copyId: number; fromThisBot: boolean } | null> {
  const data = (await callBotApi("forwardMessage", {
    chat_id: toChatId,
    from_chat_id: fromChatId,
    message_id: messageId,
  })) as {
    result?: {
      message_id?: number;
      forward_origin?: { type?: string; sender_user?: { id?: number } };
    };
  } | null;
  const copyId = data?.result?.message_id;
  if (typeof copyId !== "number") return null;
  // id бота — часть его токена до двоеточия: лишний getMe не нужен.
  const botId = Number(process.env.TELEGRAM_BOT_TOKEN?.split(":")[0]);
  const origin = data?.result?.forward_origin;
  return {
    copyId,
    fromThisBot: origin?.type === "user" && origin.sender_user?.id === botId,
  };
}

// Переписывает текст и клавиатуру уже отправленного сообщения на месте —
// для кнопки "🔁 Обновить список" (см. dailyReview.ts): без этого пришлось
// бы слать новое сообщение каждый раз и плодить те же бабблы, от которых
// уже один раз ушли (см. коммит про консолидацию кнопок статуса).
// Возвращает true, если Telegram подтвердил правку — нужно для правки
// автоответов в группе (см. src/lib/botReply.ts): там, в отличие от
// карточек разбора, человеку важно знать, applied ли изменение, потому что
// после 48 часов Telegram править уже не даёт.
export async function editMessageText(
  chatId: string | number,
  messageId: number,
  text: string,
  replyMarkup?: InlineKeyboard | null,
  parseMode?: "HTML"
): Promise<boolean> {
  const data = (await callBotApi("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    reply_markup: replyMarkup ? { inline_keyboard: replyMarkup } : undefined,
    parse_mode: parseMode,
  })) as { result?: unknown } | null;

  return data?.result != null;
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
