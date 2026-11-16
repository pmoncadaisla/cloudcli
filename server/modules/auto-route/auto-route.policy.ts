/**
 * Fork (Hemilake): the pure rules of the Auto model choice. Nothing here does
 * I/O, so every rule is tested with plain objects.
 *
 * Two decisions, taken apart, on the explorer's brief:
 *
 *   capability   how capable a model the request needs: light (Haiku 5.5,
 *                GPT-5.6 Luna), standard (Sonnet 5.5, GPT-5.6 Terra) or strong
 *                (Opus 5.5, GPT-5.6 Sol)
 *   effort       how much thinking it needs: low, medium, high or xhigh, on
 *                whichever model (Haiku at high and Opus at low are both fine)
 *
 * The point is to spend less without starving the work. Gemini Decisions is
 * rarely sure about this (a benchmark of 30 real issues against an Opus
 * oracle, ~/chat/router-pairs-bench, gave a median top probability of 0.49
 * and ~70 % under-provisioned picks when the cheapest likely pair was taken),
 * so when its top probability is below AUTO_ROUTE_THRESHOLDS.unsure the
 * answer is the middle pair, Sonnet (or Terra) at high, not the cheapest.
 * Cheaper pairs need a confident answer; Opus and Sol need a confident strong
 * signal backed by design or stakes; xhigh needs that plus a confident hard
 * and high-stakes signal. When a session falls short, Pablo's "re-evaluate"
 * moves the next decision two rungs up the pair ladder (escalate). Every
 * threshold is in AUTO_ROUTE_THRESHOLDS, and every probability is logged, so
 * they can be tuned against the log.
 *
 * The engine (Claude or Codex) and the Claude account come from the live
 * quotas, as in the Linear dispatcher of hemilake/hemilake
 * (scripts/agent/placement.py and quota.py).
 */

import type {
  AutoRouteCapability,
  AutoRouteClaudeAccount,
  AutoRouteEffort,
  AutoRouteEngine,
  AutoRoutePick,
  AutoRouteQuota,
} from '@/shared/types.js';

export const AUTO_ROUTE_CAPABILITIES: readonly AutoRouteCapability[] = ['light', 'standard', 'strong'];
export const AUTO_ROUTE_EFFORTS: readonly AutoRouteEffort[] = ['low', 'medium', 'high', 'xhigh'];

/** The proxy's ceiling: an account is used up at 95 % of its weekly window. */
const CEILING = 0.95;
/** An account past 90 % of its 5 h window is skipped for a new session. */
const FIVE_H_MAX = 0.9;
const WEEK_H = 168;
const CLAUDE_TIGHT = 1.0;
const CODEX_ROOM = 1.2;
const PLAN_WEIGHT: Record<string, number> = { max_20x: 20, max_5x: 5, pro: 1 };

/**
 * Every threshold of the two decisions, in one place to tune them against
 * `decisions.jsonl`. Probabilities are Gemini Decisions': the Choice's
 * probability of an option, or a Noul's probability of yes.
 */
export const AUTO_ROUTE_THRESHOLDS = {
  /** A Choice whose top probability is below this is unsure: the middle pair runs. */
  unsure: 0.6,
  /** The middle pair: what runs whenever the capability Choice is unsure. */
  defaultCapability: 'standard' as AutoRouteCapability,
  unsureEffort: 'high' as AutoRouteEffort,
  /** strong: the Choice says strong at least this sure... */
  strong: 0.65,
  /** ...and design (multi-step design or tricky debugging) or stakes says yes at least this sure. */
  strongSupport: 0.6,
  /** light: the Choice says light at least this sure, and routine (reading or mechanical) at least... */
  light: 0.6,
  lightRoutine: 0.6,
  /** ...with design below this. */
  lightDesignMax: 0.3,
  /** Effort: low or medium only when the depth Choice says so at least this sure; otherwise high. */
  depthSure: 0.6,
  /** xhigh (strong models only) needs the depth Choice at xhigh (or xhigh + high) at least this sure... */
  xhigh: 0.6,
  /** ...and both design and stakes at least this sure. Otherwise it is held at high. */
  xhighDesign: 0.7,
  xhighStakes: 0.7,
  /** low is also allowed when routine is this sure with design below lightDesignMax. */
  lowRoutine: 0.8,
  /** Rungs a re-evaluation climbs on PAIR_LADDER from the pair the session ran on. */
  escalationRungs: 2,
} as const;

