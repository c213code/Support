// Сброс результата БТ/ДТ из Telegram одной кнопкой.
//
// Куратор пишет в рабочей группе «БТ қайта ашып беріңізші» и почту ученика —
// раньше агент шёл на сайт (/platform/reset-unt), выбирал тест, продукт и
// вбивал почту заново. Теперь бот сам находит завершённый результат ученика
// в тестах, которые идут прямо сейчас, и присылает дежурному в личку
// карточку с кнопкой. В рабочую группу по этому поводу не уходит ничего:
// управление ботом живёт только в личке (см. CLAUDE.md).
//
// Удаление необратимо, поэтому бот только предлагает. Удаляет — нажатие
// кнопки тем самым агентом, которому пришла карточка, и через ту же
// resetUntResult, что и сайт (перепроверка FINISHED прямо перед DELETE).
import { randomUUID } from "node:crypto";
import { prisma } from "./prisma";
import { pickRecipient } from "./dailyReview";
import { todayDateString } from "./date";
import { agentTelegramEntries, isAgentTelegramId, telegramIdToAgent } from "./agentTelegram";
import { isUntResetBotEnabled } from "./settings";
import { listUntTests, getUntProducts, platformEnabled, PlatformError, type UntTestSummary } from "./platform";
import { mentionsUntTest } from "./untResetRequest";
import { parseUntBatch, normalizeBatchName, type BatchStudent } from "./untBatch";
import { searchUntResults, resetUntResult, type UntSearchRow } from "./untReset";
import { parentApprovalAuthorized } from "./parentAccessBotCore";
import { UUID_PATTERN } from "./parentAccess";
import {
  sendTelegramMessage, answerCallbackQuery, editMessageText, buildMessageLink,
  type TelegramCallbackQuery,
} from "./telegram";

const PREFIX = "unt_reset:";
// Больше карточек за одно сообщение — это уже пачка, для неё на сайте есть
// режим «Список из текста» со сверкой каждой записи.
const MAX_CARDS = 10;
const ALMATY_OFFSET_MS = 5 * 60 * 60 * 1000;

export function untResetBotReady(): boolean {
  return platformEnabled() && Boolean(process.env.TELEGRAM_BOT_TOKEN) &&
    agentTelegramEntries().some(([, id]) => Number.isSafeInteger(id) && id > 0);
}

// Ученики из сообщения — только если в нём есть «БТ»/«ДТ»/«деңгей» и хоть
// какие-то данные ученика (почта, телефон или имя). Разбор тот же, что у
// режима «Список из текста» на сайте.
export function extractUntResetStudents(text: string): BatchStudent[] {
  if (!mentionsUntTest(text)) return [];
  try {
    return parseUntBatch(text).students;
  } catch {
    // Слишком длинный текст или больше 50 учеников — это не одиночная
    // просьба, а пачка: её разбирают на сайте.
    return [];
  }
}

