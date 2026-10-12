import { randomUUID } from "node:crypto";
import { prisma } from "./prisma";
import { pickRecipient } from "./dailyReview";
import { todayDateString } from "./date";
import { agentTelegramEntries, isAgentTelegramId, telegramIdToAgent } from "./agentTelegram";
import { isParentAccessBotEnabled } from "./settings";
import { findParentAccounts, getParentAccount, requestParentCredentials, platformEnabled } from "./platform";
import { parentContacts, UUID_PATTERN, type ParentAccount } from "./parentAccess";
import { classifyParentAccessIntent } from "./parentAccessIntent";
import { maskSensitiveForAi } from "./textClean";
import { approveParentAccess, parentApprovalAuthorized, type ParentBotStatus } from "./parentAccessBotCore";
import { sendTelegramMessage, answerCallbackQuery, editMessageText, buildMessageLink, type TelegramCallbackQuery } from "./telegram";

const PREFIX = "parent_access:";

export function parentAccessBotReady(): boolean {
  return platformEnabled() && Boolean(process.env.GROQ_API_KEY?.trim()) &&
    Boolean(process.env.TELEGRAM_BOT_TOKEN) && agentTelegramEntries().some(([, id]) => Number.isSafeInteger(id) && id > 0);
}

// Also called after contact follow-ups. A durable issue+parent key prevents duplicate prompts/resets.
export async function requestParentAccessApproval(params: {
  issueId: string; chatId: string; messageId: number; incomingText: string;
}): Promise<boolean> {
  try {
    if (!parentAccessBotReady() || !(await isParentAccessBotEnabled())) return false;
    const issue = await prisma.issue.findUnique({ where: { id: params.issueId },
      select: { description: true, groupName: true, status: true, telegramLink: true } });
    if (!issue || issue.status === "RESOLVED") return false;
    const sources = await prisma.telegramMessage.findMany({
      where: { usedForIssueId: params.issueId, chatId: params.chatId },
      orderBy: { receivedAt: "desc" }, take: 10, select: { text: true, messageId: true, messageLink: true },
    });
    const text = [params.incomingText, issue.description, ...sources.map((m) => m.text)].filter(Boolean).join("\n");
    const contacts = parentContacts(text, false);
    if (!contacts.length || contacts.length > 10) return false;
    if (await classifyParentAccessIntent(text) !== true) return false;
    const recipientId = await pickRecipient(todayDateString());
    if (recipientId === null) return false;
    const candidates = new Map<string, ParentAccount>();
    for (let offset = 0; offset < contacts.length; offset += 3) {
      const lookups = await Promise.allSettled(contacts.slice(offset, offset + 3).map(findParentAccounts));
      for (const result of lookups) {
        if (result.status !== "fulfilled") continue;
        for (const account of result.value.parents) candidates.set(account.id, {
          id: account.id, name: account.name, login: account.login,
          phoneNumber: account.phoneNumber, students: account.students,
        });
      }
    }
    // Ambiguous matches remain a manual search; do not truncate the list silently.
    if (!candidates.size || candidates.size > 10) return false;
    const original = issue.telegramLink ? await prisma.telegramMessage.findFirst({
      where: { messageLink: issue.telegramLink, chatId: params.chatId, usedForIssueId: params.issueId },
      select: { messageId: true, text: true },
    }) : null;
    const targetMessageId = original?.messageId ?? params.messageId;
    let handled = false;
    for (const account of candidates.values()) {
      const row = await prisma.pendingParentAccess.upsert({
        where: { issueId_parentId: { issueId: params.issueId, parentId: account.id } },
        create: { id: randomUUID(), issueId: params.issueId, parentId: account.id,
          account, recipientId: String(recipientId), targetChatId: params.chatId, targetMessageId },
        update: {},
      });
      if (row.status !== "PENDING" || row.dmMessageId !== null) { handled = true; continue; }
      // Claim notification before Telegram: parallel webhooks cannot send duplicate approval cards.
      const reserved = await prisma.pendingParentAccess.updateMany({
        where: { id: row.id, dmMessageId: null, status: "PENDING" }, data: { dmMessageId: -1 },
      });
      if (reserved.count !== 1) { handled = true; continue; }
      const prompt = await sendTelegramMessage(recipientId, [
        `🔐 Groq: обращение про вход родителя · ${issue.groupName}`,
        `Обращение: ${maskSensitiveForAi(original?.text ?? params.incomingText).slice(0, 500)}`,
        buildMessageLink(Number(params.chatId), targetMessageId), "",
        `Родитель: ${account.name}`, `Логин: ${account.login}`,
        `Телефон: ${account.phoneNumber ?? "не указан"}`,
        "Связанные ученики:", ...account.students.slice(0, 8).map((s) => `• ${s.name} · ${s.login}`),
        "", "Получить и отправить логин/пароль ответом на это обращение в рабочем чате?",
        "Кнопка сбросит пароль через платформу; платформа также уведомит родителя.",
      ].join("\n"), [[{ text: "✅ Получить и отправить", callback_data: `${PREFIX}${row.id}:send` }],
        [{ text: "🚫 Не отправлять", callback_data: `${PREFIX}${row.id}:skip` }]]);
      await prisma.pendingParentAccess.update({ where: { id: row.id }, data: {
        dmMessageId: prompt?.message_id ?? -1, ...(!prompt ? { status: "FAILED" } : {}),
      } });
      handled = Boolean(prompt) || handled;
    }
    return handled;
  } catch {
    console.warn("[parent-access-bot] Не удалось подготовить предложение; обычный приём обращения продолжается");
    return false;
  }
}

