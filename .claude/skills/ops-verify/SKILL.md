---
name: ops-verify
description: Full verification for OPS Disponent before a commit or PR — lint, typecheck, unit/integration tests, build and optional Playwright. Use after any change in apps/api or apps/web, or when asked "проверь", "прогони тесты", "готово к коммиту?".
---

# Проверка OPS Disponent

Выполняй из корня репозитория, по порядку, останавливаясь на первой ошибке:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

- `npm test` использует изолированные временные SQLite-базы (`apps/api/tests/test-database.ts`) и не трогает рабочие данные.
- `npm run build` в `apps/api` вызывает `scripts/migrate-on-deploy.mjs` — без `DATABASE_URL` он ничего не мигрирует. Никогда не запускай build с production `DATABASE_URL`.
- Изменения интерфейса дополнительно: `npm run test:e2e` (нужен `npx playwright install chromium`).

## Если тест упал

1. Прочитай сам тест и проверяемую функцию; не меняй ожидание теста, пока не понял, кто прав.
2. Поведение, закреплённое тестами безопасности (`security-middleware`, `dispatcher-auth`, `xlsx-validation`, `webfleet`), ослаблять нельзя без явного решения владельца.

## Отчёт

Коротко: сколько тестов прошло, были ли предупреждения сборки (известное: размер бандла MapLibre), что не проверено (например, реальный Webfleet/TomTom/OpenAI без ключей).