/**
 * Relative cost of each capability · effort pair (Haiku at low = 1), from the
 * benchmark's cost table; the pairs it did not price are interpolated. Only
 * used to order pairs for escalation.
 */
const PAIR_COST: Record<AutoRouteCapability, Record<AutoRouteEffort, number>> = {
  light: { low: 1, medium: 1.5, high: 2, xhigh: 3 },
  standard: { low: 4, medium: 6, high: 9, xhigh: 13 },
  strong: { low: 8, medium: 12, high: 18, xhigh: 30 },
};

/** The rungs a re-evaluation climbs, cheapest first. */
const PAIR_LADDER: ReadonlyArray<{ capability: AutoRouteCapability; effort: AutoRouteEffort }> = [
  { capability: 'light', effort: 'low' },
  { capability: 'light', effort: 'medium' },
  { capability: 'light', effort: 'high' },
  { capability: 'standard', effort: 'medium' },
  { capability: 'standard', effort: 'high' },
  { capability: 'strong', effort: 'medium' },
  { capability: 'strong', effort: 'high' },
  { capability: 'strong', effort: 'xhigh' },
];

/** The ladder per engine, cheapest first. Codex never gets GPT-6 Astra: it is chosen only by hand. */
const MODEL_LADDER: Record<AutoRouteEngine, Record<AutoRouteCapability, string>> = {
  claude: { light: 'haiku', standard: 'sonnet', strong: 'opus' },
  codex: { light: 'gpt-5.6-luna', standard: 'gpt-5.6-terra', strong: 'gpt-5.6-sol' },
};

// ---------------------------
//----------------- GEMINI DECISIONS QUESTIONS ------------

/**
 * The five questions asked of gemini-decision-1 in one call: two Choices
 * (capability and reasoning depth, asked apart on purpose) and three Nouls
 * that back them up. Worded for Studio, which both chats and codes.
 * Consumed by the decisions client of this module.
 */
export const AUTO_ROUTE_QUESTIONS = {
  capability: {
    type: 'choice',
    instructions: 'How capable a model does this request need to be done well? Think of the cheapest model that '
      + 'would do it right, not the best one available.',
    criteria: {
      light: 'A small fast model is enough: answer a question from what is given, summarise, look something up, '
        + 'format or translate text, a mechanical edit (rename, config value, a one-line fix already spelled out).',
      standard: 'A solid everyday model: ordinary coding across a few files with tests, reading several sources '
        + 'and putting them together, writing a normal document or email, a bug whose cause is easy to find.',
      strong: 'The most capable model: architecture or design decisions across components, a subtle bug or an '
        + 'unexplained failure, migrations, concurrency, security, performance work, or anything where a '
        + 'plausible but wrong answer would be costly and hard to notice.',
    },
  },
  depth: {
    type: 'choice',
    instructions: 'Separately from which model, how much step-by-step reasoning does this request need?',
    criteria: {
      low: 'Almost none: the answer or the edit is direct once the facts are in front of you.',
      medium: 'Some: a few steps to plan or check, ordinary care.',
      high: 'A lot: several interacting parts, alternatives to weigh, results to verify carefully.',
      xhigh: 'Exhaustive: a hard multi-step design or debugging problem with high stakes, where every step must '
        + 'be checked.',
    },
  },
  routine: {
    type: 'noul',
    instructions: 'Is this request mostly reading and answering, or mechanical editing, rather than designing or '
      + 'debugging something?',
    criteria: {
      true_description: 'Yes, mostly reading, answering or mechanical editing.',
      false_description: 'No, it needs designing, investigating or real problem solving.',
    },
  },
  design: {
    type: 'noul',
    instructions: 'Does this request need multi-step design or tricky debugging (a cause not yet known, several '
      + 'components to change together, trade-offs to weigh)?',
    criteria: {
      true_description: 'Yes, multi-step design or tricky debugging.',
      false_description: 'No, the way to do it is clear.',
    },
  },
  stakes: {
    type: 'noul',
    instructions: 'Is the cost of a wrong answer high here: production systems, data that could be lost or '
      + 'corrupted, security, money, or something sent to other people in the user\'s name?',
    criteria: {
      true_description: 'Yes, a mistake would be costly.',
      false_description: 'No, a mistake would be cheap to notice and fix.',
    },
  },
} as const;

