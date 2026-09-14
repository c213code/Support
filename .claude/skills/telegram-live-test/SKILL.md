---
name: telegram-live-test
description: Use before pushing any change in the Support project that touches the Telegram bot — webhook handling, commands, callback buttons, bot replies, DM notifications, menu button. Describes testing against the real Bot API with a temporary .env swap, the fake-token mode for logic-only checks, test data rules and cleanup.
---

# Живой тест Telegram-бота в Support

`tsc` и `npm run build` не ловят ничего из того, что реально ломалось у бота:
лимит `callback_data` в 64 байта, кнопки без id, эхо бота за агентом,
`web_app`-кнопка в группе (Telegram её там не принимает). Поэтому всё, что
касается Telegram, проверяется запросами к дев-серверу, а поведение в самом
Telegram — глазами пользователя.

## Главные правила

- **Секреты не выводить никогда.** Ни токен бота, ни значения из `.env`,
  `.env.local`, `.env.prod` — ни в команде, ни в выводе, ни в ответе. Имена
  переменных можно, значения нельзя. Не `cat .env`, не `echo $TOKEN`;
  проверять наличие так: `printenv TELEGRAM_BOT_TOKEN >/dev/null && echo set`.
- **В рабочие группы при тестах не писать.** Только личка того, кто тестирует.
- **Реальные тикеты в локальной базе не трогать** — на них проверяются
  подсказки и словарь. Тестовые данные — с префиксом `ТЕСТ-`, удалить в конце
  и проверить, что осталось 0.
- Тестовые скрипты — в **корень проекта** (из `/tmp` не резолвятся импорты
  `@/…`), запуск `npx tsx <file>.ts`, удалить после. `import "dotenv/config"`
  первой строкой, остальное — через `await import(...)` внутри `main`.

## Режим 1: фейковый токен (логика без Telegram)

Для маршрутов, где важна логика, а не ответ Telegram. Реальный `.env` не
трогаем — переменные задаются только процессу:

```bash
TELEGRAM_BOT_TOKEN="123456:FAKE-TEST-TOKEN" TELEGRAM_STORAGE_CHAT_ID="-1001" \
PUBLIC_APP_URL="https://example.test" npm run dev   # run_in_background
```

Вызовы Bot API ответят `401 Unauthorized` — в логе будет
`[telegram] <method> 401`. Это ожидаемо и само по себе проверка: видно, что
вызов вообще случился и сколько раз. Подпись мини-аппа (`initData`)
считается от того же фейкового токена (см. скилл `miniapp-ui-test`).

Скрипт теста запускается с теми же переменными, иначе его код (например,
`notifySubmitter`) увидит настоящие значения из `.env`.

## Режим 2: настоящий Bot API

1. Резервная копия — в каталог задачи, не в репозиторий:
   `cp .env "$CLAUDE_JOB_DIR/tmp/env.backup"`.
2. Попросить пользователя вписать в `.env` реальный `TELEGRAM_BOT_TOKEN` и
   тестовые `OWN_AGENT_TELEGRAM_IDS` / `AGENT_TELEGRAM_IDS` (свой id). Самому
   значения не вписывать и не читать.
3. `npm run dev` в фоне, дождаться `Ready`.
4. Бить в вебхук реалистичными апдейтами:
   ```bash
   curl -sS -X POST localhost:3000/api/telegram/webhook \
     -H 'Content-Type: application/json' \
     -d '{"update_id":1,"message":{"message_id":1,"date":'"$(date +%s)"',
          "chat":{"id":<свой id>,"type":"private"},
          "from":{"id":<свой id>,"is_bot":false,"first_name":"ТЕСТ"},
          "text":"/start"}}'
   ```
   Если проверяется секрет вебхука — заголовок
   `X-Telegram-Bot-Api-Secret-Token` со значением из окружения, подставленным
   через переменную, а не текстом.
5. Попросить пользователя посмотреть результат в Telegram: пришло ли, как
   выглядит, работают ли кнопки.
6. **Вернуть `.env` и доказать, что вернулся:**
   ```bash
   cp "$CLAUDE_JOB_DIR/tmp/env.backup" .env && cmp -s .env "$CLAUDE_JOB_DIR/tmp/env.backup" && echo restored
   rm "$CLAUDE_JOB_DIR/tmp/env.backup"
   ```
7. Остановить дев-сервер: `lsof -ti :3000 | xargs kill`.

## Грабли, которые уже встречались

- `callback_data` ≤ 64 байт: два cuid туда не влезают.
- `web_app`-кнопки — только в личных чатах.
- Сообщения бота можно удалить/исправить только 48 часов.
- Бот не видит историю чата: всё прошлое — только из таблицы `TelegramMessage`.
- Кнопку меню Telegram подменяет меню команд — поэтому команды регистрируются
  до кнопки, а кнопка переставляется на каждое сообщение в личке.
- Альбом (`sendMediaGroup`) — минимум 2 элемента, подпись на первом.
