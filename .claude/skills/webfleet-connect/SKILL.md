---
name: webfleet-connect
description: Working with the Webfleet (WEBFLEET.connect) telematics integration in OPS Disponent — adding the API key, diagnosing sync errors, matching Webfleet objects to OPS trucks, and adding new read-only reports (trips, standstills, odometer, fuel, tachograph). Use for anything mentioning Webfleet, GPS, телеметрия, objectno, привязка машин.
---

# Webfleet в OPS Disponent

Код: `apps/api/src/services/webfleet.ts`, маршруты `/integrations/webfleet/*` в `apps/api/src/app.ts`, UI — `apps/web/src/components/WebfleetConnectionPanel.tsx`, тесты — `apps/api/tests/webfleet.test.ts`. Документация для владельца — `docs/webfleet-integration.md`.

## Как устроено сейчас

- Один общий снимок `showObjectReportExtern` не чаще раза в 60 с (лимит Webfleet — 6/мин). Лиза-блокировка в `IntegrationSyncState` не даёт двум инстансам API ходить параллельно.
- Запрос: `https://csv.webfleet.com/extern?account=…&apikey=…&action=…&outputformat=json&useUTF8=true&useISO8601=true`, логин/пароль — только HTTP Basic. Хост жёстко проверяется (защита от SSRF/утечки ключа).
- Ошибки → `WebfleetError(category, providerCode)`. Категории: `AUTH`, `PERMISSION`, `RATE_LIMIT`, `NETWORK`, `INVALID_RESPONSE`, `CONFIG`, `UNKNOWN`. В JSON-режиме Webfleet возвращает ошибку объектом `{ errorCode, errorMsg }` с HTTP 200, иногда — заголовками `X-Webfleet-Errorcode`/`X-Webfleet-Errormessage`. Текст ошибки используется только для классификации и не сохраняется.
- Паузы после ошибки: AUTH/PERMISSION/CONFIG — 30 мин (чтобы Webfleet не заблокировал пользователя за неудачные входы), остальное — 5 мин.
- Сопоставление: сначала сохранённая привязка (`VehicleIntegration`), затем точный `objectno` = `vehicleNumber` или нормализованный госномер. Неоднозначность → не привязывать. Ручная привязка: `POST /integrations/webfleet/bindings` (admin, аудит), отвязка — `DELETE /integrations/webfleet/bindings/:vehicleId` (телеметрия остаётся как история).
- Свежесть: ≤ 2 мин — свежая, ≤ 30 мин — устаревшая, но пригодная для расчёта, старше — не используется.
- Автоприбытие (`detectArrival` в `webfleet.ts`): свежая позиция в зоне точки (`Stop.arrivalRadiusMeters ?? 500`), `standstill` ≥ 3 мин по истории `VehicleTelemetry`; время = въезд в зону, не раньше старта участка. Ставится через `OperationsService.confirmArrival(..., SYSTEM_WEBFLEET_ACTOR, { source: 'WEBFLEET_AUTO' })`, уведомление `AUTO_ARRIVAL`, отмена `POST /stops/:id/arrival/revert` (событие `ARRIVAL_REVERTED`). После отмены — только после выезда из зоны. `AUTO_ARRIVAL_ENABLED=false` возвращает подсказку.
- Авто-BELADEN/ENTLADEN (`detectDeparture` в `webfleet.ts`): стоянка в зоне ≥ 20 мин по истории, затем 10 км от точки (две записи или скорость), следующая точка не в том же городе. Ставится через `TourService.recordAutoStopEvent(..., SYSTEM_WEBFLEET_ACTOR)` на время выезда из зоны, событие `STOP_EVENT_AUTO` со снимком «как было», уведомление `AUTO_STOP_EVENT`. Отмена — `POST /stops/:id/auto-event/revert` (`TourService.revertAutoStopEvent`, событие `…_REVERTED`), пока машина не прибыла на следующую точку. `AUTO_STOP_EVENT_ENABLED=false` оставляет только вопрос `STOP_DEPARTED`.

## Подключение ключа (порядок)

1. Владелец получает у Webfleet: account, API key, технического пользователя с правом «Access to interface WEBFLEET.connect», только чтение, тестовая группа из 2–3 машин.
2. Значения — в `.env.local` (локально) или в секретах хостинга API: `WEBFLEET_ACCOUNT`, `WEBFLEET_API_KEY`, `WEBFLEET_USERNAME`, `WEBFLEET_PASSWORD`. Никогда в чат, git или `VITE_*`.
3. `npm run webfleet:check -w @ops/api` — одна проверка, печатает объекты и предварительное сопоставление, ничего не пишет в базу.
4. Перезапуск API → страница «Грузовики» → блок Webfleet → «Проверить подключение», привязать несопоставленные объекты.

## Добавление нового отчёта Webfleet

- Только read-only действия (`show…Extern`, `show…Report…`). Никаких `insert/update/send…`, `sendOrderExtern`, `sendTextMessageExtern` без отдельного решения владельца.
- Перед кодом сверить имя action, поля и лимит запросов в актуальном WEBFLEET.connect Reference Guide; единицы измерения (скорость, пробег в 100 м, топливо) не угадывать — тест с реальным образцом ответа.
- Новый парсер — чистая функция `parse…Row(unknown)` + unit-тест на образце; общий `fetch…` через ту же проверку хоста и `WebfleetError`.
- Учитывать квоты: общий снимок на весь парк, кэш в БД, лиза в `IntegrationSyncState`.
- Данные водителя (имя, рабочие часы тахографа) — персональные данные по DSGVO: показывать отдельным справочным блоком, не смешивать с расчётными часами машины и не хранить дольше необходимого.
