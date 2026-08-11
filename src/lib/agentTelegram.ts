// Сопоставление постоянных агентов их личным Telegram id — нужно для (1)
// определения "кто сегодня активнее всех писал в привязанных чатах"
// (вечерняя сводка шлётся именно ему, см. /api/cron/evening-report), и
// (2) обратного маппинга, когда статус тикета меняют inline-кнопкой в
// Telegram — по callback_query.from.id понимаем, какой агент нажал, и
// переоформляем автора тикета с "Бот" на него, как и при обычном PATCH.
//
// Формат: "Ерош:123456789,Алпа:987654321" — те же id, что в
// OWN_AGENT_TELEGRAM_IDS (см. lib/telegram.ts), но с именами. Отдельная
// переменная, а не переиспользование той: OWN_AGENT_TELEGRAM_IDS уже
// работает в проде как список для фильтрации, и незачем требовать сразу
// поменять её формат ради новой фичи.
const AGENT_TELEGRAM_IDS_ENV = "AGENT_TELEGRAM_IDS";

function parseAgentTelegramIds(): Array<[string, number]> {
  const raw = process.env[AGENT_TELEGRAM_IDS_ENV] ?? "";
  return raw
    .split(",")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const [name, idStr] = pair.split(":").map((s) => s.trim());
      return [name, Number(idStr)] as [string, number];
    })
    .filter(
      ([name, id]) => Boolean(name) && Number.isFinite(id) && id !== 0
    );
}

export function agentTelegramEntries(): Array<[string, number]> {
  return parseAgentTelegramIds();
}

export function telegramIdToAgent(id: number): string | null {
  const entry = parseAgentTelegramIds().find(([, agentId]) => agentId === id);
  return entry?.[0] ?? null;
}
