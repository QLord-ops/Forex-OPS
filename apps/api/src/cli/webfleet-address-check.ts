/**
 * One-off check of the Webfleet address book: `npm run webfleet:addresses -w @ops/api`.
 *
 * Makes a single read-only showAddressReportExtern request (address columns only) with the server-side WEBFLEET_* variables
 * and prints how many addresses OPS could use. It never writes to the database and never prints credentials or addresses.
 */
import '../env.js';
import { parseWebfleetAddress } from '../services/address-book.js';
import { readWebfleetConfig, webfleetRequest, WebfleetError } from '../services/webfleet.js';

const HINTS: Record<string, string> = {
  AUTH: 'Webfleet отклонил вход: проверьте WEBFLEET_* переменные. Не повторяйте проверку много раз подряд.',
  PERMISSION: 'Вход принят, но у пользователя Webfleet нет права читать адреса (Adressen → Lesen). Его выдаёт администратор Webfleet.',
  RATE_LIMIT: 'Превышен лимит запросов Webfleet (адреса — до 6 в минуту). Подождите пару минут.',
  NETWORK: 'Webfleet недоступен или сеть блокирует csv.webfleet.com.',
  INVALID_RESPONSE: 'Webfleet вернул неожиданный ответ.',
  CONFIG: 'WEBFLEET_BASE_URL должен быть https://csv.webfleet.com/extern.',
  UNKNOWN: 'Неизвестная ошибка Webfleet.'
};

async function main() {
  const config = readWebfleetConfig();
  if (!config) { console.error('Webfleet не настроен: нужны WEBFLEET_* переменные.'); process.exitCode = 2; return; }
  try {
    const rows = await webfleetRequest(config, 'showAddressReportExtern', { columnfilter: 'addruid,addrname1,addrcity,positionx,positiony,radius' });
    const usable = rows.map(parseWebfleetAddress).filter((item) => item !== null);
    const cities = new Set(usable.map((item) => item!.city).filter(Boolean));
    console.log(`Адресов в Webfleet: ${rows.length}; с координатами (пригодны для подсказок): ${usable.length}; городов: ${cities.size}.`);
  } catch (error) {
    const category = error instanceof WebfleetError ? error.category : 'UNKNOWN';
    const code = error instanceof WebfleetError && error.providerCode !== null ? ` (код ${error.providerCode})` : '';
    console.error(`${HINTS[category] ?? HINTS.UNKNOWN}${code}`);
    process.exitCode = 1;
  }
}

void main();
