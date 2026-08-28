import { prisma } from "@/lib/prisma";

// Единственная строка настроек на всё приложение (см. AppSetting в схеме) —
// не по агенту и не по сессии, потому что тогл "кто чистит описания, ИИ или
// регулярки" — это решение команды, а не личное предпочтение.
const SETTINGS_ID = "singleton";

export async function isAiCleaningEnabled(): Promise<boolean> {
  const row = await prisma.appSetting.findUnique({
    where: { id: SETTINGS_ID },
    select: { aiCleaningEnabled: true },
  });
  return row?.aiCleaningEnabled ?? false;
}

export async function setAiCleaningEnabled(enabled: boolean): Promise<void> {
  await prisma.appSetting.upsert({
    where: { id: SETTINGS_ID },
    update: { aiCleaningEnabled: enabled },
    create: { id: SETTINGS_ID, aiCleaningEnabled: enabled },
  });
}

// Автоответы бота в рабочие группы. Выключены по умолчанию: это
// единственная фича, которая пишет от имени школы туда, где сидят коллеги,
// поэтому включать её должен человек, а не выкатка.
export async function isAutoReplyEnabled(): Promise<boolean> {
  const row = await prisma.appSetting.findUnique({
    where: { id: SETTINGS_ID },
    select: { autoReplyEnabled: true },
  });
  return row?.autoReplyEnabled ?? false;
}

// Спрашивать в личке перед ответом в группу. Работает поверх автоответов
// и только для подтверждения приёма: реакция на смену статуса — следствие
// осознанного действия человека, её переспрашивать незачем.
export async function isAutoReplyConfirmEnabled(): Promise<boolean> {
  const row = await prisma.appSetting.findUnique({
    where: { id: SETTINGS_ID },
    select: { autoReplyConfirm: true },
  });
  return row?.autoReplyConfirm ?? true;
}

export async function setAutoReplyConfirmEnabled(
  enabled: boolean
): Promise<void> {
  await prisma.appSetting.upsert({
    where: { id: SETTINGS_ID },
    update: { autoReplyConfirm: enabled },
    create: { id: SETTINGS_ID, autoReplyConfirm: enabled },
  });
}

export async function setAutoReplyEnabled(enabled: boolean): Promise<void> {
  await prisma.appSetting.upsert({
    where: { id: SETTINGS_ID },
    update: { autoReplyEnabled: enabled },
    create: { id: SETTINGS_ID, autoReplyEnabled: enabled },
  });
}

// Обратное направление: реплика агента в группе сама двигает статус
// тикета. Рубильник отдельный от автоответов — риски разные: там бот
// пишет коллегам, тут молча меняет то, что уйдёт в репорт боссам.
export async function isChatIntentEnabled(): Promise<boolean> {
  const row = await prisma.appSetting.findUnique({
    where: { id: SETTINGS_ID },
    select: { chatIntentEnabled: true },
  });
  return row?.chatIntentEnabled ?? false;
}

export async function setChatIntentEnabled(enabled: boolean): Promise<void> {
  await prisma.appSetting.upsert({
    where: { id: SETTINGS_ID },
    update: { chatIntentEnabled: enabled },
    create: { id: SETTINGS_ID, chatIntentEnabled: enabled },
  });
}

// ИИ-уточнение решения "просить ли почту/ссылку" в автоответе — сужает
// ложные срабатывания regex-проверки (см. aiAskEnabled в schema.prisma),
// не отменяет её.
export async function isAiAskEnabled(): Promise<boolean> {
  const row = await prisma.appSetting.findUnique({
    where: { id: SETTINGS_ID },
    select: { aiAskEnabled: true },
  });
  return row?.aiAskEnabled ?? false;
}

export async function setAiAskEnabled(enabled: boolean): Promise<void> {
  await prisma.appSetting.upsert({
    where: { id: SETTINGS_ID },
    update: { aiAskEnabled: enabled },
    create: { id: SETTINGS_ID, aiAskEnabled: enabled },
  });
}
