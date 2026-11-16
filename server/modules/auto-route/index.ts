import { createAutoRouteRouter } from './auto-route.routes.js';
import { createAutoRouteService } from './auto-route.service.js';

type AutoRouteService = ReturnType<typeof createAutoRouteService>;

// Built on first use: the websocket module imports this barrel and the
// providers module (which this one reads Codex limits through) imports the
// websocket module, so nothing may run while that cycle is still loading.
let instance: AutoRouteService | null = null;
const service = (): AutoRouteService => {
  instance ??= createAutoRouteService();
  return instance;
};

// autoRouteService: used by the websocket module's chat dispatcher to tie an
// Auto decision to its session, append the explorer's notes to the turn and
// prefer the decision's Claude account; and by this module's router.
export const autoRouteService: AutoRouteService = {
  decide: (input) => service().decide(input),
  getForSession: (sessionId) => service().getForSession(sessionId),
  prepareTurn: (input) => service().prepareTurn(input),
  recordOutcome: (input) => service().recordOutcome(input),
};

// autoRouteRoutes: mounted by the server entrypoint at /api/auto-route.
export const autoRouteRoutes = createAutoRouteRouter({ service: autoRouteService });
