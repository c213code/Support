import { prisma } from "@/lib/prisma";
import { miniAppUrl } from "@/lib/miniapp";
import { FORWARD_RESET } from "@/lib/telegramCallbacks";
import {
  editMessageText,
  largestPhotoFileId,
  sendWebAppButton,
  type TelegramMessagePayload,
} from "@/lib/telegram";

// Пересланная переписка → черновик обращения для формы.
//
// Кураторы редко пишут запрос заново: они пересылают боту готовую цепочку из
// своего чата — шесть сообщений подряд, между ними скрины, логин с паролем и
// «кіріп көрші». Заставлять переписывать это в форму бессмысленно: перепишут
// половину или не станут пользоваться формой вовсе. Поэтому пересланное
// копится здесь, а мини-апп открывается уже с текстом и фотографиями, и
// куратору остаётся выбрать группу и тип проблемы.

// Сколько черновик «живёт» между пересылками. Цепочку пересылают залпом,
// за секунды: Telegram отправляет отмеченные сообщения подряд. Пауза
// больше этой — уже другой разговор, и прилеплять его к прежнему нельзя.
//
// Полчаса, стоявшие здесь сначала, оказались именно такой ошибкой: куратор
// переслал одну цепочку, через десять минут — вторую, и получил «11
// хабарлама» в одном черновике. Две минуты покрывают залп с запасом на
// «доскроллил, нашёл ещё одно», но не склеивают разные запросы.
const DRAFT_WINDOW_MS = 2 * 60 * 1000;

// Столько же, сколько принимает форма (MAX_PHOTOS в submit).
const MAX_PHOTOS = 5;

// Текста в черновике — не больше, чем разумно показать в поле формы.
const MAX_TEXT = 3000;

export function isForwarded(message: TelegramMessagePayload): boolean {
  return Boolean(message.forward_origin || message.forward_date);
}

// Кто автор пересланного — это и есть «от кого пришёл запрос». Telegram
// прячет имя, если у человека закрыт профиль: тогда остаётся только
// forward_sender_name или ничего.
function originName(message: TelegramMessagePayload): string {
  const origin = message.forward_origin;
  const user = origin?.sender_user;
  const full = [user?.first_name, user?.last_name].filter(Boolean).join(" ").trim();
  return (
    full ||
    origin?.sender_user_name ||
    origin?.chat?.title ||
    message.forward_sender_name ||
    ""
  );
}

function buildPrompt(text: string, photoCount: number, direct: boolean): string {
  const parts = [`${text.split("\n").filter(Boolean).length} хабарлама`];
  if (photoCount > 0) parts.push(`${photoCount} сурет`);
  // Написали боту напрямую — сначала говорим, куда такое принимают: иначе
  // куратор так и будет писать в личку, а дежурный узнавать об этом
  // случайно, из «Входящих» без группы.
  const lead = direct
    ? "📝 Мәселені мини-апп арқылы жіберіңіз — жазғаныңыз сақталды: "
    : "📥 Жіберілген хабарламалар жиналды: ";
  return (
    `${lead}${parts.join(", ")}.\n\n` +
    "«Өтініш жасау» батырмасын басыңыз — мәтін мен суреттер формаға өзі қойылады, " +
    "сізге тек топ пен мәселе түрін таңдау қалады.\n\n" +
    "Басқа мәселе бойынша жіберсеңіз — «Жаңадан бастау»."
  );
}

