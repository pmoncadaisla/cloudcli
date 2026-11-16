import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { AutoRouteBrief, AutoRouteQuota } from '@/shared/types.js';

import { createAutoRouteService } from '../auto-route.service.js';
import { createAutoRouteStore } from '../auto-route.store.js';

const brief: AutoRouteBrief = {
  text: 'Request: refactor the router\nKind: large-change\nFiles: a.ts, b.ts\nUnknowns: none',
  kind: 'large-change', request: 'refactor the router', files: ['a.ts', 'b.ts'], unknowns: null,
  engine: 'claude', model: 'claude-haiku-5-5', lakeUsed: false, toolCalls: 3, latencyMs: 1200, error: null,
};

const claudeOk: AutoRouteQuota['claude'] = {
  ratio: 1.4,
  accounts: [{ account: 'acct', weekly: 0.3, fiveHour: 0.1, left: 0.6, parked: null, dead: false, weight: 5, available: true, ratio: 1.4, surplus: null, canBurn: false }],
};

async function withService(
  overrides: { answers?: unknown; askError?: Error; claude?: AutoRouteQuota['claude']; codex?: AutoRouteQuota['codex'] },
  body: (service: ReturnType<typeof createAutoRouteService>, root: string) => Promise<void>,
) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'auto-route-'));
  const explored: string[] = [];
  try {
    const service = createAutoRouteService({
      env: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-5-5', ANTHROPIC_AUTH_TOKEN: 'key' },
      store: createAutoRouteStore(root),
      quota: {
        readClaude: async () => overrides.claude ?? claudeOk,
        readCodex: async () => overrides.codex ?? { used: 0.1, left: 0.5, ratio: 1.7, reached: false, plan: 'pro', resetsAt: null },
      },
      explore: async (input) => {
        explored.push(input.engine);
        return { ...brief, engine: input.engine };
      },
      askDecisions: async (text) => {
        assert.match(text, /Request: refactor the router/);
        if (overrides.askError) {
          throw overrides.askError;
        }
        return overrides.answers ?? {
          capability: { probabilities: { light: 0.05, standard: 0.15, strong: 0.8 } },
          depth: { probabilities: { low: 0.02, medium: 0.08, high: 0.2, xhigh: 0.7 } },
          routine: { noul: 0.05 }, design: { noul: 0.9 }, stakes: { noul: 0.85 },
        };
      },
    });
    await body(service, root);
    if (overrides.claude && !('error' in overrides.claude) && !overrides.claude.accounts.some((a) => a.available)) {
      assert.deepEqual(explored, ['codex']);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('decide explores, asks, and places a hard, costly request on Opus xhigh with the best account', async () => {
  await withService({}, async (service, root) => {
    const decision = await service.decide({ prompt: 'refactor the router', projectPath: '/w' });
    assert.equal(decision.capability, 'strong');
    assert.equal(decision.effort, 'xhigh');
    assert.deepEqual(decision.pick, { engine: 'claude', model: 'opus', effort: 'xhigh', account: 'acct', label: 'Opus 5.5 · xhigh' });
    assert.equal(decision.fallback, null);
    assert.equal(decision.promptHash.length, 16);
    const log = (await readFile(path.join(root, 'decisions.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(log[0].event, 'decided');
    assert.equal(log[0].promptHash, decision.promptHash);
    assert.ok(!JSON.stringify(log[0]).includes('"prompt":'));
    assert.deepEqual(log[0].signals, { routine: 0.05, design: 0.9, stakes: 0.85 });
    assert.equal(log[0].probabilities.depth.xhigh, 0.7);
  });
});

test('an unsure answer lands on the middle pair, Sonnet at high, not on Opus or Haiku', async () => {
  const unclear = {
    capability: { probabilities: { light: 0.3, standard: 0.35, strong: 0.35 } },
    depth: { probabilities: { low: 0.25, medium: 0.3, high: 0.3, xhigh: 0.15 } },
    routine: { noul: 0.5 }, design: { noul: 0.5 }, stakes: { noul: 0.4 },
  };
  await withService({ answers: unclear }, async (service) => {
    const decision = await service.decide({ prompt: 'refactor the router', projectPath: '/w' });
    assert.equal(decision.pick?.model, 'sonnet');
    assert.equal(decision.pick?.effort, 'high');
  });
});

test('a re-evaluation goes two rungs above the pick the session ran on', async () => {
  const unclear = {
    capability: { probabilities: { light: 0.3, standard: 0.35, strong: 0.35 } },
    depth: { probabilities: { low: 0.25, medium: 0.3, high: 0.3, xhigh: 0.15 } },
    routine: { noul: 0.5 }, design: { noul: 0.5 }, stakes: { noul: 0.4 },
  };
  await withService({ answers: unclear }, async (service) => {
    const stepped = await service.decide({
      prompt: 'refactor the router',
      projectPath: '/w',
      forcedEngine: 'claude',
      escalateFrom: { engine: 'claude', model: 'sonnet', effort: 'high', account: null, label: 'Sonnet 5.5 · high' },
    });
    // sonnet·high → opus·medium → opus·high
    assert.equal(stepped.pick?.model, 'opus');
    assert.equal(stepped.pick?.effort, 'high');
    assert.match(stepped.why?.escalation ?? '', /two rungs up/);
    assert.equal(stepped.escalatedFrom?.model, 'sonnet');
  });
});

test('a failed decision falls back to the middle pair and says so', async () => {
  await withService({ askError: new Error('Gemini Decisions: HTTP 500') }, async (service) => {
    const decision = await service.decide({ prompt: 'refactor the router', projectPath: '/w' });
    assert.equal(decision.pick?.model, 'sonnet');
    assert.equal(decision.pick?.effort, 'high');
    assert.equal(decision.probabilities, null);
    assert.match(decision.fallback ?? '', /HTTP 500/);
  });
});

test('with every Claude account used up the explorer and the work go to Codex Sol', async () => {
  const [account] = (claudeOk as Extract<AutoRouteQuota['claude'], { accounts: unknown }>).accounts;
  const exhausted: AutoRouteQuota['claude'] = { ratio: 0, accounts: [{ ...account, available: false }] };
  await withService({ claude: exhausted }, async (service) => {
    const decision = await service.decide({ prompt: 'refactor the router', projectPath: '/w' });
    assert.equal(decision.pick?.engine, 'codex');
    assert.equal(decision.pick?.model, 'gpt-5.6-sol');
    assert.equal(decision.pick?.effort, 'xhigh');
  });
});

test('prepareTurn ties the decision to the session once, then keeps the account and notes overrides', async () => {
  await withService({}, async (service, root) => {
    const decision = await service.decide({ prompt: 'refactor the router', projectPath: '/w' });
    const first = await service.prepareTurn({ sessionId: 's1', provider: 'claude', decisionId: decision.id, model: 'opus' });
    assert.equal(first.notes, brief.text);
    assert.deepEqual(first.notesSource, { engine: 'claude', model: 'claude-haiku-5-5' });
    assert.equal(first.account, 'acct');
    assert.equal(first.appliedDecisionId, decision.id);

    // Another session cannot reuse it.
    const stolen = await service.prepareTurn({ sessionId: 's2', provider: 'claude', decisionId: decision.id, model: 'opus' });
    assert.equal(stolen.notes, null);

    const second = await service.prepareTurn({ sessionId: 's1', provider: 'claude', model: 'opus' });
    assert.deepEqual(second, { notes: null, notesSource: null, account: 'acct', appliedDecisionId: null });

    await service.prepareTurn({ sessionId: 's1', provider: 'claude', model: 'sonnet' });
    const record = await service.getForSession('s1');
    assert.equal(record?.overriddenTo, 'sonnet');
    assert.equal(record?.decision.sessionId, 's1');

    await service.recordOutcome({ decisionId: decision.id, sessionId: 's1', error: null });
    const events = (await readFile(path.join(root, 'decisions.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line).event);
    assert.deepEqual(events, ['decided', 'applied', 'overridden', 'completed']);
  });
});

test('a re-evaluation keeps the earlier decision in the history', async () => {
  await withService({}, async (service) => {
    const first = await service.decide({ prompt: 'refactor the router', projectPath: '/w' });
    await service.prepareTurn({ sessionId: 's1', provider: 'claude', decisionId: first.id, model: 'opus' });
    const again = await service.decide({ prompt: 'refactor the router', projectPath: '/w', forcedEngine: 'claude', escalateFrom: first.pick });
    assert.equal(again.forcedEngine, 'claude');
    await service.prepareTurn({ sessionId: 's1', provider: 'claude', decisionId: again.id, model: 'opus' });
    const record = await service.getForSession('s1');
    assert.equal(record?.decision.id, again.id);
    assert.deepEqual(record?.previous, [first.id]);
  });
});

test('prepareTurn is a no-op for sessions Auto never touched', async () => {
  await withService({}, async (service) => {
    assert.deepEqual(await service.prepareTurn({ sessionId: 'plain', provider: 'claude', model: 'opus' }), {
      notes: null, notesSource: null, account: null, appliedDecisionId: null,
    });
    assert.equal((await service.prepareTurn({ sessionId: '../etc', provider: 'claude', decisionId: '../../x' })).notes, null);
  });
});
