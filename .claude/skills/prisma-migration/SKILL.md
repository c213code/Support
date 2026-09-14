---
name: prisma-migration
description: Use when changing prisma/schema.prisma in the Support project — adding/removing models, fields, relations, indexes or unique constraints. Covers the non-interactive migration workflow (prisma migrate dev does not work here), what may and may not go into a migration, and verification before push.
---

# Миграция Prisma в Support

`npx prisma migrate dev` в этой среде **не работает** — он интерактивный и
падает с ошибкой про non-interactive environment. Миграции делаются через
`migrate diff`.

## Порядок

1. Поправить `prisma/schema.prisma`. Комментарий к модели/полю — почему
   так, как в остальной схеме (по-русски).
2. Посмотреть, какой SQL получится, **до** создания файла:
   ```bash
   npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script
   ```
   Прочитать SQL целиком. Пустой вывод — схема уже совпадает с базой.
3. Записать миграцию (имя — snake_case, что меняется):
   ```bash
   d="prisma/migrations/$(date -u +%Y%m%d%H%M%S)_<name>" && mkdir -p "$d" && \
   npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script 2>/dev/null > "$d/migration.sql" && cat "$d/migration.sql"
   ```
   `2>/dev/null` обязателен: иначе строка «Loaded Prisma config…» попадёт в SQL.
4. Применить к локальной базе и перегенерировать клиент:
   ```bash
   npx prisma migrate deploy && npx prisma generate
   ```
5. `npx tsc --noEmit` — смена связи (например `submission IssueSubmission?` →
   `submissions IssueSubmission[]`) ломает все места, где связь читается;
   tsc их перечислит. Поправить каждое, затем eslint и `npm run build`.

## Что нельзя класть в миграцию

- **Изменения данных** (`UPDATE`, `DELETE`, перенос значений). Сборка на
  Vercel сама выполняет `prisma migrate deploy` — такая миграция молча
  накатится на прод при следующем деплое. Массовые правки данных — только
  отдельным эндпоинтом с кнопкой, которую нажимает человек (пример —
  `POST /api/issues/normalize-status`).
- **Правку уже применённой миграции.** Применённый файл неизменен; нужна
  поправка — новая миграция.

## На что смотреть в SQL

- `DROP INDEX "..._key"` при снятии `@unique` — ок, но проверь, не держался ли
  на уникальности код: `findUnique({ where: { thatField } })` перестанет
  компилироваться, а `upsert` по этому полю — работать.
- `DROP COLUMN` / `DROP TABLE` — данные пропадут безвозвратно. Сначала
  убедиться, что колонка не читается нигде (`grep`), и сказать пользователю.
- Новое `NOT NULL` поле без `DEFAULT` на таблице с данными — миграция упадёт
  на проде. Нужен `@default(...)` или поле `?`.
- Внешние ключи на `Issue` — с каскадами (см. «Связи в базе» в CLAUDE.md):
  удаление тикета не должно оставлять мусор.

## Перед пушем

- В коммит — схема **и** папка миграции (явным списком файлов, не `git add -A`).
- Если менялось поведение — README.
