import type { AutoRouteDecision, LLMProvider } from '@/shared/types';
import { readUserPreference, writeUserPreference } from '@/shared/userSettings';

/**
 * Fork (Auto model choice). Client helpers for the Auto entry of the model
 * menu: the preference, which providers Auto can place a session on, and how
 * models and decisions are named in the badge and the transcript.
 */

/** The engines Auto picks between; other providers are only chosen by hand. */
export const AUTO_ROUTE_ENGINES: readonly LLMProvider[] = ['claude', 'codex'];

export const isAutoRouteEngine = (provider: string | null | undefined): provider is 'claude' | 'codex' => (
  provider === 'claude' || provider === 'codex'
);

/** Whether new chats start in Auto. Off unless the user turned it on. */
export function readAutoModelPreference(): boolean {
  return readUserPreference<unknown>('autoModel', null) === true;
}

export function writeAutoModelPreference(enabled: boolean): void {
  writeUserPreference('autoModel', enabled ? true : null);
}

const capitalise = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

/**
 * A model id as people say it: "claude-sonnet-5-5" -> "Sonnet 5.5",
 * "gpt-5.6-terra" -> "GPT-5.6 Terra", "opus[1m]" -> "Opus (1M)". Unknown ids
 * come back as they are.
 */
export function formatModelName(model: string | null | undefined): string {
  const raw = typeof model === 'string' ? model.trim() : '';
  if (!raw) {
    return '';
  }
  const claude = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/i.exec(raw);
  if (claude) {
    const version = claude[3] ? `${claude[2]}.${claude[3]}` : claude[2];
    return `${capitalise(claude[1].toLowerCase())} ${version}${claude[4] ? ' (1M)' : ''}`;
  }
  const alias = /^(opus|sonnet|haiku|fable)(\[1m\])?$/i.exec(raw);
  if (alias) {
    return `${capitalise(alias[1].toLowerCase())}${alias[2] ? ' (1M)' : ''}`;
  }
  const gpt = /^gpt-([\d.]+)(?:-(.+))?$/i.exec(raw);
  if (gpt) {
    const tail = (gpt[2] ?? '').split('-').filter(Boolean).map(capitalise).join(' ');
    return `GPT-${gpt[1]}${tail ? ` ${tail}` : ''}`;
  }
  return raw;
}

/** "Auto → Sonnet 5.5 · high"; "Auto" alone when the decision has no pick. */
export function autoRouteBadgeLabel(decision: Pick<AutoRouteDecision, 'pick'> | null | undefined): string {
  return decision?.pick ? `Auto → ${decision.pick.label}` : 'Auto';
}

/** Options of a probability map, highest first, for the popover. */
export function sortedProbabilities(probabilities: Record<string, number> | null | undefined): Array<[string, number]> {
  return Object.entries(probabilities ?? {}).sort((a, b) => b[1] - a[1]);
}

/** "0.4 s", "21 s": the latencies in the popover. */
export function formatLatency(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) {
    return '-';
  }
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`;
}