export type AutoRouteProbabilities = {
  capability: Record<AutoRouteCapability, number>;
  depth: Record<AutoRouteEffort, number>;
  routine: number;
  design: number;
  stakes: number;
};

const round = (value: number, digits = 3): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const toNumber = (value: unknown): number => {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : 0;
};

const asRecord = (value: unknown): Record<string, unknown> => (
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
);

const f2 = (value: number) => value.toFixed(2);

/**
 * The numbers both decisions are taken from: each Choice's probabilities and
 * each Noul's probability of yes. Throws when an answer is missing, which the
 * caller turns into a fallback.
 */
export function readProbabilities(answers: unknown): AutoRouteProbabilities {
  const record = asRecord(answers);
  const missing = Object.keys(AUTO_ROUTE_QUESTIONS).filter((question) => !(question in record));
  if (missing.length > 0) {
    throw new Error(`answer without ${missing.join(', ')}`);
  }
  const capability = asRecord(asRecord(record.capability).probabilities);
  const depth = asRecord(asRecord(record.depth).probabilities);
  return {
    capability: {
      light: round(toNumber(capability.light)),
      standard: round(toNumber(capability.standard)),
      strong: round(toNumber(capability.strong)),
    },
    depth: {
      low: round(toNumber(depth.low)),
      medium: round(toNumber(depth.medium)),
      high: round(toNumber(depth.high)),
      xhigh: round(toNumber(depth.xhigh)),
    },
    routine: round(toNumber(asRecord(record.routine).noul)),
    design: round(toNumber(asRecord(record.design).noul)),
    stakes: round(toNumber(asRecord(record.stakes).noul)),
  };
}

/** The highest probability of a Choice and its option. */
function topOf<T extends string>(probabilities: Record<T, number>, order: readonly T[]): { option: T; p: number } {
  return order.reduce(
    (best, option) => (probabilities[option] > best.p ? { option, p: probabilities[option] } : best),
    { option: order[0], p: probabilities[order[0]] },
  );
}

/**
 * The model capability, with why. Unsure (top probability below `unsure`)
 * means the middle one; strong needs a confident Choice backed by design or
 * stakes; light needs a confident Choice, routine work and no design.
 */
