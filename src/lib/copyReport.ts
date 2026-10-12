"use client";

// Копирование репорта со ссылками. В буфер кладём два варианта: HTML — тогда
// «#4JQ9PW» при вставке в Telegram остаётся ссылкой на тикет, как в
// отправленном ботом, — и простой текст для мест, где разметку не понимают.
// Нет поддержки (старый браузер) или отказ — копируем просто текст.
export async function copyReport(text: string, html: string | null): Promise<void> {
  if (html && typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    try {
      // В HTML переводы строк схлопываются — без <br> репорт вставился бы
      // одной строкой.
      const rich = `<div>${html.replace(/\n/g, "<br>")}</div>`;
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([rich], { type: "text/html" }),
          "text/plain": new Blob([text], { type: "text/plain" }),
        }),
      ]);
      return;
    } catch {
      // ниже — простой текст
    }
  }
  await navigator.clipboard.writeText(text);
}
