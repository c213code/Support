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
// Поэтому один и тот же блок знаний подмешивается в system-промпт каждой
// ИИ-функции (см. src/lib/ai.ts): описания тикетов, поиск дублей, выбор
// "Жөнделді/Өзгертілді".
//
// Про частоту сборки. Знание накапливается из уже решённых тикетов, а не
// из каждого входящего сообщения: пересобирать словарь на каждое
// сообщение — это лишний запрос к модели на каждое обращение (десятки в
// день) ради данных, которые за день почти не меняются. Поэтому сборка
// раз в сутки по cron плюс кнопка "пересобрать" на сайте, а вот
// использование — на каждом вызове.

// Кэш на время жизни серверлесс-инстанса: контекст читают все ИИ-функции,
// а меняется он раз в сутки. TTL короткий, чтобы правка глоссария руками
// не ждала перезапуска инстанса.
const CACHE_TTL_MS = 60 * 1000;
let cache: { text: string; at: number } | null = null;

export async function buildAiContext(): Promise<string> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.text;

  const terms = await prisma.glossaryTerm.findMany({
    orderBy: [{ auto: "asc" }, { term: "asc" }],
    select: { term: true, meaning: true },
  });

  const text =
    terms.length === 0
      ? ""
      : [
          "",
          "Контекст проекта (внутренний жаргон онлайн-школы JUZ40, обращения приходят на казахском и русском):",
          ...terms.map((t) => `- ${t.term} — ${t.meaning}`),
          "Учитывай это при разборе: эти сокращения — суть обращения, а не мусор.",
        ].join("\n");

  cache = { text, at: Date.now() };
  return text;
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

export async function upsertTerm(
  term: string,
  meaning: string,
  auto: boolean
): Promise<void> {
  const trimmed = term.trim();
  if (!trimmed) return;

  const existing = await prisma.glossaryTerm.findUnique({ where: { term: trimmed } });
  // Вписанное человеком автосборка не перезаписывает: если агент уточнил
  // значение, значит модель ошиблась, и повторять её ошибку незачем.
  if (existing && !existing.auto && auto) return;

  await prisma.glossaryTerm.upsert({
    where: { term: trimmed },
    update: { meaning: meaning.trim(), auto: existing?.auto === false ? false : auto },
    create: { term: trimmed, meaning: meaning.trim(), auto },
  });
  invalidateAiContext();
}

export async function deleteTerm(id: string): Promise<void> {
  await prisma.glossaryTerm.delete({ where: { id } }).catch(() => {});
  invalidateAiContext();
}
