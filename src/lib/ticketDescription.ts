import { cleanTicketDescription, isNoiseOnly } from "@/lib/textClean";
import { isAiSkip, rewriteTicketDescriptionWithAI } from "@/lib/ai";
import { isAiCleaningEnabled } from "@/lib/settings";

// Готовит описание для тикета — или null, если по этому сообщению тикет
// заводить не нужно (голое приветствие, одна ссылка, "рахмет", рабочая
// переписка коллег). Общая для вебхука (заводит тикет сам, в моменте) и
// POST /api/telegram/ai-recheck-messages (перепроверяет задним числом
// сообщения, которые остались во "Входящих" без тикета — например, ИИ был
// недоступен по квоте, когда сообщение только пришло).
//
// Два текста намеренно разные: `own` — то, что человек буквально напечатал
// (без цитаты), решает, мусор это или нет ("ок" в ответ на чей-то вопрос —
// всё ещё не тикет, независимо от вопроса). `contextual` — то же самое, но
// с приклеенной цитатой (см. extractReplyContextLine в lib/telegram.ts) —
// идёт в regex/ИИ, когда мусором не оказалось.
//
// Тогл "aiCleaningEnabled" (см. lib/settings.ts) решает, кто пишет
// описание: ИИ (Groq, переписывает сообщение, понимая контекст) или
// обычная regex-чистка. Если ИИ выключен, ключ не задан или запрос
// упал/подвис — тихо откатываемся на regex.
//
// repliesToOwnAgent — это сообщение отвечает на реплику одного из НАШИХ
// агентов (не клиента), см. isOwnAgentMessage в вебхуке. Такие цепочки
// статистически чаще внутреннее уточнение коллег, чем пересказ жалобы
// клиента, а regex-чистка вообще не умеет отличить одно от другого — она
// просто вырезает мусорные паттерны, не понимая смысла. Поэтому здесь (и
// только здесь) без работающего ИИ-решения безопаснее не заводить тикет
// вслепую, чем заводить его по любому реплаю на нашего агента.
export async function buildDescription(
  own: string,
  contextual: string,
  repliesToOwnAgent = false
): Promise<string | null> {
  // Дешёвая проверка идёт первой: очевидный мусор отсеиваем регулярками,
  // не тратя на него запрос к ИИ.
  if (isNoiseOnly(own)) return null;

  if (await isAiCleaningEnabled()) {
    const aiResult = await rewriteTicketDescriptionWithAI(contextual, repliesToOwnAgent);
    if (aiResult) return isAiSkip(aiResult) ? null : aiResult;
  }
  if (repliesToOwnAgent) return null;
  return cleanTicketDescription(contextual);
}
