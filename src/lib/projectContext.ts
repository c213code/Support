import { prisma } from "@/lib/prisma";

// Контекст проекта для всех запросов к модели.
//
// Зачем: обращения в этих чатах написаны внутренним жаргоном JUZ40 — "ДТ
// шықпайды", "ПФ баяу", "АА-ға ауыстыру керек". Модель этих сокращений не
// знает и знать не может: это не общеизвестные термины, а слова, которые
// придумали внутри компании. Без них ИИ чистит описания вслепую — видит
// набор букв там, где на самом деле стоит конкретная проблема, — и точно
// так же вслепую ищет дубли и выбирает слово для ответа.
//
// Поэтому блок знаний подмешивается в system-промпт каждой ИИ-функции (см.
// src/lib/ai.ts): описания тикетов, поиск дублей, заметки "как решили",
// выбор "Жөнделді/Өзгертілді".
//
// Но только те термины, что встречаются в самом тексте запроса. Весь
// словарь — 134 термина, ~4300 токенов — уходил в КАЖДЫЙ запрос, а лимит
// Groq — 8000 токенов в минуту на ключ: проходило 1–2 запроса в минуту, и
// окно "Как решили?" показывало "не удалось получить подсказку" (на
// проверке 24 запроса из 30 упали с 429). Значение "ПФ" модели нужно, только
// когда в тексте есть "ПФ".
//
// Про частоту сборки. Знание накапливается из уже решённых тикетов, а не
// из каждого входящего сообщения: пересобирать словарь на каждое
// сообщение — это лишний запрос к модели на каждое обращение (десятки в
// день) ради данных, которые за день почти не меняются. Поэтому сборка
// раз в сутки по cron плюс кнопка "пересобрать" на сайте, а вот
// использование — на каждом вызове.

// Кэш на время жизни серверлесс-инстанса: словарь читают все ИИ-функции,
// а меняется он раз в сутки. TTL короткий, чтобы правка глоссария руками
// не ждала перезапуска инстанса.
const CACHE_TTL_MS = 60 * 1000;
type ContextTerm = { term: string; meaning: string };
let cache: { terms: ContextTerm[]; at: number } | null = null;

async function loadContextTerms(): Promise<ContextTerm[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.terms;
  const terms = await prisma.glossaryTerm.findMany({
    orderBy: [{ auto: "asc" }, { term: "asc" }],
    select: { term: true, meaning: true },
  });
  cache = { terms, at: Date.now() };
  return terms;
}

