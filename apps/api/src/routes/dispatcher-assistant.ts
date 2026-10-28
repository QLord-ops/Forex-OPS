import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AssistantError, dispatcherMessageSchema, type DispatcherAssistantService } from '../services/dispatcher-assistant.js';

/** Authentication is supplied by the application's global session hook. */
export function registerDispatcherAssistantRoutes(app: FastifyInstance, service: DispatcherAssistantService,
  sessionKey: (request: FastifyRequest) => string = assistantSessionKey) {
  const run = async <T>(work: () => Promise<T>) => {
    try { return await work(); }
    catch (error) {
      if (error instanceof AssistantError || error instanceof z.ZodError) throw error;
      if (error instanceof Error && 'statusCode' in error && error.statusCode === 409) throw error;
      app.log.error({ errorType: error instanceof Error ? error.name : 'unknown' }, 'Assistant operation failed');
      throw new AssistantError('Не удалось выполнить действие. Проверьте данные и повторите запрос.', 400);
    }
  };
  app.get('/assistant/conversations', () => run(() => service.listConversations()));
  app.post('/assistant/conversations', request => run(() => {
    const body = z.object({ title: z.string().trim().max(120).optional() }).strict().parse(request.body ?? {});
    return service.createConversation(body.title);
  }));
  app.get<{ Params: { id: string } }>('/assistant/conversations/:id/messages', request => run(() => service.getMessages(request.params.id)));
  app.post<{ Params: { id: string } }>('/assistant/conversations/:id/messages', { bodyLimit: 150000 }, request => run(() => service.message(request.params.id, dispatcherMessageSchema.parse(request.body), sessionKey(request))));
  app.post<{ Params: { id: string } }>('/assistant/proposals/:id/confirm', request => run(() => service.confirm(request.params.id)));
  app.post<{ Params: { id: string } }>('/assistant/proposals/:id/cancel', request => run(() => service.cancel(request.params.id)));
}

export function assistantSessionKey(request: FastifyRequest): string {
  return request.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith('ops_dispatcher='))?.slice('ops_dispatcher='.length) || request.ip;
}
