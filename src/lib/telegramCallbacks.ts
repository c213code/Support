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
// Запускает разбор дня по одному тикету — не сама сводка (см.
// startReviewSession в dailyReview.ts), а отдельная кнопка под ней: чтобы
// сначала увидеть репорт целиком, и уже решить, начинать ли разбор сейчас.
export const START_REVIEW_PREFIX = "start_review:";
// "✅ Решено" / "⏳ Пендинг" на карточке разбора не меняют статус сразу —
// сначала спрашивают "как решили"/"что сейчас" тем же механизмом реплая,
// что и ISSUE_NOTE_PREFIX (PendingNotePrompt.targetStatus), и только по
// ответу применяют и заметку, и статус вместе.
export const ISSUE_RESOLVE_PREFIX = "issue_resolve:";
export const ISSUE_PENDING_PREFIX = "issue_pending:";
// Пропустить тикет в разборе по одному (см. advanceReviewSession в
// dailyReview.ts) — не трогает статус, просто идёт к следующему.
export const SKIP_TICKET_PREFIX = "skip_ticket:";
// Вернуться к предыдущему тикету в разборе (см. goBackReviewSession) —
// для случаев "промахнулись мимо кнопки" или "пропустили не тот".
export const BACK_TICKET_PREFIX = "back_ticket:";

// Разбор похожих (дублей) тикетов дня, найденных ИИ — та же
// один-за-одним механика, что и у разбора тикетов, только группами (см.
// dedupeReview.ts). Отдельная кнопка под сводкой, аналогично START_REVIEW_PREFIX.
export const START_DEDUPE_PREFIX = "start_dedupe:";
export const DEDUPE_MERGE_PREFIX = "dedupe_merge";
export const DEDUPE_SKIP_PREFIX = "dedupe_skip";
