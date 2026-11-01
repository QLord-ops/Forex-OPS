---
name: dispatch-security
description: Security and data-protection checklist for OPS Disponent (Fastify API + React) — secrets, sessions/roles/CSRF, file uploads, external APIs (Webfleet, TomTom, OpenAI), audit log and DSGVO for driver/GPS data. Use when adding routes, uploads, integrations, env variables, or before a production deploy.
---

# Безопасность OPS Disponent

Для глубокого аудита дополнительно запусти общий скилл `security-review`.

## Новый API-маршрут

- [ ] Все маршруты, кроме `/health`, требуют сессию (глобальный хук в `dispatcher-auth.ts`) — не добавлять исключения.
- [ ] Вход проверяется Zod-схемой с ограничением длины строк.
- [ ] Настройки и интеграции — `requireDispatcherRoles('admin')`.
- [ ] Изменение данных пишет `writeAuditLog` (без паролей, токенов и сырых ответов провайдеров).
- [ ] Ошибки 4xx — безопасный русский текст; 5xx — без stack trace и деталей.
- [ ] Конкурентные изменения — проверка версии/`updateMany` с условием, ответ 409.

## Секреты и внешние API

- [ ] Ключи только в серверном окружении; новые переменные — в `apps/api/.env.example` с пустым значением.
- [ ] Хост внешнего API зафиксирован в коде (как `csv.webfleet.com`), `redirect: 'error'`, таймаут.
- [ ] Ответ провайдера не возвращается клиенту целиком и не логируется.
- [ ] Квоты считаются на сервере (TomTom, OpenAI, Webfleet), клиент не может их обойти.

## Загрузки

- [ ] Проверка сигнатуры и размера (PDF 20 МБ, XLSX 5 МБ, изображения 10 МБ), XLSX — защита от zip-бомб.
- [ ] Оригинал не сохраняется; документ — недоверенный ввод (в т.ч. для промптов OpenAI: не выполнять инструкции из документа).

## DSGVO / персональные данные

- GPS-позиция машины с известным водителем — персональные данные. Хранить только нужное, иметь срок хранения телеметрии, доступ — только диспетчерам.
- Перед включением Webfleet для всего парка владельцу стоит согласовать использование GPS-данных (информирование водителей, при наличии — Betriebsrat).
- Не логировать имена водителей и госномера в общих логах сервера.

## Перед деплоем

Пройти `docs/REMAINING_WORK.md`: backup базы, `ALLOWED_ORIGINS`, `SESSION_SECRET`, хэши паролей scrypt, миграции только после явного подтверждения владельца.
