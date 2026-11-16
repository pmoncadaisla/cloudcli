import assert from 'node:assert/strict';
import test from 'node:test';

import type { AutoRouteQuota } from '@/shared/types.js';

import {
  AUTO_ROUTE_THRESHOLDS,
  bestAccount,
  capabilityOf,
  capabilityOfModel,
  claudeAccounts,
  codexLimits,
  effortOf,
  engineFor,
  escalate,
  pickLabel,
  planFor,
  pooledRatio,
  readCodexCapabilities,
  readPlanWeights,
  readProbabilities,
} from '../auto-route.policy.js';

const NOW = Date.parse('2026-11-16T15:00:00Z');

type Probs = ReturnType<typeof readProbabilities>;
const probs = (overrides: Partial<Probs> & { cap?: Partial<Probs['capability']>; dep?: Partial<Probs['depth']> } = {}): Probs => ({
  capability: { light: 0.3, standard: 0.4, strong: 0.3, ...overrides.cap },
  depth: { low: 0.2, medium: 0.4, high: 0.3, xhigh: 0.1, ...overrides.dep },
  routine: overrides.routine ?? 0.5,
  design: overrides.design ?? 0.3,
  stakes: overrides.stakes ?? 0.2,
});

test('an unsure brief gets the middle pair, standard at high', () => {
  assert.equal(AUTO_ROUTE_THRESHOLDS.unsure, 0.6);
  const unsure = probs();
  const capability = capabilityOf(unsure);
  assert.equal(capability.capability, 'standard');
  assert.equal(capability.unsure, true);
  assert.match(capability.why, /unsure/);
  assert.equal(effortOf(unsure, capability).effort, 'high');
  // The benchmark's typical answer: top probability ~0.49.
  const typical = probs({ cap: { light: 0.1, standard: 0.49, strong: 0.41 }, dep: { low: 0.05, medium: 0.6, high: 0.3, xhigh: 0.05 } });
  assert.equal(capabilityOf(typical).unsure, true);
  assert.equal(effortOf(typical, capabilityOf(typical)).effort, 'high');
});

test('strong needs a confident Choice backed by design or stakes', () => {
  assert.equal(capabilityOf(probs({ cap: { strong: 0.8, standard: 0.15, light: 0.05 }, design: 0.75 })).capability, 'strong');
  assert.equal(capabilityOf(probs({ cap: { strong: 0.8, standard: 0.15, light: 0.05 }, design: 0.1, stakes: 0.7 })).capability, 'strong');
  const unsupported = capabilityOf(probs({ cap: { strong: 0.8, standard: 0.15, light: 0.05 }, design: 0.2, stakes: 0.2 }));
  assert.equal(unsupported.capability, 'standard');
  assert.equal(unsupported.unsure, false);
  assert.match(unsupported.why, /middle one/);
  assert.equal(capabilityOf(probs({ cap: { strong: 0.55, standard: 0.3, light: 0.15 }, design: 0.95, stakes: 0.95 })).unsure, true);
});

test('light only when the Choice is confident, the work routine and no design is needed', () => {
  const light = { cap: { light: 0.7, standard: 0.25, strong: 0.05 } };
  assert.equal(capabilityOf(probs({ ...light, routine: 0.8, design: 0.1 })).capability, 'light');
  assert.equal(capabilityOf(probs({ ...light, routine: 0.8, design: 0.4 })).capability, 'standard');
  assert.equal(capabilityOf(probs({ ...light, routine: 0.4, design: 0.1 })).capability, 'standard');
  assert.equal(capabilityOf(probs({ cap: { light: 0.55, standard: 0.4, strong: 0.05 }, routine: 0.9, design: 0.05 })).capability, 'standard');
});

test('effort is decided apart from the model, and only goes below high when sure', () => {
  const sure = { capability: 'standard' as const, unsure: false };
  assert.equal(effortOf(probs({ dep: { low: 0.1, medium: 0.2, high: 0.6, xhigh: 0.1 } }), sure).effort, 'high');
  assert.equal(effortOf(probs({ dep: { low: 0.65, medium: 0.25, high: 0.1, xhigh: 0 } }), sure).effort, 'low');
  assert.equal(effortOf(probs({ dep: { low: 0.1, medium: 0.7, high: 0.2, xhigh: 0 } }), sure).effort, 'medium');
  assert.equal(effortOf(probs({ routine: 0.9, design: 0.1 }), sure).effort, 'low');
  // Medium but not sure: high.
  assert.equal(effortOf(probs({ dep: { low: 0.1, medium: 0.45, high: 0.4, xhigh: 0.05 } }), sure).effort, 'high');
  // A light model can still think hard.
  const lightButDeep = probs({ cap: { light: 0.8, standard: 0.15, strong: 0.05 }, routine: 0.7, design: 0.1, dep: { low: 0, medium: 0.2, high: 0.7, xhigh: 0.1 } });
  const capability = capabilityOf(lightButDeep);
  assert.equal(capability.capability, 'light');
  assert.equal(effortOf(lightButDeep, capability).effort, 'high');
});

