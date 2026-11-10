import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuditActor } from '../services/audit-log.js';
import { DailyStatusError, type DailyStatusService } from '../services/daily-status.js';
import { buildStatusWorkbook } from '../services/daily-status-export.js';
import { requireDispatcherRoles } from '../services/dispatcher-auth.js';
import { berlinToday } from '../services/order-dates.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата в формате ГГГГ-ММ-ДД.');
// Free text the dispatcher types: control characters out, length bounded.
const text = (max: number) => z.string().max(max).transform((value) => value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim()).nullable();
const editSchema = z.object({
  version: z.number().int().nonnegative(),
  bemerkung: text(500).optional(),
  weNortheim: text(100).optional(),
  overrides: z.object({ ort: text(100).optional(), start: text(100).optional(), ziel: text(100).optional(), ankunft: text(100).optional(), trailer: text(100).optional() }).strict().optional()
}).strict();
const listKey = z.string().trim().min(1).max(64);
const generateSchema = z.object({ date: date.optional(), resetEdits: z.boolean().default(false), list: listKey.optional() }).strict();
/** Whose trucks the Excel holds: "mine", a dispatcher's id, "none" (nobody's), or the whole list when left out. */
const ownerKey = z.string().trim().min(1).max(64);
const BERLIN_DAY_MONTH = (day: string) => `${day.slice(8, 10)}.${day.slice(5, 7)}`;

function actorOf(request: FastifyRequest): AuditActor {
  const session = request.dispatcherSession;
  if (!session) throw Object.assign(new Error('Войдите в диспетчерскую.'), { statusCode: 401 });
  return { role: session.role, sessionId: session.sessionId, dispatcherId: session.dispatcherId };
}
/** The whole list and other people's trucks are for an admin, or for the shared login from before personal accounts. */
function seesEveryone(request: FastifyRequest): boolean {
  const session = request.dispatcherSession;
  return Boolean(session && (session.role === 'admin' || !session.dispatcherId));
}
function forbidden(message: string): never {
  throw Object.assign(new Error(message), { statusCode: 403 });
}
function statusError(error: unknown): never {
  if (error instanceof DailyStatusError) throw Object.assign(new Error(error.message), { statusCode: error.statusCode });
  throw error;
}

/** The daily status lists of the customers: read, regenerate today's, edit Bemerkung / WE, download as Excel. */
export function registerDailyStatusRoutes(app: FastifyInstance, service: DailyStatusService) {
  app.get('/daily-status', async (request) => {
    const query = z.object({ date: date.optional(), list: listKey.optional() }).parse(request.query);
    const now = new Date();
    const day = query.date ?? berlinToday(now);
    // A list missed at 07:00 (server down, Webfleet empty) is caught up by the first look at today's page.
    if (day === berlinToday(now)) await service.runIfDue(now).catch(() => undefined);
    const list = await service.get(day, now, query.list).catch(statusError);
    const session = request.dispatcherSession;
    return { ...list, viewer: { dispatcherId: session?.dispatcherId ?? null, role: session?.role ?? 'dispatcher' } };
  });

  app.post('/daily-status/generate', { preHandler: requireDispatcherRoles('admin', 'dispatcher'), config: { rateLimit: { max: 3, timeWindow: '1 minute' } } }, async (request) => {
    const input = generateSchema.parse(request.body ?? {});
    const now = new Date();
    return service.generate(input.date ?? berlinToday(now), now, actorOf(request), { resetEdits: input.resetEdits, list: input.list }).catch(statusError);
  });

  app.patch('/daily-status/rows/:id', { preHandler: requireDispatcherRoles('admin', 'dispatcher') }, async (request) => {
    const { id } = z.object({ id: z.string().trim().min(1).max(64) }).parse(request.params);
    const input = editSchema.parse(request.body);
    return service.editRow(id, input, actorOf(request), new Date()).catch(statusError);
  });

  app.get('/daily-status/:date/export.xlsx', async (request, reply) => {
    const params = z.object({ date }).parse(request.params);
    const query = z.object({ list: listKey.optional(), owner: ownerKey.optional() }).parse(request.query);
    const me = request.dispatcherSession?.dispatcherId ?? null;
    const everyone = seesEveryone(request);
    if (query.owner === 'mine' && !me) throw Object.assign(new Error('Войдите под своей учётной записью, чтобы скачать свои машины.'), { statusCode: 400 });
    const target = query.owner === 'mine' ? me : query.owner ?? null;
    if (!everyone && target !== me) forbidden(target ? 'Можно скачать только Excel со своими машинами.' : 'Весь список скачивает администратор. Скачайте свой Excel в «Мои машины».');
    const list = await service.get(params.date, new Date(), query.list).catch(statusError);
    if (!list.report) throw Object.assign(new Error('Список за этот день не сформирован.'), { statusCode: 404 });
    const rows = target === null ? list.rows : list.rows.filter((row) => target === 'none' ? !row.owner : row.owner?.id === target);
    if (!rows.length) {
      const whose = target === me ? 'У вас нет машин' : target === 'none' ? 'Ничьих машин нет' : 'У этого диспетчера нет машин';
      throw Object.assign(new Error(`${whose} в статусе ${list.list.name} за ${BERLIN_DAY_MONTH(params.date)}.`), { statusCode: 404 });
    }
    const buffer = await buildStatusWorkbook({ date: params.date, generatedAt: list.report.generatedAt, rows, groups: list.list.groups, columns: list.list.columns, skipEmptyGroups: target !== null });
    const name = `Status ${list.list.key === 'SCHNELLECKE' ? '' : `${list.list.name} `}${params.date}.xlsx`;
    return reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`)
      .header('Cache-Control', 'no-store')
      .send(buffer);
  });
}