// Кусок текста и фото → черновик куратора, и одно сообщение бота с кнопкой
// формы, которое правится на каждое следующее поступление — новых экранов
// не появляется. Общая точка для пересылки, прямого сообщения боту и
// кнопки «➕ Жаңа өтініш».
async function addToDraft(opts: {
  userId: bigint;
  chatId: number;
  body: string;
  photoFileIds: string[];
  // Имя автора пересланного — одной строкой в начале нового черновика.
  author?: string;
  direct: boolean;
}): Promise<void> {
  const url = miniAppUrl();
  if (!url) return;

  const existing = await prisma.forwardDraft.findUnique({
    where: { telegramUserId: opts.userId },
  });
  const fresh =
    existing && Date.now() - existing.updatedAt.getTime() < DRAFT_WINDOW_MS ? existing : null;

  // Имя автора пишем один раз, отдельной строкой в начале черновика: в
  // цепочке из шести сообщений оно у всех одно и то же, а приклеенное к
  // первому сообщению — мешает разбору. Первой пересылкой обычно и идёт
  // голый номер или почта, и с приставкой «Айханым:» такая строка
  // перестаёт быть только контактом (см. lib/forwardFill.ts).
  const line = fresh || !opts.author ? opts.body : [opts.author, opts.body].filter(Boolean).join("\n");

  const photos = [...(fresh?.photoFileIds ?? []), ...opts.photoFileIds].slice(0, MAX_PHOTOS);
  const text = [fresh?.text ?? "", line].filter(Boolean).join("\n").slice(0, MAX_TEXT);

  const draft = await prisma.forwardDraft.upsert({
    where: { telegramUserId: opts.userId },
    update: {
      text,
      photoFileIds: photos,
      // Прежний черновик просрочен — и его сообщение с кнопкой тоже: на
      // него больше не отвечаем, покажем новое.
      ...(fresh ? {} : { promptChatId: null, promptMessageId: null }),
    },
    create: { telegramUserId: opts.userId, text, photoFileIds: photos },
  });

  const prompt = buildPrompt(text, photos.length, opts.direct);
  if (draft.promptChatId && draft.promptMessageId) {
    const edited = await editMessageText(draft.promptChatId, draft.promptMessageId, prompt, [
      [{ text: "📝 Өтініш жасау", web_app: { url } }],
      [{ text: "🆕 Жаңадан бастау", callback_data: FORWARD_RESET }],
    ]);
    if (edited) return;
  }

  const sent = await sendWebAppButton(opts.chatId, prompt, "📝 Өтініш жасау", url, [
    [{ text: "🆕 Жаңадан бастау", callback_data: FORWARD_RESET }],
  ]);
  await prisma.forwardDraft.update({
    where: { id: draft.id },
    data: {
      promptChatId: sent ? String(opts.chatId) : null,
      promptMessageId: sent ? sent.message_id : null,
    },
  });
}

// Голый плейсхолдер «[Фото]» в текст не кладём: фото и так приложены, а в
// описании это мусор. Поэтому берём сам текст или подпись, а не extractText.
function ownText(message: TelegramMessagePayload): string {
  return (message.text ?? message.caption ?? "").trim();
}

function photosOf(message: TelegramMessagePayload): string[] {
  const photo = largestPhotoFileId(message);
  return photo ? [photo] : [];
}

// Пересланное сообщение — в черновик.
export async function collectForwardedMessage(
  message: TelegramMessagePayload,
  userId: bigint
): Promise<void> {
  await addToDraft({
    userId,
    chatId: message.chat.id,
    body: ownText(message),
    photoFileIds: photosOf(message),
    author: originName(message),
    direct: false,
  });
}

// Куратор написал боту сам, а не через форму. Заводить из этого тикет бот
// не должен — у заявки есть обязательные поля, которые собирает форма, — но
// и терять написанное нельзя: раньше оно тихо ложилось во «Входящие» без
// группы. Теперь текст и фото копятся тем же черновиком, а бот просит
// отправить их формой, где всё уже будет заполнено.
export async function collectDirectMessage(
  message: TelegramMessagePayload,
  userId: bigint
): Promise<void> {
  await addToDraft({
    userId,
    chatId: message.chat.id,
    body: ownText(message),
    photoFileIds: photosOf(message),
    direct: true,
  });
}

// То же для сообщения, которое бот держал до ответа на «Қай өтініш бойынша
// жазып отырсыз?», когда куратор выбрал «➕ Жаңа өтініш»: раньше оно на этом
// месте пропадало.
export async function collectPendingMessage(opts: {
  userId: bigint;
  chatId: number;
  text: string;
  photoFileIds: string[];
}): Promise<void> {
  await addToDraft({ ...opts, body: opts.text.trim(), direct: true });
}

// Куратор нажал «Жаңадан бастау»: прежний черновик больше не нужен, и
// следующая пересылка начнёт новый. Сообщение с кнопкой переписываем —
// плодить экраны ради подтверждения незачем.
export async function resetForwardDraft(userId: bigint): Promise<void> {
  const draft = await prisma.forwardDraft.findUnique({ where: { telegramUserId: userId } });
  if (!draft) return;
  await prisma.forwardDraft.delete({ where: { id: draft.id } });
  if (draft.promptChatId && draft.promptMessageId) {
    await editMessageText(
      draft.promptChatId,
      draft.promptMessageId,
      "🆕 Жаңадан бастаймыз. Келесі мәселе бойынша хабарламаларды жіберіңіз.",
      null
    );
  }
}
