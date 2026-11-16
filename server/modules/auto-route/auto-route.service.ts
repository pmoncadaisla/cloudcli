/**
 * Fork (Hemilake): the Auto model choice, end to end.
 *
 *   1. explore   a cheap read-only pass turns the request into a brief
 *                (auto-route.explorer.ts), on Claude Haiku, or on Codex Luna
 *                when every Claude account is used up
 *   2. decide    Gemini Decisions reads the brief (not the raw request); the
 *                policy takes the model's capability and the effort apart,
 *                the middle pair when unsure, two rungs up on a re-evaluation, and the
 *                live quotas pick the engine (auto-route.policy.ts)
 *   3. apply     the composer starts the session on the pick; the chat
 *                dispatcher calls prepareTurn, which ties the decision to the
 *                session, hands back the brief to append to Pablo's prompt and
 *                the Claude account to prefer on every turn of the session
 *
 * A failed or slow explorer leaves the decision to the raw request; a failed
 * Gemini Decisions call means the middle pair (Sonnet or Terra at high), the
 * same answer as an unsure one, with `fallback` saying why. Every step is
 * logged (auto-route.store.ts).
 */

import { createHash, randomUUID } from 'node:crypto';

import type {
  AutoRouteDecision,
  AutoRouteEffort,
  AutoRouteEngine,
  AutoRoutePick,
  AutoRouteQuota,
} from '@/shared/types.js';

import { askDecisions, describeForDecision } from './auto-route.decisions.js';
import { explore } from './auto-route.explorer.js';
import {
  AUTO_ROUTE_EFFORTS,
  AUTO_ROUTE_THRESHOLDS,
  bestAccount,
  capabilityOf,
  capabilityOfModel,
  claudeExhausted,
  effortOf,
  engineFor,
  escalate,
  planFor,
  readCodexCapabilities,
  readProbabilities,
} from './auto-route.policy.js';
import { createQuotaReader } from './auto-route.quota.js';
import { createAutoRouteStore } from './auto-route.store.js';

type AutoRouteServiceOptions = {
  env?: NodeJS.ProcessEnv;
  store?: ReturnType<typeof createAutoRouteStore>;
  quota?: ReturnType<typeof createQuotaReader>;
  explore?: typeof explore;
  askDecisions?: typeof askDecisions;
  now?: () => number;
};

/** What the chat dispatcher needs from Auto for one turn. */
type PreparedTurn = {
  /** The explorer's brief, to append to this turn's prompt (first turn of a decision only). */
  notes: string | null;
  notesSource: { engine: string; model: string } | null;
  /** Claude subscription account to prefer (claude-oauth-proxy `x-claude-account`), every turn. */
  account: string | null;
  /** The decision applied by this turn, for recordOutcome. */
  appliedDecisionId: string | null;
};

const NO_TURN: PreparedTurn = { notes: null, notesSource: null, account: null, appliedDecisionId: null };

const positive = (value: string | undefined, fallback: number): number => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
};

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 200);

/**
 * Builds the Auto service. Exported for the module's barrel (one instance for
 * the server) and its tests (fakes for the explorer, Decisions and quotas).
 */
