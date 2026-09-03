// Поля исходного документа Elasticsearch, которых нет в нормализованной
// верхушке LogHit. Сервис логов намеренно прокидывает весь документ в `raw`
// именно для таких случаев — а здесь собраны пути к тому, что мы из него
// достаём, чтобы строковые литералы вида "parsed_json.requestBody" не
// расползались по компонентам и роутам.
//
// Имена подтверждены по _mapping индекса filebeat-*, а не угаданы.
export const RAW_FIELDS = {
  device: "parsed_json.X-Device-Name",
  appVersion: "parsed_json.app-version",
  requestBody: "parsed_json.requestBody",
  responseBody: "parsed_json.responseBody",
} as const;

// Значение по пути "a.b.c" в исходном документе. Возвращает только непустые
// строки: пустая строка и отсутствующее поле для UI и для модели — одно и
// то же ("нечего показывать"), и разводить их отдельно смысла нет.
export function pickRawField(
  source: Record<string, unknown>,
  path: string
): string | null {
  const value = path
    .split(".")
    .reduce<unknown>(
      (acc, key) =>
        acc && typeof acc === "object"
          ? (acc as Record<string, unknown>)[key]
          : undefined,
      source
    );
  return typeof value === "string" && value ? value : null;
}
