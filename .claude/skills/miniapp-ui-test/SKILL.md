---
name: miniapp-ui-test
description: Use when changing the Telegram Mini App UI in the Support project (src/app/miniapp, MiniApp.tsx, SubmissionForm.tsx, MySubmissions.tsx) or its /api/miniapp routes. Runs the page in headless Chrome at phone width with a stubbed Telegram WebApp object and a correctly signed initData, so the app behaves as if opened inside Telegram.
---

# UI-тест мини-аппа без Telegram

В обычном браузере мини-апп видит «открыто не из Telegram» и ничего не
отправляет. Чтобы проверить его как внутри Telegram, тест:

1. подменяет `window.Telegram.WebApp` до загрузки страницы (запоминает
   параметры MainButton в `window.__mb`, чтобы их можно было проверить);
2. отвечает пустым скриптом на запрос `https://telegram.org/js/telegram-web-app.js`,
   иначе настоящий скрипт перезапишет заглушку;
3. подписывает `initData` тем же токеном, с которым запущен дев-сервер, —
   сервер проверяет подпись по-настоящему (`verifyInitData`);
4. при необходимости подменяет ответы маршрутов, которые ходят в Telegram
   (например `/api/miniapp/photo` → PNG), — с фейковым токеном они дают 502.

## Порядок

1. Дев-сервер с фейковым токеном (форма включается только при
   `TELEGRAM_STORAGE_CHAT_ID`):
   ```bash
   TELEGRAM_BOT_TOKEN="123456:FAKE-TEST-TOKEN" TELEGRAM_STORAGE_CHAT_ID="-1001" \
   PUBLIC_APP_URL="https://example.test" npm run dev   # run_in_background
   ```
2. puppeteer-core — в каталог задачи, не в зависимости проекта. Chrome
   системный, браузер не скачивается:
   ```bash
   cd "$CLAUDE_JOB_DIR/tmp" && [ -d node_modules/puppeteer-core ] || (npm init -y >/dev/null && npm i puppeteer-core@24 --silent)
   ```
3. Данные, если экран их показывает, — скриптом в корне проекта
   (`npx tsx <file>.ts seed|clean`), описания с префиксом `ТЕСТ-`,
   `telegramUserId` тот же, что в подписи (в шаблоне — `900000001`).
4. Скопировать `scripts/miniapp-ui-test.mjs` из этого скилла в
   `$CLAUDE_JOB_DIR/tmp/`, дописать проверки в блок `checks`, запустить
   `node miniapp-ui-test.mjs` **из `$CLAUDE_JOB_DIR/tmp`** (там лежит
   puppeteer-core).
5. Открыть скриншоты (Read на PNG) и посмотреть глазами — проверки не ловят
   кривую вёрстку и тексты вроде «M09 13» вместо даты.
6. Уборка: `clean` тестовых данных (проверить, что удалено), скрипт сида
   удалить, дев-сервер остановить (`lsof -ti :3000 | xargs kill`).

## Что проверять всегда

- Ширина 390px: `document.documentElement.scrollWidth <= 390`.
- MainButton видна только там, где ей место (`window.__mb.is_visible`).
- Светлая и тёмная тема: `page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }])`.
  Скриншот сразу после клика может поймать середину CSS-перехода (120 мс) —
  подождать или не принимать это за баг.
- Даты и числа на казахском: `kk-KZ` в Chrome без названий месяцев.

## Грабли

- `page.mouse.down()` без координат, drag-события в одном синхронном блоке и
  вкладка about:blank по умолчанию — давали ложные падения. Бери
  `(await browser.pages())[0]`.
- Первый заход на страницу в dev — холодная компиляция: `timeout: 120000` у `goto`.
- Селекторы по вложенным `span:nth-child` цепляют лишнее — используй `>`.
