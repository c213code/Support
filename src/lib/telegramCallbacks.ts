// Префиксы callback_data инлайн-кнопок Telegram — общие между тем, кто их
// строит (dailyReview.ts — список тикетов и кнопки под ним), и вебхуком,
// который их парсит (handleCallbackQuery). Вынесено в отдельный файл,
// чтобы не дублировать литералы в двух местах с риском разъехаться.
export const ISSUE_STATUS_PREFIX = "issue_status:";
export const REPORT_SEND_PREFIX = "report_send:";
export const ISSUE_ESCALATE_PREFIX = "issue_escalate:";
// Короче остальных не для красоты — callback_data режется Telegram-ом на
// 64 байтах, а тут после префикса ещё cuid (25 байт) + разделитель + имя
// команды (до 12 байт для "Мобайл" в UTF-8), запас лучше не тратить на
// многословный префикс.
export const ISSUE_ESCALATE_TEAM_PREFIX = "esc_team:";
export const ISSUE_NOTE_PREFIX = "issue_note:";
export const REFRESH_LIST_PREFIX = "refresh_list:";