function forMatching(text: string): string {
  return text.replace(/[\u2010-\u2015]/g, "-").replace(/\s+/g, " ");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Встречается ли термин в тексте. Граница слова — lookbehind, а не \b: \b
// кириллицу не видит (см. CLAUDE.md).
//
// Длинный термин ищем в начале слова в любом регистре — казахские окончания
// прилипают к нему ("кабинетке", "VIP-PRO-2.0"). С короткими (до трёх букв)
// так нельзя: "СТ" нашёлся бы в "статус" и "студент", "ПС" — в "психолог".
// Поэтому короткий — либо отдельным словом в любом регистре ("дт шықпайды"),
// либо заглавными, как аббревиатура, с окончанием ("ДТ-ны", "ДТны").
export function termMentioned(term: string, text: string): boolean {
  const normalized = forMatching(term).trim();
  if (!normalized) return false;
  const body = escapeRegExp(normalized).replace(/ /g, "\\s+");
  const start = "(?<![\\p{L}\\p{N}])";
  const haystack = forMatching(text);
  const letters = normalized.replace(/[^\p{L}\p{N}]/gu, "");
  if (letters.length <= 3) {
    if (new RegExp(`${start}${body}(?![\\p{L}\\p{N}])`, "iu").test(haystack)) return true;
    const isAbbreviation = normalized === normalized.toUpperCase() && normalized !== normalized.toLowerCase();
    return isAbbreviation && new RegExp(`${start}${body}`, "u").test(haystack);
  }
  return new RegExp(`${start}${body}`, "iu").test(haystack);
}

// relevantText — текст, который получит модель. Без него — весь словарь
// (для вызовов, где текста нет).
export async function buildAiContext(relevantText?: string): Promise<string> {
  const terms = await loadContextTerms();
  const used =
    relevantText === undefined
      ? terms
      : terms.filter((t) => termMentioned(t.term, relevantText));
  if (used.length === 0) return "";
  return [
    "",
    "Контекст проекта (внутренний жаргон онлайн-школы JUZ40, обращения приходят на казахском и русском):",
    ...used.map((t) => `- ${t.term} — ${t.meaning}`),
    "Учитывай это при разборе: эти сокращения — суть обращения, а не мусор.",
  ].join("\n");
}

// Сбрасывает кэш — после пересборки словаря или ручной правки, чтобы
// изменение подействовало сразу, а не через минуту.
export function invalidateAiContext(): void {
  cache = null;
}

export async function listGlossary() {
  return prisma.glossaryTerm.findMany({
    orderBy: [{ auto: "asc" }, { term: "asc" }],
  });
}

// Ключ для сравнения терминов. Уникальность в базе — по самой строке, и
// из-за этого словарь копил один и тот же термин по нескольку раз:
// Backend/BACKEND/Бэкенд, Куиз/КУИЗ, Беклог/БЕКЛОГ, четыре варианта
// «кодпуша». Каждый лишний дубль уходит в КАЖДЫЙ запрос к модели, то есть
// стоит места в лимите токенов на каждом сообщении.
//
// Тире тоже разные: модель пишет то дефис, то неразрывное «‑», и
// VIP-PRO-… превращался в две записи.
function normalizeTerm(term: string): string {
  return term
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

// Что автосборка записывать не должна. Всё это она уже записывала:
// «Кеш упал, добавил временный фоллбэк», «Кодпуш сделан», «Экспорт
// кнопкасы» — это фразы из переписки, а не жаргон, и объяснять их
// модели незачем. Плюс коды курсов вида VIP-PRO-2.0-ГЕОДЖТ-GENIUS-2026:
// они меняются каждый год и не значат ничего, кроме самих себя.
//
// Человека это не касается: вписанное руками сохраняется как есть.
function looksLikePhrase(term: string): boolean {
  const words = term.trim().split(/\s+/);
  return words.length > 3 || term.length > 28 || /\d{4}/.test(term);
}

export async function upsertTerm(
  term: string,
  meaning: string,
  auto: boolean
): Promise<void> {
  const trimmed = term.trim();
  if (!trimmed) return;
  if (auto && looksLikePhrase(trimmed)) return;

  // Ищем не только точное совпадение, но и то же самое в другом регистре
  // или с другим тире — иначе рядом заведётся второй такой же.
  const existing =
    (await prisma.glossaryTerm.findUnique({ where: { term: trimmed } })) ??
    (
      await prisma.glossaryTerm.findMany({
        select: { id: true, term: true, auto: true },
      })
    ).find((row) => normalizeTerm(row.term) === normalizeTerm(trimmed)) ??
    null;
  // Вписанное человеком автосборка не перезаписывает: если агент уточнил
  // значение, значит модель ошиблась, и повторять её ошибку незачем.
  if (existing && !existing.auto && auto) return;

  if (existing) {
    // Пишем в найденную строку, даже если она называется иначе по
    // регистру: две записи об одном и том же — это и есть то, что чинится.
    await prisma.glossaryTerm.update({
      where: { id: existing.id },
      data: {
        meaning: meaning.trim(),
        auto: existing.auto === false ? false : auto,
      },
    });
  } else {
    await prisma.glossaryTerm.create({
      data: { term: trimmed, meaning: meaning.trim(), auto },
    });
  }
  invalidateAiContext();
}

// Правка термина прямо в списке («🧠 Словарь»). По id, а не по названию:
// через upsertTerm переименование завело бы вторую запись рядом со старой.
// Правленое человеком становится «ручным» (auto = false) — ночная
// пересборка его больше не перезапишет: раз поправили, модель ошиблась.
export async function updateTerm(
  id: string,
  term: string,
  meaning: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const trimmedTerm = term.trim();
  const trimmedMeaning = meaning.trim();
  if (!trimmedTerm || !trimmedMeaning) {
    return { ok: false, error: "Термин и значение не должны быть пустыми" };
  }
  const clash = (
    await prisma.glossaryTerm.findMany({ select: { id: true, term: true } })
  ).find((row) => row.id !== id && normalizeTerm(row.term) === normalizeTerm(trimmedTerm));
  if (clash) return { ok: false, error: `«${clash.term}» уже есть в словаре` };

  const updated = await prisma.glossaryTerm
    .update({
      where: { id },
      data: { term: trimmedTerm, meaning: trimmedMeaning, auto: false },
    })
    .catch(() => null);
  if (!updated) return { ok: false, error: "Термин не найден — обновите список" };
  invalidateAiContext();
  return { ok: true };
}

export async function deleteTerm(id: string): Promise<void> {
  await prisma.glossaryTerm.delete({ where: { id } }).catch(() => {});
  invalidateAiContext();
}
