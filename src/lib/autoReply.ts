import type { IssueStatus } from "@/lib/status";

// Тексты, которыми бот отвечает в рабочие группы. Все формулировки взяты
// из настоящей переписки Ероша и Алпы, а не придуманы: бот должен звучать
// как коллега, а не как система. В частности "кб" (кері байланыс) намеренно
// оставлено сокращением — именно так пишут в этих чатах.
//
// Групп-получателей четыре, переписка почти вся казахская, но не вся —
// поэтому у каждого шаблона есть русская пара (см. pickLanguage ниже).

export type ReplyLanguage = "kk" | "ru";

// Приветствие зависит от времени суток: в переписке живут и "Қайырлы күн",
// и "Қайырлы кеш", а пятая часть обращений приходит после 18:00 — бот,
// желающий доброго дня в 23:00, сразу выдаёт в себе робота.
const ALMATY_OFFSET_HOURS = 5;

export function greeting(language: ReplyLanguage, now: Date = new Date()): string {
  const hour = (now.getUTCHours() + ALMATY_OFFSET_HOURS) % 24;
  if (language === "ru") {
    if (hour < 6) return "Доброй ночи";
    if (hour < 12) return "Доброе утро";
    if (hour < 18) return "Добрый день";
    return "Добрый вечер";
  }
  if (hour < 6) return "Қайырлы түн";
  if (hour < 12) return "Қайырлы таң";
  if (hour < 18) return "Қайырлы күн";
  return "Қайырлы кеш";
}

// Казахскую речь от русской отличаем по буквам, которых в русском алфавите
// нет. Без ИИ и без внешних вызовов: этого признака достаточно, а ошибка
// в редком случае стоит куда меньше, чем поход в модель на каждое
// сообщение. Латиница/цифры/эмодзи не в счёт — если казахских букв нет, но
// и кириллицы нет вовсе, считаем язык казахским (он тут язык по умолчанию).
const KAZAKH_ONLY_LETTERS = /[әғқңөұүһі]/i;
const CYRILLIC = /[а-яё]/i;

export function pickLanguage(text: string): ReplyLanguage {
  if (KAZAKH_ONLY_LETTERS.test(text)) return "kk";
  return CYRILLIC.test(text) ? "ru" : "kk";
}

// Идентификатор, по которому вообще можно что-то найти: почта ученика,
// ссылка на урок/страницу или номер телефона. 60% обращений приходят без
// единого из них, и первый ответ агента уходит не на решение, а на "дайте
// почту" — этот круг ожидания и убираем, спрашивая сразу.
//
// Регулярки намеренно те же по смыслу, что в textClean.ts (там они
// вырезают эти данные из описания тикета) — здесь они нужны наоборот, для
// проверки наличия.
const EMAIL = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const URL = /https?:\/\/\S+/i;
const PHONE = /\+?\d[\d\-\s()]{7,}\d/;

export function hasIdentifier(text: string): boolean {
  return EMAIL.test(text) || URL.test(text) || PHONE.test(text);
}

const ASK_FOR_DATA: Record<ReplyLanguage, string> = {
  kk: "Тексеру үшін оқушының почтасын не сілтемені жібере аласыз ба?",
  ru: "Чтобы проверить — пришлите, пожалуйста, почту ученика или ссылку.",
};

const ACK: Record<ReplyLanguage, string> = {
  kk: "жақсы, қарап береміз",
  ru: "хорошо, посмотрим",
};

// Подтверждение приёма: приветствие + "посмотрим" и, если в обращении не
// было ни почты, ни ссылки, ни номера, — сразу просьба их прислать. Одним
// сообщением, а не двумя: два подряд от бота читаются как спам.
export function buildAckText(incomingText: string, now: Date = new Date()): string {
  const language = pickLanguage(incomingText);
  const base = `${greeting(language, now)}, ${ACK[language]}`;
  return hasIdentifier(incomingText) ? base : `${base}. ${ASK_FOR_DATA[language]}`;
}

// Ответы на смену статуса. RESOLVED тут нет намеренно: слово "Жөңделді" или
// "Өзгертілді" выбирает ИИ по сути тикета (см. pickResolvedWord в ai.ts), а
// само сообщение уходит только после подтверждения человеком — это
// единственный ответ, который утверждает факт, а не обещает внимание.
const STATUS_REPLY: Partial<Record<IssueStatus, Record<ReplyLanguage, string>>> = {
  IN_PROGRESS: {
    kk: "Жұмысқа алдық, қарап жатырмыз",
    ru: "Взяли в работу, смотрим",
  },
  PENDING: {
    kk: "Қарап жатырмыз, сәл күте тұрыңыз",
    ru: "Смотрим, немного подождите",
  },
  ESCALATED: {
    kk: "Әріптестеріме жібердім, шешілгенде сізге кб беремін",
    ru: "Передал коллегам, как решится — дам обратную связь",
  },
  // Тикет вернули в "Отправлено" — это происходит, когда по уже решённому
  // обращению написали снова (см. attachFollowUpToTicket в вебхуке).
  // Человек пишет второй раз именно потому, что ему не ответили, поэтому
  // здесь извинение, а не обычное "принято".
  SENT: {
    kk: "Кешіріңіз, кідіріп қалды — қайта қарап жатырмыз",
    ru: "Извините за задержку — смотрим повторно",
  },
};

export function buildStatusReplyText(
  status: IssueStatus,
  language: ReplyLanguage
): string | null {
  return STATUS_REPLY[status]?.[language] ?? null;
}

export const RESOLVED_WORDS = {
  // "Жөңделді" — починили поломку, "Өзгертілді" — поменяли данные по
  // просьбе (номер, почту, роль). В переписке встречаются оба.
  FIXED: { kk: "Жөңделді ✅", ru: "Исправлено ✅" },
  CHANGED: { kk: "Өзгертілді ✅", ru: "Изменено ✅" },
} as const;

export type ResolvedKind = keyof typeof RESOLVED_WORDS;

export function buildResolvedText(
  kind: ResolvedKind,
  language: ReplyLanguage
): string {
  return RESOLVED_WORDS[kind][language];
}
