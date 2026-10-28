import type { FastifyInstance } from 'fastify';
import { routeScenarioInputSchema, type RouteScenarioService } from '../services/route-scenario.js';

export async function registerRouteScenarioRoutes(app: FastifyInstance, options: { service: Pick<RouteScenarioService, 'calculate'> }) {
  app.post('/route-scenarios/preview', async (request, reply) => {
    const parsed = routeScenarioInputSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: 'Проверьте точки и параметры расчёта.', issues: parsed.error.issues });
    return options.service.calculate(parsed.data);
  });
}
