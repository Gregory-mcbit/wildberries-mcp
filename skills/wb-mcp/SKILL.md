---
name: wb-mcp
description: Подключить и использовать локальный MCP-сервер Wildberries (wb-mcp): установка в клиент, проверка токена, поиск и вызовы методов WB Seller API, безопасная работа с записью.
---

# wb-mcp — Wildberries Seller API для агента

Ты — агент, которому дали ссылку на репозиторий `wb-mcp` (или этот skill).
Твоя задача: поставить локальный MCP-сервер Wildberries и научиться им пользоваться.
Всё работает локально: сервер запускается на машине пользователя, токен WB не покидает машину.

Ссылка на репозиторий: `https://github.com/<owner>/wb-mcp` (подставь реальную из контекста).

## 1. Проверь окружение

```bash
node --version
```

Нужен Node.js >= 20. Если меньше — попроси пользователя обновить Node и остановись.

## 2. Нужен токен WB

Спроси у пользователя токен, если он не передан. Где взять:
кабинет продавца → Настройки → Интеграции по API → Создать токен.
Рекомендуй режим «Только чтение» и только нужные категории.
Никогда не выводи токен в чат и логи.

## 3. Установка (выбери подходящий путь)

**Claude Desktop:** пользователь скачивает `wb-mcp.mcpb` из GitHub Releases и открывает двойным
кликом; токен вводится в окне Claude (сохраняется в защищённом хранилище).

**Claude Code:**
```bash
claude mcp add wb --env WB_API_TOKEN=<TOKEN> -- node <path>/server.mjs
```

**Codex CLI:**
```bash
codex mcp add wb --env WB_API_TOKEN=<TOKEN> -- node <path>/server.mjs
```

**Gemini CLI:**
```bash
gemini mcp add wb --env WB_API_TOKEN=<TOKEN> -- node <path>/server.mjs
```

**Cursor / VS Code / всё остальное (универсально):**
```bash
cd <repo-or-clone>
node install.mjs --client all --token <TOKEN>
# токен сохранится зашифрованно в ~/.wb-mcp/token.enc, в конфигах будет только путь
```

Для запуска без установки:
```bash
WB_API_TOKEN=<TOKEN> WB_AUTO_SYNC=1 npx -y -p github:<owner>/wb-mcp wb-mcp
```
(`WB_AUTO_SYNC=1` сам соберёт каталог методов при первом старте.)

## 4. Проверка

```bash
node ~/.wb-mcp/app/doctor.mjs --json
```
Ожидаемо: каталог (309 методов, 13/13 разделов), сеть до WB, токен валиден, клиент подключён.
Затем в чате: `wb_sections` → `wb_token_info` → `wb_get {"id":"getPing"}` (HTTP 200).

## 5. Как работать

1. `wb_search {"query":"..."}` — найти метод WB по словам (рус/англ).
2. `wb_describe {"id":"..."}` — параметры, тело, лимиты, типы токенов.
3. `wb_get` — **только чтение** (без подтверждений, работает с токеном «Только чтение»).
4. `wb_call` — **изменяющие методы**; всегда предупреждай пользователя о последствиях.
5. `wb_refresh` — обновить каталог после изменений API у WB.
6. Готовые сценарии (prompts): `sales-accelerator`, `diagnose-orders-drop`, `check-stock`,
   `reply-reviews`, `weekly-report` — используй их вместо самодельных планов.

Большие ответы сервер сохраняет в `~/.wb-mcp/out/` — читай файл, не запрашивай повторно.