export function capabilityOf(p: AutoRouteProbabilities): { capability: AutoRouteCapability; unsure: boolean; why: string } {
  const t = AUTO_ROUTE_THRESHOLDS;
  const { light, strong } = p.capability;
  const top = topOf(p.capability, AUTO_ROUTE_CAPABILITIES);
  if (top.p < t.unsure) {
    return {
      capability: t.defaultCapability,
      unsure: true,
      why: `unsure (top ${top.option} ${f2(top.p)} < ${f2(t.unsure)}): the middle pair`,
    };
  }
  if (strong >= t.strong && (p.design >= t.strongSupport || p.stakes >= t.strongSupport)) {
    return { capability: 'strong', unsure: false, why: `strong ${f2(strong)}, design ${f2(p.design)}, stakes ${f2(p.stakes)}` };
  }
  if (light >= t.light && p.routine >= t.lightRoutine && p.design < t.lightDesignMax) {
    return { capability: 'light', unsure: false, why: `light ${f2(light)}, routine ${f2(p.routine)}, design ${f2(p.design)}` };
  }
  if (top.option === 'strong') {
    return {
      capability: t.defaultCapability,
      unsure: false,
      why: `strong ${f2(strong)} without design or stakes behind it (${f2(p.design)}, ${f2(p.stakes)}): the middle one`,
    };
  }
  if (top.option === 'light') {
    return {
      capability: t.defaultCapability,
      unsure: false,
      why: `light ${f2(light)} but not clearly routine (routine ${f2(p.routine)}, design ${f2(p.design)}): the middle one`,
    };
  }
  return { capability: 'standard', unsure: false, why: `standard ${f2(p.capability.standard)}` };
}

/**
 * The reasoning effort, apart from the model. When the capability was unsure,
 * the middle pair's effort (high). Otherwise low or medium only on a
 * confident depth Choice (or clearly routine work for low); xhigh only on a
 * strong model with design and stakes both clear; high in every other case.
 */
export function effortOf(
  p: AutoRouteProbabilities,
  capability: { capability: AutoRouteCapability; unsure: boolean } = { capability: 'standard', unsure: false },
): { effort: AutoRouteEffort; why: string } {
  const t = AUTO_ROUTE_THRESHOLDS;
  const d = p.depth;
  if (capability.unsure) {
    return { effort: t.unsureEffort, why: `capability unsure: the middle pair's ${t.unsureEffort}` };
  }
  const top = topOf(d, AUTO_ROUTE_EFFORTS);
  const hardAndCostly = p.design >= t.xhighDesign && p.stakes >= t.xhighStakes;
  const deep = d.xhigh >= t.xhigh || (top.option === 'xhigh' && d.xhigh + d.high >= t.xhigh);
  if (deep && hardAndCostly && capability.capability === 'strong') {
    return { effort: 'xhigh', why: `xhigh ${f2(d.xhigh)}, design ${f2(p.design)}, stakes ${f2(p.stakes)}` };
  }
  if (top.option === 'xhigh') {
    return { effort: 'high', why: `xhigh ${f2(d.xhigh)} held at high: design ${f2(p.design)}, stakes ${f2(p.stakes)}` };
  }
  if ((top.option === 'low' && d.low >= t.depthSure) || (p.routine >= t.lowRoutine && p.design < t.lightDesignMax)) {
    return { effort: 'low', why: `low ${f2(d.low)}, routine ${f2(p.routine)}` };
  }
  if (top.option === 'medium' && d.medium >= t.depthSure) {
    return { effort: 'medium', why: `medium ${f2(d.medium)}` };
  }
  return {
    effort: 'high',
    why: top.option === 'high' ? `high ${f2(d.high)}` : `depth unsure (top ${top.option} ${f2(top.p)}): high`,
  };
}

/**
 * Two rungs up PAIR_LADDER from the pair a session ran on, for a
 * re-evaluation (a session falls short because the pick was too small, and
 * one rung often is not enough: Sonnet at high goes to Opus at high). A new
 * decision that already costs as much stands. At the top it stays.
 */
