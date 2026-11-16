import { stat } from 'node:fs/promises';

import express from 'express';

import type { AutoRouteEngine, AutoRoutePick } from '@/shared/types.js';
import { asyncHandler, createApiSuccessResponse, validateWorkspacePath } from '@/shared/utils.js';

type AutoRouteRouterDependencies = {
  service: {
    decide(input: {
      prompt: string;
      projectPath: string;
      forcedEngine?: AutoRouteEngine | null;
      escalateFrom?: AutoRoutePick | null;
    }): Promise<unknown>;
    getForSession(sessionId: string): Promise<unknown>;
  };
};

const MAX_PROMPT_CHARS = 100_000;

/**
 * Transport for the Auto model choice. Exported for the module's barrel and
 * route tests; the server entrypoint mounts it at /api/auto-route.
 */
export function createAutoRouteRouter(dependencies: AutoRouteRouterDependencies): express.Router {
  const router = express.Router();

  // Explores the request and decides where it runs. Takes up to ~30 s.
  router.post('/decisions', asyncHandler(async (request, response) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const prompt = typeof body.prompt === 'string' ? body.prompt : '';
    const projectPath = typeof body.projectPath === 'string' ? body.projectPath : '';
    // A re-evaluation names the session: the pick stays on its engine and goes
    // two rungs above what the session ran on, read from the server's record.
    const reevaluateSessionId = typeof body.reevaluateSessionId === 'string' ? body.reevaluateSessionId.trim() : '';
    const reevaluated = reevaluateSessionId
      ? await dependencies.service.getForSession(reevaluateSessionId) as { decision?: { pick?: AutoRoutePick | null } } | null
      : null;
    const engineFromBody = body.forcedEngine === 'claude' || body.forcedEngine === 'codex' ? body.forcedEngine : null;
    const escalateFrom = reevaluated?.decision?.pick ?? null;
    const forcedEngine = escalateFrom?.engine ?? engineFromBody;
    if (!prompt.trim()) {
      response.status(400).json({ success: false, error: 'prompt is required' });
      return;
    }
    if (prompt.length > MAX_PROMPT_CHARS) {
      response.status(413).json({ success: false, error: 'prompt is too long for Auto' });
      return;
    }
    const validation = await validateWorkspacePath(projectPath);
    const resolvedPath = validation.valid ? validation.resolvedPath : undefined;
    const isDirectory = resolvedPath ? await stat(resolvedPath).then((s) => s.isDirectory(), () => false) : false;
    if (!resolvedPath || !isDirectory) {
      response.status(400).json({ success: false, error: validation.error || 'projectPath is not a folder' });
      return;
    }
    const decision = await dependencies.service.decide({ prompt, projectPath: resolvedPath, forcedEngine, escalateFrom });
    response.json(createApiSuccessResponse({ decision }));
  }));

  // The decision a session runs on, or null.
  router.get('/sessions/:sessionId', asyncHandler(async (request, response) => {
    const sessionId = String(request.params.sessionId ?? '').trim();
    const record = sessionId ? await dependencies.service.getForSession(sessionId) : null;
    response.json(createApiSuccessResponse({ record: record ?? null }));
  }));

  return router;
}
