# OPS Disponent — инструкции для Claude Code

Диспетчерская система грузового автопарка Forex GmbH (Bovenden). Пользователь — диспетчер: управляет машинами, турами, Auftrag, BELADEN/ENTLADEN, ETA и пробками. Интерфейс и тексты для пользователя — **на русском**; немецкие отраслевые термины (Auftrag, Tourbemerkung, BELADEN, ENTLADEN, LDM, Termin) остаются как есть.

## Стек

- `apps/api` — Fastify 5, Prisma 6, Zod, TypeScript (ESM, NodeNext). Production: PostgreSQL (DigitalOcean `ops-disponent-prod`), локально и в тестах — SQLite (`prisma/sqlite/`).
- `apps/web` — React 18, Vite, Tailwind, MapLibre (ленивая загрузка), lucide-react.
- Тесты: Vitest (`apps/*/tests`), Playwright (`e2e/`). Node 22 (`.nvmrc`).

## Команды

```bash
npm install
npm run db:setup          # локальная SQLite + seed
npm run dev               # API :3001, web :5173
npm run lint && npm run typecheck && npm test && npm run build
npm run test:e2e
npm run webfleet:check -w @ops/api   # одна read-only проверка ключа Webfleet
```

Перед каждым коммитом — все четыре проверки зелёные. Новая логика сопровождается тестом в `apps/api/tests`.

## Где что лежит

- `apps/api/src/app.ts` — все маршруты; сервисы — `apps/api/src/services/*`.
- `services/webfleet.ts` — Webfleet: синхронизация, сопоставление машин, ошибки, привязки.
- `services/vehicle-clock.ts` — расчёт часов машины (ЕС 561/2006), `tours.ts` — туры, `operations.ts` — прибытие/стоянки.
- `services/*-order-import.ts` — импорт Auftrag (PDF/XLSX/изображения), `xlsx-validation.ts` — защита загрузок.
- `services/dispatcher-auth.ts` — сессии, роли `admin`/`dispatcher`, CSRF; `audit-log.ts` — журнал действий.
- Документация: `docs/REMAINING_WORK.md` (что осталось), `docs/webfleet-integration.md`, `docs/DEPLOYMENT.md`, `DESIGN.md`.

## Жёсткие правила

1. **Секреты** — только в серверном окружении. Никогда в `VITE_*`, git, логах, ответах API или чате. Ошибки внешних API не пересказывают их сырой текст пользователю.
2. **Webfleet — только чтение.** Не отправлять в Webfleet заказы, сообщения, команды. Лимит `showObjectReportExtern` — 6/мин, приложение делает 1/мин. При ошибке входа — пауза 30 мин (защита от блокировки пользователя).
3. **Автоматика только по реальному GPS.** Прибытие может ставиться само только по свежему GPS Webfleet: машина в зоне точки (по умолчанию 500 м, `Stop.arrivalRadiusMeters`) и стоит ≥ 3 мин; время = въезд в зону, уведомление `AUTO_ARRIVAL` с отменой, аудит с ролью `system`. Расчётная позиция никогда не ставит фактические события. BELADEN/ENTLADEN ставит диспетчер; сам он записывается, только если по свежему GPS машина простояла в зоне точки ≥ 20 мин и отъехала от неё на 10 км (вышла из города), а следующая точка не в том же городе: время = выезд из зоны, уведомление `AUTO_STOP_EVENT` с «Отменить», аудит с ролью `system`. После короткой стоянки — только вопрос `STOP_DEPARTED`.
4. **Источник позиции всегда виден**: свежий Webfleet / устаревший Webfleet / расчёт. Устаревшие данные не выдаются за актуальные.
5. **Production-база**: никаких ручных миграций, импортов и изменений данных без backup и явного «да» владельца. `db:reset` — только локально.
   Деплой автоматический: слияние в `main` = выкладка (API на DigitalOcean с PRE_DEPLOY-миграцией, web на Vercel). Новые миграции схемы — отдельным PR с явной пометкой в описании.
6. **История неизменяема**: завершённые точки и события не удаляются; редактируется только будущий тур с проверкой версии.
7. Мутирующие маршруты: Zod-валидация, проверка роли (`requireDispatcherRoles('admin')` для настроек), запись в `writeAuditLog`.
8. Персональные данные водителей (DSGVO): не хранить больше, чем нужно; телеметрия привязана к машине, а не к водителю.

## Стиль

- Коммиты: Conventional Commits (`feat(webfleet): …`, `fix(import): …`), работа в ветке, не прямо в `main`.
- UI по `DESIGN.md`: плотный операционный интерфейс, текст рядом с цветом, WCAG 2.1 AA, клавиатура.
- Код без лишних комментариев; комментарий — только «почему».

## Скиллы

Проектные скиллы в `.claude/skills/`: `ops-verify`, `webfleet-connect`, `eu-driving-time`, `dispatch-security`, `unslop` (полировка интерфейса, чтобы не выглядел «сгенерированным»; автор Damir Sokolovsky, CC BY 4.0 — при копировании сохранять указание автора).
Полезные общие: `security-review`, `code-review`, `impeccable` / `ui-ux-pro-max` (интерфейс), `dataviz` (KPI и графики).