export function escalate(
  capability: AutoRouteCapability,
  effort: AutoRouteEffort,
  previous: { capability: AutoRouteCapability; effort: AutoRouteEffort },
): { capability: AutoRouteCapability; effort: AutoRouteEffort; why: string } {
  const cost = (pair: { capability: AutoRouteCapability; effort: AutoRouteEffort }) => PAIR_COST[pair.capability][pair.effort];
  const previousCost = cost(previous);
  let rung = 0;
  PAIR_LADDER.forEach((candidate, index) => {
    if (cost(candidate) <= previousCost) {
      rung = index;
    }
  });
  const last = PAIR_LADDER.length - 1;
  if (rung === last && previousCost >= cost(PAIR_LADDER[last])) {
    return { ...previous, why: 'already at the top of the ladder' };
  }
  const target = PAIR_LADDER[Math.min(last, rung + AUTO_ROUTE_THRESHOLDS.escalationRungs)];
  if (cost({ capability, effort }) >= cost(target)) {
    return { capability, effort, why: 'the new decision is already two rungs above the last one' };
  }
  return {
    ...target,
    why: `two rungs up: ${previous.capability}·${previous.effort} → ${target.capability}·${target.effort}`,
  };
}

/** The capability of a model on the ladder, or null for one Auto would not pick (Astra, Fable, a custom model). */
export function capabilityOfModel(engine: AutoRouteEngine, model: string): AutoRouteCapability | null {
  const base = model.replace(/\[.*\]$/, '');
  const found = AUTO_ROUTE_CAPABILITIES.find((capability) => MODEL_LADDER[engine][capability] === base);
  return found ?? null;
}

// ---------------------------
//----------------- QUOTAS ------------

/** Share of a weekly window still to run, from its reset time (ISO 8601); 1.0 when unknown. */
function leftFraction(resetAt: unknown, now: number): number {
  if (typeof resetAt !== 'string' || !resetAt) {
    return 1;
  }
  const at = Date.parse(resetAt);
  if (!Number.isFinite(at)) {
    return 1;
  }
  return Math.min(1, Math.max(0, (at - now) / 3_600_000 / WEEK_H));
}

/** account -> plan weight from the usage exporter's `claude_plan_usage_percent` tier label. */
export function readPlanWeights(metrics: string): Record<string, number> {
  const weights: Record<string, number> = {};
  for (const line of metrics.split('\n')) {
    if (!line.startsWith('claude_plan_usage_percent')) {
      continue;
    }
    const match = /account="([^"]+)".*?tier="([^"]+)"/.exec(line);
    if (match) {
      const plan = Object.keys(PLAN_WEIGHT).find((key) => match[2].includes(key));
      weights[match[1]] = plan ? PLAN_WEIGHT[plan] : 1;
    }
  }
  return weights;
}

/** One row per account of claude-oauth-proxy (`/routing` plus `/surplus`): quota.py claude_accounts. */
export function claudeAccounts(
  surplus: unknown,
  routing: unknown,
  weights: Record<string, number>,
  now = Date.now(),
): AutoRouteClaudeAccount[] {
  const surplusByAccount = new Map<string, Record<string, unknown>>();
  for (const entry of (asRecord(surplus).accounts as unknown[]) ?? []) {
    const row = asRecord(entry);
    if (typeof row.account === 'string') {
      surplusByAccount.set(row.account, row);
    }
  }
  const rows: AutoRouteClaudeAccount[] = [];
  for (const entry of (asRecord(routing).accounts as unknown[]) ?? []) {
    const account = asRecord(entry);
    const label = typeof account.label === 'string' ? account.label : '';
    if (!label) {
      continue;
    }
    const windows = asRecord(account.windows);
    const weekly = toNumber(asRecord(windows['7d']).utilization);
    const fiveHour = toNumber(asRecord(windows['5h']).utilization);
    const left = leftFraction(asRecord(windows['7d']).reset_at, now);
    const parked = account.parked ? String(asRecord(account.parked).reason ?? 'parked') : null;
    const dead = Boolean(account.dead);
    const surplusRow = surplusByAccount.get(label) ?? {};
    rows.push({
      account: label,
      weekly: round(weekly),
      fiveHour: round(fiveHour),
      left: round(left),
      parked,
      dead,
      weight: weights[label] ?? 1,
      available: !dead && !parked && weekly < CEILING && fiveHour < FIVE_H_MAX,
      ratio: round(Math.max(0, CEILING - weekly) / Math.max(left, 0.05), 2),
      surplus: typeof surplusRow.surplus === 'number' ? surplusRow.surplus : null,
      canBurn: Boolean(surplusRow.can_burn),
    });
  }
  return rows;
}