test('xhigh only on a strong model with clear hard and high-stakes signals; otherwise held at high', () => {
  const deep = { cap: { light: 0.02, standard: 0.18, strong: 0.8 }, dep: { low: 0, medium: 0.05, high: 0.25, xhigh: 0.7 } };
  const hard = probs({ ...deep, design: 0.85, stakes: 0.8 });
  assert.equal(capabilityOf(hard).capability, 'strong');
  assert.equal(effortOf(hard, capabilityOf(hard)).effort, 'xhigh');
  const notCostly = probs({ ...deep, design: 0.85, stakes: 0.3 });
  const held = effortOf(notCostly, capabilityOf(notCostly));
  assert.equal(held.effort, 'high');
  assert.match(held.why, /held at high/);
  assert.equal(effortOf(hard, { capability: 'standard', unsure: false }).effort, 'high');
});

test('escalate climbs two rungs of the pair ladder', () => {
  const rung = (from: [string, string], decided: [string, string] = ['light', 'low']) => {
    const out = escalate(decided[0] as never, decided[1] as never, { capability: from[0] as never, effort: from[1] as never });
    return `${out.capability}·${out.effort}`;
  };
  assert.equal(AUTO_ROUTE_THRESHOLDS.escalationRungs, 2);
  assert.equal(rung(['light', 'low']), 'light·high');
  assert.equal(rung(['light', 'high']), 'standard·high');
  assert.equal(rung(['standard', 'medium']), 'strong·medium');
  assert.equal(rung(['standard', 'high']), 'strong·high');
  assert.equal(rung(['strong', 'medium']), 'strong·xhigh');
  assert.equal(rung(['strong', 'high']), 'strong·xhigh');
  // A pair off the ladder climbs from the rung at or below its cost.
  assert.equal(rung(['standard', 'low']), 'standard·high');
  assert.match(escalate('strong', 'low', { capability: 'strong', effort: 'xhigh' }).why, /top of the ladder/);
  // A new decision already two rungs above stands.
  assert.equal(rung(['light', 'medium'], ['strong', 'high']), 'strong·high');
  assert.equal(capabilityOfModel('claude', 'opus[1m]'), 'strong');
  assert.equal(capabilityOfModel('codex', 'gpt-5.6-terra'), 'standard');
  assert.equal(capabilityOfModel('codex', 'gpt-6-astra'), null);
});

test('readProbabilities reads both Choices and the Nouls and rejects missing answers', () => {
  const answers = {
    capability: { probabilities: { light: 0.1, standard: 0.2, strong: 0.7 } },
    depth: { probabilities: { low: 0.1, medium: 0.2, high: 0.6, xhigh: 0.1 } },
    routine: { noul: 0.21234 },
    design: { noul: 0.8 },
    stakes: { noul: 0.02 },
  };
  assert.deepEqual(readProbabilities(answers), {
    capability: { light: 0.1, standard: 0.2, strong: 0.7 },
    depth: { low: 0.1, medium: 0.2, high: 0.6, xhigh: 0.1 },
    routine: 0.212,
    design: 0.8,
    stakes: 0.02,
  });
  assert.throws(() => readProbabilities({ capability: answers.capability }), /answer without depth, routine, design, stakes/);
});

const routing = {
  accounts: [
    { label: 'a', parked: { reason: '5h' }, windows: { '5h': { utilization: 1 }, '7d': { utilization: 0.86, reset_at: '2026-11-22T05:00:00Z' } } },
    { label: 'b', parked: null, windows: { '5h': { utilization: 0.4 }, '7d': { utilization: 0.55, reset_at: '2026-11-22T13:00:00Z' } } },
    { label: 'c', parked: null, windows: { '5h': { utilization: 0.1 }, '7d': { utilization: 0.2, reset_at: '2026-11-23T14:00:00Z' } } },
  ],
};
const surplus = { accounts: [{ account: 'c', surplus: 0.3, can_burn: true }] };

test('claudeAccounts and pooledRatio mirror quota.py', () => {
  const rows = claudeAccounts(surplus, routing, { b: 20, c: 5 }, NOW);
  assert.deepEqual(rows.map((row) => [row.account, row.available, row.weight]), [
    ['a', false, 1],
    ['b', true, 20],
    ['c', true, 5],
  ]);
  const b = rows[1];
  assert.equal(b.left, Math.round((Date.parse('2026-11-22T13:00:00Z') - NOW) / 3_600_000 / 168 * 1000) / 1000);
  assert.ok(pooledRatio(rows) > 0);
  assert.equal(pooledRatio(rows.map((row) => ({ ...row, available: false }))), 0);
});

