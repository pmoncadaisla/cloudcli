import assert from 'node:assert/strict';
import test from 'node:test';

import { createQuotaReader } from '../auto-route.quota.js';

const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });

test('readClaude joins /surplus, /routing and the exporter, and caches a good read', async () => {
  const calls: string[] = [];
  let clock = 1_000;
  const reader = createQuotaReader({
    proxyUrl: 'http://proxy',
    exporterUrl: 'http://exporter/metrics',
    now: () => clock,
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.endsWith('/surplus')) return json({ accounts: [] });
      if (url.endsWith('/routing')) return json({ accounts: [{ label: 'a', windows: { '5h': { utilization: 0.1 }, '7d': { utilization: 0.2 } } }] });
      return new Response('claude_plan_usage_percent{account="a",tier="default_claude_max_20x"} 1', { status: 200 });
    },
    readCodexRateLimits: async () => ({ rateLimits: { primary: { usedPercent: 10 } } }),
  });
  const first = await reader.readClaude();
  assert.ok(!('error' in first));
  if (!('error' in first)) {
    assert.equal(first.accounts[0].weight, 20);
    assert.equal(first.accounts[0].available, true);
  }
  await reader.readClaude();
  assert.equal(calls.length, 3);
  clock += 120_000;
  await reader.readClaude();
  assert.equal(calls.length, 6);
});

test('an unreachable proxy or a silent Codex comes back as an error, not a throw', async () => {
  const reader = createQuotaReader({
    proxyUrl: 'http://proxy',
    exporterUrl: 'http://exporter',
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    readCodexRateLimits: () => new Promise(() => undefined),
    codexTimeoutMs: 50,
  });
  assert.match(String((await reader.readClaude() as { error: string }).error), /ECONNREFUSED/);
  assert.match(String((await reader.readCodex() as { error: string }).error), /no answer/);
});
