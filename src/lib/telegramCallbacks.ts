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

// "Сообщить в чат, что решено" — единственный автоответ, который
// утверждает факт, поэтому уходит только по явному нажатию (см.
// src/lib/autoReply.ts). Предлагается после сохранения заметки о решении и
// только если решение пришло из разбора: если агент сам написал в группе
// "жөңделді", там уже всё сказано.
export const NOTIFY_RESOLVED_PREFIX = "notify_resolved:";
// "Решить как в прошлый раз" — применяет заметку похожего уже решённого
// тикета (см. src/lib/solutionLibrary.ts). В callback_data кладём только id
// текущего тикета: подсказка пересчитывается в момент нажатия, иначе id
// обоих тикетов не влезли бы в лимит Telegram в 64 байта.
export const SOLVE_LIKE_PREFIX = "solve_like:";
// Подтверждение рассылки объявления по всем привязанным группам (см.
// /broadcast). Сам текст в callback_data не влезет, поэтому лежит в
// BroadcastDraft, а сюда попадает только его id.
export const BROADCAST_SEND_PREFIX = "bcast_send:";
export const BROADCAST_CANCEL_PREFIX = "bcast_cancel:";

// Управление тем, что бот уже сказал в группе, из личного чата: показать
// список и удалить конкретное сообщение. На сайте это же есть на карточке
// тикета, но дежурный сидит в телефоне, а не на сайте, — значит и убрать
// неудачный ответ надо уметь оттуда же.
export const BOT_REPLIES_PREFIX = "bot_replies:";
export const BOT_REPLY_DELETE_PREFIX = "br_del:";
// Подтверждение "да, это решено" на догадку бота по реплике агента в
// группе (см. detectAgentIntent) — ведёт в тот же запрос заметки.
export const CONFIRM_RESOLVED_PREFIX = "confirm_resolved:";
// Выбор тикета, когда агент написал в группе без Reply и кандидатов
// несколько (см. lib/agentThread.ts). Формат: "at:<STATUS>:<issueId>" —
// статус нужен здесь же, иначе после нажатия непонятно, что делать, а
// второй cuid в 64 байта callback_data уже не влезет.
export const AGENT_TARGET_PREFIX = "at:";
// "Отметить решённым вместе с заметкой, которая уже показана в сообщении".
// Сам текст заметки в callback_data не влезает (64 байта), поэтому
// читается из текста сообщения — см. RESOLVED_NOTE_LINE в вебхуке.
export const RESOLVE_WITH_DRAFT_PREFIX = "rd:";
