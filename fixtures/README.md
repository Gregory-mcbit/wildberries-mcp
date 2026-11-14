# fixtures

- `01-general.paths.yaml` — фрагмент официальной OpenAPI-спеки WB (`01-general`),
  скачан с `https://dev.wildberries.ru/api/swagger/yaml/ru/01-general.yaml`
  и обрезан по секцию `paths` (без `components`), чтобы использовать его как
  реалистичный тест-кейс для `yaml.mjs` без коммита полных спеков (3.4 МБ).

Источник и права: документация Wildberries Seller API. Файл используется только
для тестов парсера. Полные спеки скачиваются `sync.mjs` и в репозиторий не попадают.
