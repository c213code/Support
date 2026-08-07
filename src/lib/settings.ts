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