export function createAutoRouteService(options: AutoRouteServiceOptions = {}) {
  const env = options.env ?? process.env;
  const store = options.store ?? createAutoRouteStore();
  const quota = options.quota ?? createQuotaReader({
    proxyUrl: (env.CLOUDCLI_AUTO_ROUTE_PROXY_URL || 'http://127.0.0.1:4321').replace(/\/$/, ''),
    exporterUrl: env.CLOUDCLI_AUTO_ROUTE_EXPORTER_URL || 'http://127.0.0.1:9115/metrics',
  });
  const runExplore = options.explore ?? explore;
  const ask = options.askDecisions ?? askDecisions;
  const now = options.now ?? Date.now;

  const gatewayBase = (env.ANTHROPIC_BASE_URL || 'http://127.0.0.1:4000').replace(/\/$/, '');
  const decisionsUrl = env.CLOUDCLI_AUTO_ROUTE_DECISIONS_URL || `${gatewayBase}/gemini/v1beta/decisions`;
  const decisionsKey = env.CLOUDCLI_AUTO_ROUTE_KEY || env.ANTHROPIC_AUTH_TOKEN || '';
  const exploreTimeoutMs = positive(env.CLOUDCLI_AUTO_ROUTE_EXPLORE_TIMEOUT_MS, 25_000);
  const exploreTokenCap = positive(env.CLOUDCLI_AUTO_ROUTE_EXPLORE_TOKEN_CAP, 200_000);
  const decisionTimeoutMs = positive(env.CLOUDCLI_AUTO_ROUTE_DECISION_TIMEOUT_MS, 5_000);
  const codexCapabilities = readCodexCapabilities(env.CLOUDCLI_AUTO_CODEX_CAPABILITIES);
  const codexBinary = env.CLOUDCLI_AUTO_ROUTE_CODEX_BIN || 'codex';

  return {
    /**
     * Explores the request and decides where it runs. Never throws for a
     * failure of its own steps: they end up in `fallback`.
     */
    async decide(input: {
      prompt: string;
      projectPath: string;
      forcedEngine?: AutoRouteEngine | null;
      /** On a re-evaluation, what the session ran on: the new pick goes at least two rungs above it. */
      escalateFrom?: AutoRoutePick | null;
    }): Promise<AutoRouteDecision> {
      const startedAt = now();
      const forcedEngine = input.forcedEngine ?? null;
      const escalatedFrom = input.escalateFrom ?? null;
      // Codex's app-server takes a second or two: read it while the explorer works.
      const codexQuota = quota.readCodex();
      const claudeQuota = await quota.readClaude();
      const early: AutoRouteQuota = { at: new Date(startedAt).toISOString(), claude: claudeQuota, codex: { error: 'not read yet' } };
      const explorerEngine: AutoRouteEngine = claudeExhausted(early) ? 'codex' : 'claude';

      const brief = await runExplore({
        prompt: input.prompt,
        cwd: input.projectPath,
        engine: explorerEngine,
        timeoutMs: exploreTimeoutMs,
        tokenCap: exploreTokenCap,
        lakeTimeoutMs: Math.min(8_000, exploreTimeoutMs / 3),
        codexBinary,
      });
      const quotaRead: AutoRouteQuota = { ...early, codex: await codexQuota };

      let decisionError: string | null = null;
      let probabilities: AutoRouteDecision['probabilities'] = null;
      let signals: AutoRouteDecision['signals'] = null;
      let capability: AutoRouteDecision['capability'] = null;
      let effort: AutoRouteDecision['effort'] = null;
      let why: AutoRouteDecision['why'] = null;
      const decisionStartedAt = now();
      try {
        const answers = await ask(describeForDecision(input.prompt, brief, input.projectPath), {
          url: decisionsUrl,
          key: decisionsKey,
          timeoutMs: decisionTimeoutMs,
        });
        const read = readProbabilities(answers);
        probabilities = { capability: read.capability, depth: read.depth };
        signals = { routine: read.routine, design: read.design, stakes: read.stakes };
        const decidedCapability = capabilityOf(read);
        const decidedEffort = effortOf(read, decidedCapability);
        capability = decidedCapability.capability;
        effort = decidedEffort.effort;
        why = { capability: decidedCapability.why, effort: decidedEffort.why, escalation: null };
      } catch (error) {
        // Without an answer the router is as unsure as it gets: the middle pair.
        decisionError = errorText(error);
        capability = AUTO_ROUTE_THRESHOLDS.defaultCapability;
        effort = AUTO_ROUTE_THRESHOLDS.unsureEffort;
        why = { capability: 'no answer from Gemini Decisions: the middle pair', effort: 'the middle pair\'s effort', escalation: null };
      }
      const previousCapability = escalatedFrom ? capabilityOfModel(escalatedFrom.engine, escalatedFrom.model) : null;
      if (previousCapability && escalatedFrom) {
        const previousEffort = (AUTO_ROUTE_EFFORTS as readonly string[]).includes(escalatedFrom.effort)
          ? escalatedFrom.effort as AutoRouteEffort
          : 'medium';
        const stepped = escalate(capability, effort, { capability: previousCapability, effort: previousEffort });
        capability = stepped.capability;
        effort = stepped.effort;
        why.escalation = stepped.why;
      }
      const decisionLatencyMs = now() - decisionStartedAt;

      let placement: string | null = null;
      let pick: AutoRouteDecision['pick'] = null;
      if (capability && effort) {
        const placed = engineFor(capability, forcedEngine, quotaRead, codexCapabilities);
        placement = placed.why;
        pick = planFor({
          capability,
          effort,
          engine: placed.engine,
          account: placed.engine === 'claude' ? bestAccount(quotaRead) : null,
          env,
        });
      }

      const decision: AutoRouteDecision = {
        id: randomUUID(),
        createdAt: new Date(startedAt).toISOString(),
        projectPath: input.projectPath,
        promptHash: createHash('sha256').update(input.prompt).digest('hex').slice(0, 16),
        promptChars: input.prompt.length,
        forcedEngine,
        escalatedFrom,
        brief,
        capability,
        effort,
        probabilities,
        signals,
        why,
        decisionLatencyMs,
        decisionError,
        quota: quotaRead,
        placement,
        pick,
        fallback: decisionError ? `Gemini Decisions failed (${decisionError}): the middle pair runs` : null,
        totalMs: now() - startedAt,
        sessionId: null,
      };

      try {
        await store.saveDecision(decision);
      } catch (error) {
        console.warn('[auto-route] could not save the decision:', error);
      }
      await store.log('decided', {
        id: decision.id,
        promptHash: decision.promptHash,
        promptChars: decision.promptChars,
        projectPath: decision.projectPath,
        forcedEngine,
        escalatedFrom,
        brief: brief.text,
        briefKind: brief.kind,
        briefFiles: brief.files.length,
        briefError: brief.error,
        explorer: { engine: brief.engine, model: brief.model, latencyMs: brief.latencyMs, toolCalls: brief.toolCalls, lake: brief.lakeUsed },
        capability,
        effort,
        probabilities,
        signals,
        why,
        decisionLatencyMs,
        decisionError,
        quota: quotaRead,
        placement,
        pick,
        totalMs: decision.totalMs,
      });
      return decision;
    },

    /** The decision a session runs on, with what happened since; null for a session Auto never touched. */
    async getForSession(sessionId: string) {
      return store.getSession(sessionId);
    },

    /**
     * Called by the chat dispatcher before every turn. With `decisionId` (the
     * composer sends it on the turn the decision was taken for) it ties the
     * decision to the session and returns the brief to append; on later turns
     * it only returns the Claude account to keep preferring, and notes a
     * manual switch of model. Never throws.
     */
    async prepareTurn(input: {
      sessionId: string;
      provider: string;
      decisionId?: unknown;
      model?: unknown;
    }): Promise<PreparedTurn> {
      try {
        const model = typeof input.model === 'string' ? input.model.trim() : '';
        const decisionId = typeof input.decisionId === 'string' ? input.decisionId.trim() : '';
        const previous = await store.getSession(input.sessionId);

        if (decisionId) {
          const decision = await store.getDecision(decisionId);
          if (decision && (!decision.sessionId || decision.sessionId === input.sessionId)) {
            const applied = { ...decision, sessionId: input.sessionId };
            await store.saveDecision(applied);
            await store.saveSession(input.sessionId, {
              decision: applied,
              previous: previous && previous.decision.id !== applied.id
                ? [...previous.previous, previous.decision.id]
                : previous?.previous ?? [],
              overriddenTo: null,
            });
            await store.log('applied', {
              id: applied.id,
              sessionId: input.sessionId,
              provider: input.provider,
              model,
              pick: applied.pick,
              matchesPick: applied.pick ? applied.pick.engine === input.provider && applied.pick.model === model : null,
            });
            const brief = applied.brief && !applied.brief.error && applied.brief.text ? applied.brief : null;
            return {
              notes: brief?.text ?? null,
              notesSource: brief ? { engine: brief.engine, model: brief.model } : null,
              account: input.provider === 'claude' && applied.pick?.engine === 'claude' ? applied.pick.account : null,
              appliedDecisionId: applied.id,
            };
          }
        }

        if (!previous) {
          return NO_TURN;
        }
        const pick = previous.decision.pick;
        if (model && pick && model !== pick.model && previous.overriddenTo !== model) {
          await store.saveSession(input.sessionId, { ...previous, overriddenTo: model });
          await store.log('overridden', { id: previous.decision.id, sessionId: input.sessionId, from: pick.model, to: model });
        }
        return {
          ...NO_TURN,
          account: input.provider === 'claude' && pick?.engine === 'claude' ? pick.account : null,
        };
      } catch (error) {
        console.warn('[auto-route] could not prepare the turn:', error);
        return NO_TURN;
      }
    },

    /** Logs how the turn a decision was applied to ended. */
    async recordOutcome(input: { decisionId: string; sessionId: string; error: string | null }): Promise<void> {
      await store.log(input.error ? 'failed' : 'completed', {
        id: input.decisionId,
        sessionId: input.sessionId,
        error: input.error,
      });
    },
  };
}
