/**
 * Fork (Hemilake): reads what is left of the subscriptions an Auto session
 * can run on (hemilake/hemilake scripts/agent/quota.py).
 *
 *   Claude   claude-oauth-proxy: GET /surplus and GET /routing, and the plan of
 *            each account from the usage exporter, which weighs it.
 *   Codex    the official client's app-server, `account/rateLimits/read`,
 *            through the providers module's client. Never through LiteLLM.
 *
 * Every reader answers within its timeout or returns `{ error }`. Reads are
 * cached for a minute: Pablo can open several chats in a row.
 */

import { codexAppServer } from '@/modules/providers/index.js';
import type { AutoRouteQuota } from '@/shared/types.js';
import { getCodexHomeDirectory } from '@/shared/utils.js';

import { claudeAccounts, codexLimits, pooledRatio, readPlanWeights } from './auto-route.policy.js';

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type QuotaReaderOptions = {
  proxyUrl: string;
  exporterUrl: string;
  fetchImpl?: FetchLike;
  readCodexRateLimits?: () => Promise<unknown>;
  timeoutMs?: number;
  codexTimeoutMs?: number;
  cacheMs?: number;
  now?: () => number;
};

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 160);

async function getJson(fetchImpl: FetchLike, url: string, timeoutMs: number): Promise<unknown> {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      // Not unref'd: it is cleared as soon as the read settles either way.
      timer = setTimeout(() => reject(new Error(`${label}: no answer in ${timeoutMs} ms`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Builds the two quota readers the Auto service uses. Exported for the
 * service's composition root and the module's tests.
 */
export function createQuotaReader(options: QuotaReaderOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 2_000;
  const codexTimeoutMs = options.codexTimeoutMs ?? 10_000;
  const cacheMs = options.cacheMs ?? 60_000;
  const now = options.now ?? Date.now;
  const readCodexRateLimits = options.readCodexRateLimits
    ?? (async () => (await codexAppServer.readAccount({ codexHome: getCodexHomeDirectory() })).rateLimits);

  let claudeCache: { at: number; value: AutoRouteQuota['claude'] } | null = null;
  let codexCache: { at: number; value: AutoRouteQuota['codex'] } | null = null;

  async function readClaude(): Promise<AutoRouteQuota['claude']> {
    if (claudeCache && now() - claudeCache.at < cacheMs) {
      return claudeCache.value;
    }
    let value: AutoRouteQuota['claude'];
    try {
      const [surplus, routing] = await Promise.all([
        getJson(fetchImpl, `${options.proxyUrl}/surplus`, timeoutMs),
        getJson(fetchImpl, `${options.proxyUrl}/routing`, timeoutMs),
      ]);
      let weights: Record<string, number> = {};
      try {
        const metrics = await fetchImpl(options.exporterUrl, { signal: AbortSignal.timeout(timeoutMs) });
        weights = metrics.ok ? readPlanWeights(await metrics.text()) : {};
      } catch {
        // Without the exporter every account weighs the same.
      }
      const accounts = claudeAccounts(surplus, routing, weights, now());
      value = { accounts, ratio: pooledRatio(accounts) };
    } catch (error) {
      value = { error: `claude-oauth-proxy: ${errorText(error)}` };
    }
    // An error is not cached: the next chat tries again.
    claudeCache = 'error' in value ? null : { at: now(), value };
    return value;
  }

  async function readCodex(): Promise<AutoRouteQuota['codex']> {
    if (codexCache && now() - codexCache.at < cacheMs) {
      return codexCache.value;
    }
    let value: AutoRouteQuota['codex'];
    try {
      value = codexLimits(await withTimeout(readCodexRateLimits(), codexTimeoutMs, 'codex app-server'), now());
    } catch (error) {
      value = { error: `codex: ${errorText(error)}` };
    }
    codexCache = 'error' in value ? null : { at: now(), value };
    return value;
  }

  return { readClaude, readCodex };
}

export type QuotaReader = ReturnType<typeof createQuotaReader>;
