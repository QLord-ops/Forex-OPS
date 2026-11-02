import { describe, expect, it } from 'vitest';
import { readErrorMessage } from '../src/lib/api';

const reply = (body: string, status: number) => new Response(body, { status });

describe('error messages shown to the dispatcher', () => {
  it('shows the API message but never a proxy page or raw text', async () => {
    expect(await readErrorMessage(reply(JSON.stringify({ error: 'Точка уже подтверждена.' }), 409))).toBe('Точка уже подтверждена.');
    expect(await readErrorMessage(reply('<html><body>502 Bad Gateway nginx</body></html>', 502))).toBe('Сервер временно недоступен. Повторите через минуту.');
    expect(await readErrorMessage(reply('upstream connect error or disconnect/reset before headers', 503))).toBe('Сервер временно недоступен. Повторите через минуту.');
    expect(await readErrorMessage(reply('', 409))).toBe('Данные изменились. Обновите страницу и повторите.');
    expect(await readErrorMessage(reply(JSON.stringify({ message: 'Проверьте точки и параметры расчёта.' }), 400))).toBe('Проверьте точки и параметры расчёта.');
  });
});