/** What the available accounts have left, weighted by plan, over the time they have left; 0 with none. */
export function pooledRatio(rows: AutoRouteClaudeAccount[]): number {
  const available = rows.filter((row) => row.available);
  const need = available.reduce((sum, row) => sum + row.weight * Math.max(row.left, 0.05), 0);
  const have = available.reduce((sum, row) => sum + row.weight * Math.max(0, CEILING - row.weekly), 0);
  return need ? round(have / need, 2) : 0;
}

/**
 * The Codex side of the quota from `account/rateLimits/read` (quota.py
 * codex_limits): the weekly window's use, the share of it still to run and
 * the same ratio as Claude's.
 */
export function codexLimits(result: unknown, now = Date.now()): Extract<AutoRouteQuota['codex'], { used: number }> {
  const record = asRecord(result);
  const limits = asRecord(asRecord(record.rateLimitsByLimitId).codex ?? record.rateLimits);
  const primary = asRecord(limits.primary);
  const used = toNumber(primary.usedPercent) / 100;
  const windowHours = (toNumber(primary.windowDurationMins) || WEEK_H * 60) / 60;
  const resetsAt = typeof primary.resetsAt === 'number' ? primary.resetsAt : null;
  const left = resetsAt
    ? Math.min(1, Math.max(0, (resetsAt * 1000 - now) / 3_600_000 / windowHours))
    : 1;
  const reached = Boolean(limits.rateLimitReachedType || limits.spendControlReached);
  return {
    used: round(used),
    left: round(left),
    ratio: reached ? 0 : round(Math.max(0, CEILING - used) / Math.max(left, 0.05), 2),
    reached,
    plan: typeof limits.planType === 'string' ? limits.planType : null,
    resetsAt,
  };
}

const claudeSide = (quota: AutoRouteQuota | null) => (
  quota && !('error' in quota.claude) ? quota.claude : null
);
const codexSide = (quota: AutoRouteQuota | null) => (
  quota && !('error' in quota.codex) ? quota.codex : null
);

/** Codex answered, is not at its limit and has CODEX_ROOM for the time left (Studio has no slot cap). */
export function codexHasRoom(quota: AutoRouteQuota | null): boolean {
  const codex = codexSide(quota);
  return Boolean(codex && !codex.reached && codex.ratio >= CODEX_ROOM);
}

/** Whether every Claude account the proxy knows is used up or parked (false when the quota is unreadable). */
export function claudeExhausted(quota: AutoRouteQuota | null): boolean {
  const claude = claudeSide(quota);
  return Boolean(claude && claude.accounts.length > 0 && !claude.accounts.some((row) => row.available));
}

/** The Claude account to prefer: the one whose quota would be lost at its reset, else the most room for its time. */
export function bestAccount(quota: AutoRouteQuota | null): string | null {
  const available = claudeSide(quota)?.accounts.filter((row) => row.available) ?? [];
  const burnable = available.filter((row) => row.canBurn && (row.surplus ?? 0) > 0);
  if (burnable.length > 0) {
    return burnable.reduce((best, row) => ((row.surplus ?? 0) > (best.surplus ?? 0) ? row : best)).account;
  }
  if (available.length === 0) {
    return null;
  }
  return available.reduce((best, row) => (
    row.ratio > best.ratio || (row.ratio === best.ratio && row.weight > best.weight) ? row : best
  )).account;
}

