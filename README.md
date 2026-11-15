# wb-mcp

**Wildberries Seller API в твоём ИИ-ассистенте.** Локально, без VPS и без облака: клиент сам запускает
сервер, токен и данные магазина остаются у тебя.

[![Node.js](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)](https://nodejs.org/)
[![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](./package.json)
[![Tests](https://img.shields.io/badge/tests-85%20passing-brightgreen)](./test)
[![npm](https://img.shields.io/npm/v/wb-mcp)](https://www.npmjs.com/package/wb-mcp)
[![License](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

## Главное

- 🎯 **Полное покрытие Seller API** — все **13 разделов, 309 методов** из официальных OpenAPI WB.
  Каталог собирается из спек, а `node verify.mjs` подтверждает 13/13 и отсутствие дыр.
- 🪶 **Ноль зависимостей** — только Node.js ≥ 20 и наш код. Аудируется за вечер, ломать в supply-chain нечего.
- 🔐 **Токен под твоим контролем** — шифрование AES-256-GCM на диске, в конфиге клиента только путь к файлу.
  Запросы идут только на `*.wildberries.ru`, тела запросов не пишутся в логи.
- 🧠 **Полноценный MCP** — не только tools: prompts со сценариями, resources (`wb://…`),
  structuredContent, progress-уведомления, подписки на обновление каталога.
- ⚡ **Аккуратно с лимитами WB** — token bucket по лимитам из спек, обработка 429 и 409-штрафа,
  большие ответы сохраняются в файл, а не в контекст модели.
- 📦 **Установка в один шаг** — `.mcpb` двойным кликом, deeplink для Cursor/VS Code, portable ZIP,
  установщик на 6 клиентов, `npx` без установки.
- 🔄 **Каталог всегда свежий** — офлайн-бандл в GitHub Release, `wb_refresh` одной командой,
  `doctor` предупредит, если каталог устарел.
- ✅ **Проверяемость** — 85 офлайн-тестов на моке WB, CI на Windows/Linux, `doctor` и `verify` в комплекте.

## Установка

### 1. Получи токен WB

Кабинет продавца → **Настройки → Интеграции по API → Создать токен**.
Начни с режима **«Только чтение»** и только нужных категорий — WB сам заблокирует запись.

### 2. Поставь сервер в свой клиент

| Клиент | Как установить |
|---|---|
| **Claude Desktop** | скачай `wb-mcp.mcpb` из [Releases](../../releases) → двойной клик → вставь токен в окне Claude |
| **Cursor** | [Установить в Cursor](https://cursor.com/install-mcp?name=wb&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIi1wIiwiZ2l0aHViOkdyZWdvcnktbWNiaXQvd2lsZGJlcnJpZXMtbWNwIiwid2ItbWNwIl0sImVudiI6eyJXQl9BVVRPX1NZTkMiOiIxIiwiV0JfQVBJX1RPS0VOIjoiUEFTVEVfWU9VUl9XQl9BUElfVE9LRU4ifX0%3D) → замени `PASTE_YOUR_WB_API_TOKEN` на свой токен |
| **VS Code** | [Установить в VS Code](vscode:mcp/install?%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22-p%22%2C%22github%3AGregory-mcbit%2Fwildberries-mcp%22%2C%22wb-mcp%22%5D%2C%22env%22%3A%7B%22WB_AUTO_SYNC%22%3A%221%22%2C%22WB_API_TOKEN%22%3A%22PASTE_YOUR_WB_API_TOKEN%22%7D%7D) → замени `PASTE_YOUR_WB_API_TOKEN` |
| **Claude Code** | `claude mcp add wb --env WB_API_TOKEN=<токен> -- node <путь>/server.mjs` |
| **Codex CLI** | `codex mcp add wb --env WB_API_TOKEN=<токен> -- node <путь>/server.mjs` |
| **Gemini CLI** | `gemini mcp add wb --env WB_API_TOKEN=<токен> -- node <путь>/server.mjs` |
| **Все клиенты сразу** | `node install.mjs --client all --token <токен>` |
| **Из npm** | `npx -y -p wb-mcp wb-mcp-install --client all --token <токен>` |
| **Portable ZIP** | `wb-mcp-portable.zip` из Releases → `install.cmd` / `install.sh` |

Установщик сам скачает офлайн-каталог, сохранит токен **зашифрованным** (`~/.wb-mcp/token.enc`)
и пропишет конфиги. В конфигах будет только `WB_TOKEN_FILE`, не сам токен.

Полезные флаги: `--client cursor|claude|claude-code|codex|gemini|vscode|all`,
`--no-release` (собрать каталог из спек вместо релиза), `--bundle <файл>` (офлайн-бандл),
`--plain-token` (токен в конфиге, только если так нужно).

### 3. Перезапусти клиент и проверь

```
«покажи разделы WB API»          → wb_sections
«проверь подключение к WB»       → wb_get {"id":"getPing"}
```

Диагностика одной командой:

```bash
node ~/.wb-mcp/app/doctor.mjs
```

## Что умеет агент

**8 инструментов:** `wb_search` (найти метод), `wb_describe` (схема), `wb_get` (чтение),
`wb_call` (запись), `wb_sections` (обзор), `wb_token_info` (токен), `wb_request` (сырой запрос),
`wb_refresh` (обновить каталог).

**5 сценариев (prompts):** `sales-accelerator` (полный аудит роста продаж), `diagnose-orders-drop`,
`check-stock`, `reply-reviews`, `weekly-report`.

**Resources:** `wb://catalog/index`, `wb://sections/<key>`, `wb://method/<id>`.

## Диагностика и обновление

```bash
node doctor.mjs          # Node, каталог, токен, сеть, конфиги клиентов
node doctor.mjs --json
node verify.mjs          # структура и покрытие каталога
node sync.mjs            # пересобрать каталог из официальных спеков
```

Из чата: `wb_refresh` — то же самое без терминала.

## Безопасность

- Токен шифруется AES-256-GCM; ключ — отдельный файл с правами владельца.
- Разрешены только хосты `*.wildberries.ru`; остальное блокируется до запроса.
- Чтение и запись разделены: `wb_get` безопасен, `wb_call` — для изменений.
- Сервер видит бит «Только чтение» в JWT и заранее блокирует запись; есть и жёсткий режим `WB_READONLY=1`.
- Полный список переменных окружения — в [AGENT-INSTALL.md](./AGENT-INSTALL.md).

## Разработка

```bash
node test/yaml.test.mjs && node test/sync.test.mjs && node test/mcp.test.mjs \
  && node test/publish.test.mjs && node test/package.test.mjs && node test/bundle.test.mjs \
  && node test/doctor.test.mjs && node test/tokenstore.test.mjs && node test/mcpb.test.mjs \
  && node test/deeplinks.test.mjs && node test/npm-package.test.mjs
```

Тесты не ходят в интернет: поднимают мок WB и запускают сервер в процессе.

- [AGENT-INSTALL.md](./AGENT-INSTALL.md) — пошаговая инструкция для агента.
- [README.en.md](./README.en.md) — English version.

## Лицензия

MIT — см. [LICENSE](./LICENSE).
