import { prisma } from "@/lib/prisma";
import { pickRecipient } from "@/lib/dailyReview";
import { todayDateString } from "@/lib/date";
import {
  buildAckText,
  greeting,
  pickLanguage,
  type AckAskKind,
} from "@/lib/autoReply";
import {
  buildSituationAck,
  missingSlotsFor,
  SITUATIONS,
  type SituationId,
  type SlotId,
} from "@/lib/situations";
import { sendTelegramMessage } from "@/lib/telegram";
import { AUTO_REPLY_PICK_PREFIX } from "@/lib/telegramCallbacks";

// Подтверждение автоответа в личке.
//
// Автоответы — единственная фича, которая пишет от имени школы туда, где
// сидят коллеги, и именно поэтому она годами стояла выключенной: включить
// её значило разом отдать боту право говорить за тебя. Промежуточного
// состояния не было — либо бот молчит, либо пишет сам.
//
// Здесь оно появляется: бот показывает дежурному, что собирается сказать,
// и ждёт нажатия. Ответ уходит только по кнопке, поэтому включённый режим
// не может ничего испортить — худшее, что бывает, это неотправленный
// черновик.

// Сколько вариантов показываем. Два-три осмысленных лучше пяти похожих:
// выбор из длинного списка дороже, чем набрать свой текст.
const MAX_VARIANTS = 3;

// Варианты ответа на одно обращение. Первый — то, что бот отправил бы сам;
// остальные отличаются не формулировкой, а решением: просить данные или
// нет. Именно в этом бот ошибается чаще всего, и именно это дешевле
// поправить нажатием, чем набирая текст.
export function buildReplyVariants(params: {
  incomingText: string;
  situation: SituationId | null;
  missing: SlotId[];
  fallbackAskKind: AckAskKind;
  now?: Date;
}): string[] {
  const { incomingText, situation, missing, fallbackAskKind } = params;
  const now = params.now ?? new Date();
  const variants: string[] = [];

  if (situation) {
    variants.push(buildSituationAck(incomingText, situation, missing, now));
    // Тот же ответ без просьбы: живой агент просит данные лишь в каждом
    // пятом обращении, так что «просто принять» — частая правка.
    if (missing.length > 0) {
      variants.push(buildSituationAck(incomingText, situation, [], now));
    }
    // Наоборот: ситуация без просьбы, но данных явно не хватает — даём
    // вариант со стандартной просьбой по этой же ситуации.
    if (missing.length === 0 && SITUATIONS[situation].slots.length > 0) {
      variants.push(
        buildSituationAck(
          incomingText,
          situation,
          SITUATIONS[situation].slots.slice(0, 1),
          now
        )
      );
    }
  } else {
    variants.push(buildAckText(incomingText, now, fallbackAskKind));
    if (fallbackAskKind !== "none") {
      variants.push(buildAckText(incomingText, now, "none"));
    }
  }

  // Нейтральный запасной вариант — годится всегда и ничего не обещает
  // сверх «посмотрим».
  const language = pickLanguage(incomingText);
  variants.push(
    `${greeting(language, now)}, ${
      language === "kk"
        ? "жақсы, қарап кб беретін боламыз"
        : "хорошо, посмотрим и дадим обратную связь"
    }`
  );

  return Array.from(new Set(variants)).slice(0, MAX_VARIANTS);
}

// Отправляет дежурному вопрос «так ли писать?» и запоминает черновик.
// false — спросить не у кого (не настроены Telegram-id агентов) или не
// доставилось; вызывающий код тогда просто ничего не пишет в группу:
// раз режим подтверждения включён, «не смогли спросить» не повод
// отправить без спроса.
export async function requestAutoReplyApproval(params: {
  issueId: string;
  groupName: string;
  incomingText: string;
  targetChatId: string;
  targetMessageId: number;
  variants: string[];
}): Promise<boolean> {
  const { issueId, groupName, incomingText, variants } = params;
  if (variants.length === 0) return false;

  const recipientId = await pickRecipient(todayDateString());
  if (recipientId == null) return false;

  const numbered = variants
    .map((text, index) => `${index + 1}) ${text}`)
    .join("\n\n");
  const prompt = await sendTelegramMessage(
    recipientId,
    [
      `🤖 Ответить в «${groupName}»?`,
      "",
      `Обращение: ${incomingText.trim().slice(0, 300)}`,
      "",
      numbered,
      "",
      "Свой текст — ответь реплаем на это сообщение.",
    ].join("\n"),
    [
      variants.map((_, index) => ({
        text: `✅ ${index + 1}`,
        callback_data: `${AUTO_REPLY_PICK_PREFIX}${index}`,
      })),
      [
        {
          text: "🚫 Не отвечать",
          callback_data: `${AUTO_REPLY_PICK_PREFIX}x`,
        },
      ],
    ]
  );
  if (!prompt) return false;

  await prisma.pendingAutoReply.create({
    data: {
      chatId: String(recipientId),
      messageId: prompt.message_id,
      issueId,
      targetChatId: params.targetChatId,
      targetMessageId: params.targetMessageId,
      variants,
    },
  });
  return true;
}
