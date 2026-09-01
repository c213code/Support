import { prisma } from "@/lib/prisma";
import { todayDateString } from "@/lib/date";
import { telegramIdToAgent } from "@/lib/agentTelegram";
import { sendTelegramMessage } from "@/lib/telegram";
import { buildReviewSummary, startReviewSession } from "@/lib/dailyReview";
import { startDedupeReview } from "@/lib/dedupeReview";
import { sendReportToGroup, describeSendFailure } from "@/lib/reportSend";
import {
  isAutoReplyEnabled,
  setAutoReplyEnabled,
  isChatIntentEnabled,
  setChatIntentEnabled,
} from "@/lib/settings";
import {
  BROADCAST_SEND_PREFIX,
  BROADCAST_CANCEL_PREFIX,
} from "@/lib/telegramCallbacks";

// Слэш-команды в личке с ботом ("посмотреть репорт, не заходя на сайт" — в
// любой момент дня, а не только когда придёт вечерняя сводка). Работают
// только для известных агентов (AGENT_TELEGRAM_IDS) и только в приватном
// чате — не в группах поддержки, куда пишут клиенты: там ответ бота на
// команду был бы виден им, а данные внутренние.
//
// Вынесено из webhook/route.ts как самый изолированный блок бота: зависит
// только от импортированных lib-функций, поведение не меняется.

const HELP_TEXT = [
  "Команды доступны только в личке с ботом:",
  "",
  "/report [дата] — актуальный репорт (то же, что вечерняя сводка), можно в любое время дня",
  "/send [дата] — отправить репорт в рабочую группу (если уже отправляли за эту дату — просто скажет, когда)",
  "/dedupe [дата] — найти и разобрать похожие тикеты (ИИ-подсказка, объединение по одному)",
  "/review [дата] — начать разбор тикетов по одному",
  "/autoreply [on|off] — автоответы бота в рабочих группах; без аргумента покажет состояние",
  "/readchat [on|off] — бот читает твои реплики в группе и сам ставит статусы",
  "/broadcast <текст> — разослать объявление во все рабочие группы (спросит подтверждение)",
  "",
  "Без даты — за сегодня. Дата — в формате YYYY-MM-DD.",
].join("\n");

