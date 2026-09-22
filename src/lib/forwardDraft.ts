import { prisma } from "@/lib/prisma";
import { miniAppUrl } from "@/lib/miniapp";
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

// Сколько черновик «живёт» между пересылками. Цепочку пересылают за
// секунды, но человек может отвлечься на поиск нужного сообщения — полчаса
// с запасом. Пересылка после паузы начинает новый черновик: иначе к
// сегодняшнему запросу прилипла бы вчерашняя переписка.
const DRAFT_WINDOW_MS = 30 * 60 * 1000;

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

function buildPrompt(text: string, photoCount: number): string {
  const parts = [`${text.split("\n").filter(Boolean).length} хабарлама`];
  if (photoCount > 0) parts.push(`${photoCount} сурет`);
  return (
    `📥 Жіберілген хабарламалар жиналды: ${parts.join(", ")}.\n\n` +
    "«Өтініш жасау» батырмасын басыңыз — мәтін мен суреттер формаға өзі қойылады, " +
    "сізге тек топ пен мәселе түрін таңдау қалады."
  );
}

// Собирает очередное пересланное сообщение в черновик куратора и показывает
// ему одну и ту же кнопку, редактируя своё прежнее сообщение — новых
// экранов на каждую пересылку не появляется.
export async function collectForwardedMessage(
  message: TelegramMessagePayload,
  userId: bigint
): Promise<void> {
  const url = miniAppUrl();
  if (!url) return;

  const existing = await prisma.forwardDraft.findUnique({
    where: { telegramUserId: userId },
  });
  const fresh =
    existing && Date.now() - existing.updatedAt.getTime() < DRAFT_WINDOW_MS ? existing : null;

  // Голый плейсхолдер «[Фото]» в текст не кладём: фото и так приложены, а
  // в описании это мусор.
  const body = (message.text ?? message.caption ?? "").trim();
  const author = originName(message);
  // Имя автора пишем один раз, в начале черновика: в цепочке из шести
  // сообщений оно у всех одно и то же.
  const line = fresh || !author ? body : [`${author}:`, body].filter(Boolean).join(" ");

  const photo = largestPhotoFileId(message);
  const photos = [...(fresh?.photoFileIds ?? []), ...(photo ? [photo] : [])].slice(0, MAX_PHOTOS);
  const text = [fresh?.text ?? "", line].filter(Boolean).join("\n").slice(0, MAX_TEXT);

  const draft = await prisma.forwardDraft.upsert({
    where: { telegramUserId: userId },
    update: {
      text,
      photoFileIds: photos,
      // Прежний черновик просрочен — и его сообщение с кнопкой тоже: на
      // него больше не отвечаем, покажем новое.
      ...(fresh ? {} : { promptChatId: null, promptMessageId: null }),
    },
    create: { telegramUserId: userId, text, photoFileIds: photos },
  });

  const prompt = buildPrompt(text, photos.length);
  if (draft.promptChatId && draft.promptMessageId) {
    const edited = await editMessageText(draft.promptChatId, draft.promptMessageId, prompt, [
      [{ text: "📝 Өтініш жасау", web_app: { url } }],
    ]);
    if (edited) return;
  }

  const chatId = String(message.chat.id);
  const sent = await sendWebAppButton(message.chat.id, prompt, "📝 Өтініш жасау", url);
  await prisma.forwardDraft.update({
    where: { id: draft.id },
    data: {
      promptChatId: sent ? chatId : null,
      promptMessageId: sent ? sent.message_id : null,
    },
  });
}