// Идёт ли тест сейчас. Платформа отдаёт время без часового пояса, и на сайте
// его читает браузер агента (Алматы), а здесь — сервер (UTC). Чтобы не
// пропустить идущий тест из-за пяти часов разницы, считаем открытым тест,
// который открыт хотя бы при одном из двух прочтений.
function isOpenNow(test: UntTestSummary, now: number): boolean {
  if (!test.openTime || !test.endTime) return false;
  const utc = (value: string) => new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`).getTime();
  const open = utc(test.openTime); const end = utc(test.endTime);
  if (!Number.isFinite(open) || !Number.isFinite(end)) return false;
  return open - ALMATY_OFFSET_MS <= now && now <= end;
}

type Found = { row: UntSearchRow; test: UntTestSummary; matchedBy: "contact" | "name" };

// Все слова имени из сообщения есть в имени из отчёта — иначе это
// однофамилец, а не тот ученик.
function sameName(wanted: string, fullName: string): boolean {
  const have = new Set(normalizeBatchName(fullName).split(" "));
  const words = normalizeBatchName(wanted).split(" ").filter(Boolean);
  return words.length >= 2 && words.every((w) => have.has(w));
}

async function findInTest(test: UntTestSummary, product: string, student: BatchStudent): Promise<Found[]> {
  const found: Found[] = [];
  for (const contact of [...student.emails, ...student.phones]) {
    const { results, fallback } = await searchUntResults(test.id, product, contact);
    // fallback "searched" — по почте пусто, строки найдены по фамилии в
    // комбинации ученика: это может быть однофамилец, нужна сверка.
    const matchedBy = fallback?.status === "searched" ? "name" : "contact";
    found.push(...results.map((row) => ({ row, test, matchedBy }) as Found));
  }
  if (found.length === 0 && student.name) {
    // Только имя: сначала как написано, потом по первому слову (обычно
    // фамилия) — и оставляем только строки, где совпали все слова имени.
    for (const query of [...new Set([student.name, student.name.split(/\s+/)[0]])]) {
      const { results } = await searchUntResults(test.id, product, query);
      const same = results.filter((row) => sameName(student.name, row.fullName));
      found.push(...same.map((row) => ({ row, test, matchedBy: "name" }) as Found));
      if (same.length > 0) break;
    }
  }
  return found;
}

function finishedAt(finishTime: string | null): string {
  // Как на сайте: показываем время так, как его отдала платформа.
  const m = finishTime?.match(/^\d{4}-(\d\d)-(\d\d)T(\d\d:\d\d)/);
  return m ? `${m[2]}.${m[1]} ${m[3]}` : "—";
}

// Вызывается из приёма сообщений вебхука рядом с requestParentAccessApproval.
// Никогда не бросает: сбой предложения не должен ломать приём обращения.
// true — карточка по этому обращению отправлена (сейчас или раньше).
export async function requestUntResetApproval(params: {
  issueId: string; chatId: string; messageId: number; incomingText: string;
}): Promise<boolean> {
  try {
    if (!untResetBotReady()) return false;
    // Сообщения одного автора склеиваются в тикет: «БТ өшіріп беріңізші» и
    // почта следом — два сообщения, читаем их вместе.
    const sources = await prisma.telegramMessage.findMany({
      where: { usedForIssueId: params.issueId, chatId: params.chatId },
      orderBy: { receivedAt: "desc" }, take: 10, select: { text: true },
    });
    const text = [...new Set([params.incomingText, ...sources.map((m) => m.text)])].filter(Boolean).join("\n");
    const students = extractUntResetStudents(text);
    if (!students.length || !(await isUntResetBotEnabled())) return false;

    const now = Date.now();
    const tests = (await listUntTests()).filter((t) => t.published && isOpenNow(t, now));
    if (!tests.length) return false;

    // Тариф ученика отдельно не выясняем: у SMART и JUNIOR разные тесты, и
    // результат ученика найдётся только в тесте его тарифа.
    const found = new Map<string, Found>();
    for (const test of tests) {
      for (const product of await getUntProducts(test.id)) {
        for (const student of students) {
          for (const hit of await findInTest(test, product, student)) {
            // Только завершённые: удалить попытку в процессе — потерять
            // прогресс ученика (то же правило, что на сайте).
            if (hit.row.status !== "FINISHED" || !hit.row.finishTime) continue;
            const before = found.get(hit.row.resultId);
            if (!before || (before.matchedBy === "name" && hit.matchedBy === "contact")) {
              found.set(hit.row.resultId, hit);
            }
          }
        }
      }
    }
    if (!found.size || found.size > MAX_CARDS) return false;

    const recipientId = await pickRecipient(todayDateString());
    if (recipientId === null) return false;
    const issue = await prisma.issue.findUnique({ where: { id: params.issueId }, select: { groupName: true } });

    let handled = false;
    for (const { row, test, matchedBy } of found.values()) {
      const id = randomUUID();
      // resultId уникален: запись создаётся до отправки, поэтому два
      // параллельных вебхука не пришлют две карточки по одному результату.
      try {
        await prisma.pendingUntReset.create({ data: {
          id, resultId: row.resultId, untId: test.id, untName: test.name,
          studentName: row.fullName, studentEmail: row.studentEmail, score: Math.round(row.score),
          matchedBy, recipientId: String(recipientId),
          sourceChatId: params.chatId, sourceMessageId: params.messageId,
        } });
      } catch {
        handled = true; // карточка по этому результату уже была
        continue;
      }
      const prompt = await sendTelegramMessage(recipientId, [
        `↻ Сброс БТ/ДТ${issue?.groupName ? ` · ${issue.groupName}` : ""}`,
        `Ученик: ${row.fullName}${row.studentEmail ? ` · ${row.studentEmail}` : ""}`,
        `Тест: ${test.name}`,
        `Балл: ${Math.round(row.score)} · завершил ${finishedAt(row.finishTime)}`,
        ...(matchedBy === "name"
          ? ["", "⚠️ Найден по имени, а не по почте или телефону — сверьте, что это тот ученик."]
          : []),
        "", `Обращение: ${buildMessageLink(Number(params.chatId), params.messageId)}`,
        "Удаление необратимо: результат исчезнет, ученик сможет пройти тест заново.",
      ].join("\n"), [
        [{ text: "🗑 Удалить результат", callback_data: `${PREFIX}${id}:del` }],
        [{ text: "Не трогать", callback_data: `${PREFIX}${id}:skip` }],
      ]);
      if (!prompt) {
        // Карточка не дошла — убираем запись, чтобы следующее сообщение
        // по этому обращению могло предложить снова.
        await prisma.pendingUntReset.delete({ where: { id } }).catch(() => undefined);
        continue;
      }
      await prisma.pendingUntReset.update({ where: { id }, data: { dmMessageId: prompt.message_id } });
      handled = true;
    }
    return handled;
  } catch (err) {
    console.warn(`[unt-reset-bot] Не удалось подготовить предложение сброса: ${String(err)}`);
    return false;
  }
}

export async function handleUntResetCallback(query: TelegramCallbackQuery): Promise<boolean> {
  if (!query.data?.startsWith(PREFIX)) return false;
  const [id, action] = query.data.slice(PREFIX.length).split(":");
  if (!UUID_PATTERN.test(id ?? "") || !["del", "skip"].includes(action)) {
    await answerCallbackQuery(query.id, "Неизвестное действие"); return true;
  }
  const row = await prisma.pendingUntReset.findUnique({ where: { id } });
  const message = query.message;
  // Кнопка — только у своего агента, только в его личке, только под той
  // самой карточкой и только сутки.
  if (!row || !message || !isAgentTelegramId(query.from.id) ||
    !parentApprovalAuthorized(row, { fromId: query.from.id, chatId: message.chat.id,
      messageId: message.message_id, privateChat: message.chat.type === "private" })) {
    await answerCallbackQuery(query.id, "Кнопка недоступна или устарела. Откройте «Обнуление ДТ» на сайте.", true);
    return true;
  }
  const title = `${row.studentName} · ${row.untName}`;
  if (action === "skip") {
    const changed = await prisma.pendingUntReset.updateMany({ where: { id, status: "PENDING" }, data: { status: "DECLINED" } });
    await answerCallbackQuery(query.id, changed.count ? "Оставили как есть" : "Уже обработано");
    if (changed.count) await editMessageText(message.chat.id, message.message_id, `Результат не тронут.\n${title}`);
    return true;
  }
  if (row.status !== "PENDING") {
    await answerCallbackQuery(query.id, "Уже обработано; повторно не удаляем", true); return true;
  }
  if (!platformEnabled() || !(await isUntResetBotEnabled())) {
    await answerCallbackQuery(query.id, "Сброс из Telegram выключен или платформа недоступна", true); return true;
  }
  // Захват до удаления: из двух нажатий подряд дальше пройдёт только одно.
  const claimed = await prisma.pendingUntReset.updateMany({ where: { id, status: "PENDING" }, data: { status: "PROCESSING" } });
  if (claimed.count !== 1) {
    await answerCallbackQuery(query.id, "Уже обработано; повторно не удаляем", true); return true;
  }
  await answerCallbackQuery(query.id, "Проверяю и удаляю…");

  let status: "DONE" | "FAILED" | "UNCERTAIN";
  let outcome: string;
  try {
    const result = await resetUntResult({ resultId: row.resultId, untId: row.untId, untName: row.untName,
      actor: telegramIdToAgent(query.from.id) ?? `telegram:${query.from.id}` });
    if (result.ok) {
      status = "DONE"; outcome = "✅ Результат удалён, ученик может пройти тест заново.";
    } else {
      status = "FAILED"; outcome = "Не удалено: результат уже не в статусе «завершён» — ученик, похоже, решает снова.";
    }
  } catch (err) {
    if (err instanceof PlatformError && err.code === "not_found") {
      status = "FAILED"; outcome = "Не удалено: результата на платформе уже нет — возможно, его удалили раньше.";
    } else {
      // Платформа не ответила внятно — удалилось или нет, неизвестно.
      // Повторять сами не будем: это необратимое действие.
      status = "UNCERTAIN";
      outcome = "Платформа не подтвердила удаление. Проверьте результат в «Обнуление ДТ» на сайте; повтор автоматически не выполняется.";
      console.warn(`[unt-reset-bot] сброс ${row.resultId} не подтверждён: ${String(err)}`);
    }
  }
  await prisma.pendingUntReset.update({ where: { id }, data: { status } });
  await editMessageText(message.chat.id, message.message_id,
    `${outcome}\n${title}\n${buildMessageLink(Number(row.sourceChatId), row.sourceMessageId)}`);
  return true;
}