const OUTCOME: Record<ParentBotStatus, string> = {
  SENT: "✅ Логин и пароль отправлены ответом на обращение.",
  FAILED: "Действие остановлено до сброса. Проверьте аккаунт через «Доступ родителя» на сайте.",
  UNCERTAIN: "Платформа не подтвердила результат сброса. Проверьте его вручную; повтор автоматически не выполняется.",
  DELIVERY_FAILED: "Пароль получен, но доставка в чат не подтверждена. Платформа уведомляет родителя; проверьте чат и аккаунт вручную. Автоповтора нет.",
};

export async function handleParentAccessCallback(query: TelegramCallbackQuery): Promise<boolean> {
  if (!query.data?.startsWith(PREFIX)) return false;
  const [id, action] = query.data.slice(PREFIX.length).split(":");
  if (!UUID_PATTERN.test(id ?? "") || !["send", "skip"].includes(action)) {
    await answerCallbackQuery(query.id, "Неизвестное действие"); return true;
  }
  const row = await prisma.pendingParentAccess.findUnique({ where: { id } });
  const message = query.message;
  if (!row || !message || !isAgentTelegramId(query.from.id) ||
    !parentApprovalAuthorized(row, { fromId: query.from.id, chatId: message.chat.id,
      messageId: message.message_id, privateChat: message.chat.type === "private" })) {
    await answerCallbackQuery(query.id, "Кнопка недоступна или устарела. Откройте поиск на сайте.", true);
    return true;
  }
  if (action === "skip") {
    const changed = await prisma.pendingParentAccess.updateMany({ where: { id, status: "PENDING" }, data: { status: "DECLINED" } });
    await answerCallbackQuery(query.id, changed.count ? "Отправка отменена" : "Уже обработано");
    if (changed.count) await editMessageText(message.chat.id, message.message_id, "🚫 Отправка данных родителя отменена.");
    return true;
  }
  if (action !== "send") { await answerCallbackQuery(query.id, "Неизвестное действие"); return true; }
  if (row.status !== "PENDING") {
    await answerCallbackQuery(query.id, "Уже обработано; повторный сброс не выполняется", true); return true;
  }
  if (!platformEnabled() || !(await isParentAccessBotEnabled())) {
    await answerCallbackQuery(query.id, "Помощь родителям выключена или платформа недоступна", true); return true;
  }
  const issue = await prisma.issue.findUnique({ where: { id: row.issueId }, select: { status: true } });
  if (!issue || issue.status === "RESOLVED") {
    await answerCallbackQuery(query.id, "Тикет удалён или уже решён", true); return true;
  }
  await answerCallbackQuery(query.id, "Проверяю аккаунт и отправляю…");
  const status = await approveParentAccess(row.account as unknown as ParentAccount, {
    claim: async () => (await prisma.pendingParentAccess.updateMany({ where: { id, status: "PENDING" }, data: { status: "PROCESSING" } })).count === 1,
    read: getParentAccount,
    begin: async () => { await prisma.parentAccessReset.create({ data: { id, parentId: row.parentId,
      actor: telegramIdToAgent(query.from.id) ?? `telegram:${query.from.id}`,
      studentIds: (row.account as unknown as ParentAccount).students.map((s) => s.id) } }); },
    reset: requestParentCredentials,
    audit: async (status) => { await prisma.parentAccessReset.update({ where: { id }, data: { status } }); },
    // Never use sendBotReply: that helper persists full text in the Support database.
    send: async (text) => Boolean(await sendTelegramMessage(row.targetChatId, text, undefined,
      undefined, undefined, row.targetMessageId, false)),
    finish: async (status) => { await prisma.pendingParentAccess.update({ where: { id }, data: { status } }); },
  });
  if (status !== "ALREADY_HANDLED") await editMessageText(message.chat.id, message.message_id,
    `${OUTCOME[status]}\n${buildMessageLink(Number(row.targetChatId), row.targetMessageId)}`);
  return true;
}
