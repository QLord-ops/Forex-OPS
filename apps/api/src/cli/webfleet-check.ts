/**
 * One-off Webfleet connection check: `npm run webfleet:check -w @ops/api`.
 *
 * Makes a single read-only showObjectReportExtern request with the server-side
 * WEBFLEET_* variables and prints what would be matched. It never writes to the
 * database and never prints the account, user, password or API key.
 */
import '../env.js';
import { fetchObjectReport, matchWebfleetObject, readWebfleetConfig, WebfleetError, type WebfleetPosition } from '../services/webfleet.js';

const HINTS: Record<string, string> = {
  AUTH: 'Webfleet отклонил вход: проверьте WEBFLEET_ACCOUNT, WEBFLEET_USERNAME, WEBFLEET_PASSWORD и WEBFLEET_API_KEY. Не повторяйте проверку много раз подряд — пользователь может быть заблокирован.',
  PERMISSION: 'Вход принят, но у пользователя нет права «Access to interface WEBFLEET.connect» или доступа к нужной группе машин.',
  RATE_LIMIT: 'Превышен лимит запросов Webfleet (showObjectReportExtern — до 6 в минуту). Подождите пару минут.',
  NETWORK: 'Webfleet недоступен или сеть блокирует csv.webfleet.com.',
  INVALID_RESPONSE: 'Webfleet вернул неожиданный ответ. Проверьте, что ключ выдан для WEBFLEET.connect.',
  CONFIG: 'WEBFLEET_BASE_URL должен быть https://csv.webfleet.com/extern.',
  UNKNOWN: 'Неизвестная ошибка Webfleet. Код ошибки можно найти в WEBFLEET.connect Reference Guide.'
};

async function main() {
  const config = readWebfleetConfig();
  if (!config) {
    console.error('Webfleet не настроен: нужны WEBFLEET_ACCOUNT, WEBFLEET_API_KEY, WEBFLEET_USERNAME и WEBFLEET_PASSWORD в .env.local или окружении сервера.');
    process.exitCode = 2;
    return;
  }

  let positions: WebfleetPosition[];
  try {
    positions = await fetchObjectReport(config);
  } catch (error) {
    const category = error instanceof WebfleetError ? error.category : 'UNKNOWN';
    const code = error instanceof WebfleetError && error.providerCode !== null ? ` (код Webfleet ${error.providerCode})` : '';
    console.error(`Ошибка: ${category}${code}. ${HINTS[category] ?? ''}`);
    process.exitCode = 1;
    return;
  }

  const now = Date.now();
  console.log(`Подключение работает. Объектов с актуальной позицией: ${positions.length}.`);

  // Matching preview is optional: it only reads vehicles and bindings.
  let match: ((position: WebfleetPosition) => Promise<string>) | null = null;
  let disconnect: (() => Promise<void>) | null = null;
  if (process.env.DATABASE_URL) {
    try {
      const { prisma } = await import('../lib/prisma.js');
      await prisma.$connect();
      disconnect = () => prisma.$disconnect();
      match = async (position) => {
        const result = await matchWebfleetObject(prisma, position);
        return result.vehicleId ? `→ OPS (${result.matchedBy})` : result.ambiguous ? '→ неоднозначно' : '→ нет машины в OPS';
      };
    } catch {
      console.log('База недоступна — показываю объекты без сопоставления.');
    }
  }

  for (const position of positions) {
    const ageMinutes = Math.max(0, Math.round((now - position.recordedAt.getTime()) / 60_000));
    const state = position.standstill === true ? 'стоит' : position.standstill === false ? 'едет' : '—';
    const label = [position.objectNo, position.licensePlate].filter(Boolean).join(' · ') || position.objectUid;
    console.log(`  ${label.padEnd(28)} ${String(ageMinutes).padStart(4)} мин назад  ${state.padEnd(6)} ${match ? await match(position) : ''}`);
  }
  await disconnect?.();
}

await main();