test('readPlanWeights takes the plan from the exporter tier label', () => {
  const metrics = [
    'claude_plan_usage_percent{account="b",plan="team",tier="default_claude_max_20x",kind="session"} 10',
    'claude_plan_usage_percent{account="c",plan="team",tier="default_claude_max_5x",kind="session"} 10',
    'other_metric{account="d"} 1',
  ].join('\n');
  assert.deepEqual(readPlanWeights(metrics), { b: 20, c: 5 });
});

test('codexLimits reads the weekly window and marks a reached limit', () => {
  const resetsAt = Math.round((NOW + 84 * 3_600_000) / 1000);
  const limits = codexLimits({ rateLimits: { primary: { usedPercent: 13, windowDurationMins: 10080, resetsAt }, planType: 'pro' } }, NOW);
  assert.equal(limits.used, 0.13);
  assert.equal(limits.left, 0.5);
  assert.equal(limits.ratio, 1.64);
  assert.equal(limits.reached, false);
  const reached = codexLimits({ rateLimits: { primary: { usedPercent: 99 }, rateLimitReachedType: 'primary' } }, NOW);
  assert.equal(reached.ratio, 0);
  assert.equal(reached.reached, true);
});

const quota = (claudeRatio: number, available: boolean[], codexRatio: number | null): AutoRouteQuota => ({
  at: new Date(NOW).toISOString(),
  claude: {
    ratio: claudeRatio,
    accounts: available.map((isAvailable, index) => ({
      account: `acct-${index}`, weekly: 0.5, fiveHour: 0.2, left: 0.5, parked: null, dead: false,
      weight: 5, available: isAvailable, ratio: 0.9 + index, surplus: null, canBurn: false,
    })),
  },
  codex: codexRatio === null
    ? { error: 'down' }
    : { used: 0.2, left: 0.5, ratio: codexRatio, reached: false, plan: 'pro', resetsAt: null },
});

test('engineFor places by quota like placement.py', () => {
  const all = readCodexCapabilities(undefined);
  assert.deepEqual(all, ['light', 'standard', 'strong']);
  assert.equal(engineFor('standard', null, quota(1.5, [true], 2), all).engine, 'claude');
  assert.equal(engineFor('standard', null, quota(0.8, [true], 2), all).engine, 'codex');
  assert.equal(engineFor('standard', null, quota(0.8, [true], 1.1), all).engine, 'claude');
  assert.equal(engineFor('strong', null, quota(0.8, [false, false], 2), all).engine, 'codex');
  assert.equal(engineFor('strong', null, quota(0.8, [true], 2), readCodexCapabilities('light,standard')).engine, 'claude');
  assert.equal(engineFor('light', null, quota(0.8, [true], null), all).engine, 'claude');
  assert.equal(engineFor('light', 'claude', quota(0.1, [false], 3), all).engine, 'claude');
  assert.equal(engineFor('light', null, { at: '', claude: { error: 'x' }, codex: { error: 'y' } }, all).why, 'Claude quota unreadable');
});

test('bestAccount prefers quota that would be lost, then the most room', () => {
  const q = quota(1, [true, true, false], 2);
  assert.equal(bestAccount(q), 'acct-1');
  if (!('error' in q.claude)) {
    q.claude.accounts[0] = { ...q.claude.accounts[0], canBurn: true, surplus: 0.2 };
  }
  assert.equal(bestAccount(q), 'acct-0');
  assert.equal(bestAccount(quota(1, [false], 2)), null);
});

test('planFor walks the ladder cheapest first and never picks Astra', () => {
  const env = { ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-5-5', ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-5-5', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-5-5' };
  assert.deepEqual(planFor({ capability: 'strong', effort: 'low', engine: 'claude', account: 'b', env }), {
    engine: 'claude', model: 'opus', effort: 'low', account: 'b', label: 'Opus 5.5 · low',
  });
  assert.equal(planFor({ capability: 'standard', effort: 'medium', engine: 'claude', account: null, env }).label, 'Sonnet 5.5 · medium');
  assert.equal(planFor({ capability: 'light', effort: 'high', engine: 'claude', account: null, env }).label, 'Haiku 5.5 · high');
  const models = (['light', 'standard', 'strong'] as const).map((capability) => planFor({ capability, effort: 'medium', engine: 'codex', account: 'b', env }));
  assert.deepEqual(models.map((pick) => pick.model), ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol']);
  assert.equal(models[1].account, null);
  assert.equal(models[2].label, 'Codex · GPT-5.6 Sol · medium');
  assert.equal(pickLabel('claude', 'haiku', 'default', {}), 'Haiku');
});
