// Опциональная замена cleanTicketDescription (см. lib/textClean.ts) на
// переписывание через Gemini — включается тоглом aiCleaningEnabled
// (см. lib/settings.ts). В отличие от регулярок ИИ понимает контекст, а не
// просто вырезает паттерны, поэтому лучше держит смысл сообщения.
//
// Вызывается из вебхука Telegram, который должен ответить быстро — при
// любой ошибке/таймауте/отсутствии ключа возвращаем null, и вызывающий код
// молча откатывается на cleanTicketDescription, а не роняет обработку
// сообщения.
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";
const GEMINI_TIMEOUT_MS = 8000;

const SYSTEM_PROMPT = `Ты помогаешь службе поддержки онлайн-школы превращать сырые сообщения учеников/родителей из Telegram в короткое описание тикета.

Правила:
- Перепиши сообщение в 1-3 коротких предложения, только суть проблемы.
- Убери приветствия, прощания, слова благодарности.
- Убери ссылки, email, номера телефонов, логины и пароли, подписи с именем/должностью.
- Убери плейсхолдеры вложений вроде [Фото], [Видео], [Файл: ...].
- Сохраняй язык оригинала (казахский/русский/смешанный) и все фактические детали (имя ученика, класс, урок, код ошибки и т.п.) — НИЧЕГО не придумывай и не добавляй от себя.
- Не добавляй никаких пояснений, обращений или markdown — верни только сам текст описания.
- Если после удаления мусора текста не остаётся вообще, верни исходное сообщение без изменений.`;

export async function rewriteTicketDescriptionWithAI(
  raw: string
): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || !raw.trim()) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [
            { role: "user", parts: [{ text: `${SYSTEM_PROMPT}\n\n---\n${raw}` }] },
          ],
          generationConfig: { temperature: 0.2, maxOutputTokens: 300 },
        }),
      }
    );

    if (!res.ok) return null;

    const data = await res.json();
    const text: unknown = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    return typeof text === "string" && text.trim() ? text.trim() : null;
  } catch {
    // Таймаут, сеть, невалидный ответ — не наша забота здесь, вызывающий
    // код откатится на regex-чистку.
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