/** The capabilities tight Claude sends to Codex: a comma-separated list, or all three. */
export function readCodexCapabilities(raw: string | undefined): AutoRouteCapability[] {
  const values = (raw ?? '').split(',').map((value) => value.trim())
    .filter((value): value is AutoRouteCapability => (AUTO_ROUTE_CAPABILITIES as readonly string[]).includes(value));
  return values.length > 0 ? values : [...AUTO_ROUTE_CAPABILITIES];
}

/** (engine, why) from the capability, an engine the session is held to, and the quotas: placement.py engine_for. */
export function engineFor(
  capability: AutoRouteCapability | null,
  forced: AutoRouteEngine | null,
  quota: AutoRouteQuota | null,
  codexCapabilities: AutoRouteCapability[],
): { engine: AutoRouteEngine; why: string } {
  if (forced) {
    return { engine: forced, why: `kept on ${forced === 'codex' ? 'Codex' : 'Claude'}, the session's engine` };
  }
  const claude = claudeSide(quota);
  if (!claude) {
    return { engine: 'claude', why: 'Claude quota unreadable' };
  }
  const ratio = claude.ratio.toFixed(2);
  if (!codexHasRoom(quota)) {
    return { engine: 'claude', why: `Claude ${ratio}, Codex without room` };
  }
  if (!claude.accounts.some((row) => row.available)) {
    return { engine: 'codex', why: 'every Claude account is used up or parked' };
  }
  const codexRatio = codexSide(quota)?.ratio.toFixed(2);
  if (claude.ratio < CLAUDE_TIGHT && codexCapabilities.includes(capability ?? 'standard')) {
    return { engine: 'codex', why: `Claude tight (${ratio} < ${CLAUDE_TIGHT.toFixed(1)}), Codex ${codexRatio}` };
  }
  const stays = capability && !codexCapabilities.includes(capability) ? `, ${capability} stays on Claude` : '';
  return { engine: 'claude', why: `Claude ${ratio}${stays}` };
}

// ---------------------------
//----------------- MODEL PLAN ------------

/** "claude-opus-5-5" -> "Opus 5.5"; the bare alias, capitalised, when the id says nothing more. */
function claudeModelName(alias: string, env: NodeJS.ProcessEnv): string {
  const family = alias.replace(/\[.*\]$/, '');
  const configured = env[`ANTHROPIC_DEFAULT_${family.toUpperCase()}_MODEL`] ?? '';
  const match = /claude-(opus|sonnet|haiku)-(\d+)(?:-(\d+))?/.exec(configured);
  const name = family.charAt(0).toUpperCase() + family.slice(1);
  if (!match) {
    return name;
  }
  return `${name} ${match[2]}${match[3] ? `.${match[3]}` : ''}`;
}

/** "gpt-5.6-sol" -> "GPT-5.6 Sol". */
function codexModelName(model: string): string {
  const [, version, ...rest] = model.split('-');
  const tail = rest.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
  return version ? `GPT-${version}${tail ? ` ${tail}` : ''}` : model;
}

/** How the badge names a pick: "Opus 5.5 · high", "Codex · GPT-5.6 Sol · high". */
export function pickLabel(engine: AutoRouteEngine, model: string, effort: string, env: NodeJS.ProcessEnv): string {
  const effortPart = effort && effort !== 'default' ? ` · ${effort}` : '';
  return engine === 'codex'
    ? `Codex · ${codexModelName(model)}${effortPart}`
    : `${claudeModelName(model, env)}${effortPart}`;
}

/** Model, effort and label of a capability and an effort on an engine, with the preferred Claude account. */
export function planFor(input: {
  capability: AutoRouteCapability;
  effort: AutoRouteEffort;
  engine: AutoRouteEngine;
  account: string | null;
  env: NodeJS.ProcessEnv;
}): AutoRoutePick {
  const { capability, effort, engine, env } = input;
  const model = MODEL_LADDER[engine][capability];
  return {
    engine,
    model,
    effort,
    account: engine === 'claude' ? input.account : null,
    label: pickLabel(engine, model, effort, env),
  };
}