const AUTOREPLY_HELP = [
  "Когда включено, бот отвечает в рабочих группах:",
  "• на новое обращение — «жақсы, қарап кб беретін боламыз», и просит то, чего не хватает;",
  "• при смене статуса на сайте или в разборе — «жұмысқа алдық» / «әріптестеріме жібердім»;",
  "• если написали повторно по решённому — извиняется за задержку.",
  "",
  "По умолчанию новое обращение бот сначала показывает здесь, в личке: черновик с вариантами, в группу уходит только по кнопке. Отключается тумблером «🙋 Спрашивать перед ответом» на сайте.",
  "",
  "Бот молчит там, где ты уже ответил сам, — и наоборот, твоя реплика в группе сама двигает статус.",
  "«Решено» в чат уходит только по твоей кнопке.",
  "",
  "Включить: /autoreply on · Выключить: /autoreply off",
].join("\n");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function handleBotCommand(
  chatId: number,
  fromId: number,
  text: string
): Promise<void> {
  const actorName = telegramIdToAgent(fromId);
  if (!actorName) {
    await sendTelegramMessage(
      chatId,
      "Не узнал тебя — попроси добавить твой Telegram id в AGENT_TELEGRAM_IDS."
    );
    return;
  }

  const [rawCommand, dateArg] = text.trim().split(/\s+/);
  // "@BotName" в конце команды — Telegram сам дописывает его в группах,
  // где бот один из нескольких; в личке не встречается, но парсим на
  // всякий случай тем же кодом.
  const command = rawCommand.split("@")[0].toLowerCase();
  const reportDate = dateArg && DATE_RE.test(dateArg) ? dateArg : todayDateString();

  switch (command) {
    case "/start":
    case "/help": {
      await sendTelegramMessage(chatId, HELP_TEXT);
      return;
    }

    case "/report": {
      const summary = await buildReviewSummary(reportDate);
      if (!summary) {
        await sendTelegramMessage(chatId, `За ${reportDate} тикетов нет.`);
        return;
      }
      await sendTelegramMessage(chatId, summary.text, summary.keyboard);
      return;
    }

    case "/send": {
      const result = await sendReportToGroup(reportDate);
      if (!result.ok) {
        await sendTelegramMessage(chatId, describeSendFailure(result));
        return;
      }
      await sendTelegramMessage(chatId, "Отправлено в группу ✅");
      return;
    }

    case "/dedupe": {
      await startDedupeReview(chatId, reportDate);
      return;
    }

    case "/review": {
      await startReviewSession(chatId, reportDate);
      return;
    }

    case "/broadcast": {
      // Текст берём из исходного сообщения целиком, а не из разобранных
      // аргументов: объявление обычно многострочное, и склеивать его
      // обратно из токенов бессмысленно.
      const announcement = text.slice(rawCommand.length).trim();
      if (!announcement) {
        await sendTelegramMessage(
          chatId,
          "Напиши текст объявления после команды:\n/broadcast Қайырлы күн, ПФ да жөңдеу жұмыстары жүріп жатыр"
        );
        return;
      }

      const presets = await prisma.groupPreset.findMany({
        where: { chatId: { not: null } },
        orderBy: { order: "asc" },
      });
      if (presets.length === 0) {
        await sendTelegramMessage(chatId, "Нет ни одной группы с привязанным чатом.");
        return;
      }

      const draft = await prisma.broadcastDraft.create({ data: { text: announcement } });
      await sendTelegramMessage(
        chatId,
        `📢 Разослать в ${presets.length} групп?\n${presets.map((p) => `• ${p.name}`).join("\n")}\n\n${announcement}`,
        [
          [
            {
              text: `📤 Отправить в ${presets.length} групп`,
              callback_data: `${BROADCAST_SEND_PREFIX}${draft.id}`,
            },
          ],
          [
            {
              text: "Отмена",
              callback_data: `${BROADCAST_CANCEL_PREFIX}${draft.id}`,
            },
          ],
        ]
      );
      return;
    }

    case "/autoreply": {
      const arg = (dateArg ?? "").toLowerCase();
      if (arg !== "on" && arg !== "off") {
        const [reply, intent] = await Promise.all([
          isAutoReplyEnabled(),
          isChatIntentEnabled(),
        ]);
        await sendTelegramMessage(
          chatId,
          [
            reply ? "🟢 Автоответы включены" : "⚪️ Автоответы выключены",
            intent ? "🟢 Чтение реплик включено" : "⚪️ Чтение реплик выключено",
            "",
            AUTOREPLY_HELP,
          ].join("\n")
        );
        return;
      }
      await setAutoReplyEnabled(arg === "on");
      await sendTelegramMessage(
        chatId,
        arg === "on"
          ? "🟢 Автоответы включены — бот начнёт отвечать в рабочих группах."
          : "⚪️ Автоответы выключены — бот больше ничего не пишет в группы."
      );
      return;
    }

    // Отдельно от /autoreply намеренно: там бот пишет коллегам, тут молча
    // меняет статусы, которые уйдут в репорт боссам. Риски разные, и
    // выключать одно, не трогая другое, надо уметь.
    case "/readchat": {
      const arg = (dateArg ?? "").toLowerCase();
      if (arg !== "on" && arg !== "off") {
        const enabled = await isChatIntentEnabled();
        await sendTelegramMessage(
          chatId,
          [
            enabled ? "🟢 Чтение реплик включено" : "⚪️ Чтение реплик выключено",
            "",
            "Когда включено, бот читает твои ответы в рабочих группах и сам ставит статусы:",
            "• «жақсы, тексеріп береміз» → В работе",
            "• «әріптестеріме жібердім» → Передано",
            "• «жөңделді» → спросит в личке и попросит заметку для репорта",
            "",
            "В группу при этом ничего не пишет — ты там уже всё сказал.",
            "",
            "Включить: /readchat on · Выключить: /readchat off",
          ].join("\n")
        );
        return;
      }
      await setChatIntentEnabled(arg === "on");
      await sendTelegramMessage(
        chatId,
        arg === "on"
          ? "🟢 Чтение реплик включено — статусы будут проставляться по твоим ответам в группах."
          : "⚪️ Чтение реплик выключено — статусы меняются только вручную."
      );
      return;
    }

    default:
      // Не наша команда (или просто сообщение начинается с "/" случайно) —
      // молча игнорируем, не шумим в личку в ответ на каждую опечатку.
      return;
  }
}
