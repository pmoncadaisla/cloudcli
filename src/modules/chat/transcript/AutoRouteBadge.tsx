import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw, Sparkles } from 'lucide-react';

import type { AutoRouteSessionRecord } from '@/shared/types';
import { cn } from '@/shared/utils';
import {
  autoRouteBadgeLabel,
  formatLatency,
  formatModelName,
  sortedProbabilities,
} from '@/modules/chat/utils/autoRoute';

type AutoRouteBadgeProps = {
  record: AutoRouteSessionRecord;
  /** The next message re-evaluates (explore + decide again, two rungs up). */
  isArmed: boolean;
  /** Absent when the session cannot be re-routed (not on Claude or Codex). */
  onReevaluate?: () => void;
};

const percent = (value: number) => `${Math.round(value * 100)}%`;

function ProbabilityRow({ label, values }: { label: string; values: Record<string, number> | null | undefined }) {
  const sorted = sortedProbabilities(values);
  if (sorted.length === 0) return null;
  return (
    <div className="flex items-baseline gap-2">
      <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
      <span className="flex flex-wrap gap-x-2 font-mono">
        {sorted.map(([option, p], index) => (
          <span key={option} className={index === 0 ? 'font-semibold text-foreground' : undefined}>
            {option} {percent(p)}
          </span>
        ))}
      </span>
    </div>
  );
}

/**
 * Fork (Auto model choice). Rendered by ChatMessagesPane in the transcript's
 * top bar for a session Auto placed: "Auto → Sonnet 5.5 · high", and a popover
 * with why (probabilities, signals, quotas, the brief, latencies, fallback)
 * and the "Re-evaluate" action.
 */
export default function AutoRouteBadge({ record, isArmed, onReevaluate }: AutoRouteBadgeProps) {
  const { t } = useTranslation('chat');
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const { decision } = record;

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const quota = decision.quota;
  const claudeQuota = quota && !('error' in quota.claude) ? quota.claude : null;
  const codexQuota = quota && !('error' in quota.codex) ? quota.codex : null;
  const brief = decision.brief;
  const label = autoRouteBadgeLabel(decision);
  const overridden = record.overriddenTo && record.overriddenTo !== 'manual'
    ? formatModelName(record.overriddenTo)
    : record.overriddenTo ? t('autoRoute.manual', { defaultValue: 'a manual pick' }) : null;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={t('autoRoute.badgeTitle', { defaultValue: 'Why Auto chose this model' })}
        className={cn(
          'flex h-8 max-w-[60vw] items-center gap-1.5 rounded-lg border px-2 text-xs font-medium shadow-sm backdrop-blur transition-colors sm:max-w-sm',
          isArmed
            ? 'border-hemi-copper/60 bg-hemi-copper/10 text-foreground'
            : 'border-border/60 bg-card/90 text-foreground hover:bg-muted',
          overridden && 'text-muted-foreground line-through decoration-muted-foreground/60',
        )}
        data-testid="auto-route-badge"
      >
        <Sparkles className="h-3.5 w-3.5 shrink-0 text-hemi-copper" aria-hidden />
        <span className="truncate">{label}</span>
        {isArmed && <RefreshCw className="h-3 w-3 shrink-0 text-hemi-copper" aria-hidden />}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={t('autoRoute.popoverLabel', { defaultValue: 'Auto model choice' })}
          className="absolute right-0 top-9 z-30 w-[min(26rem,calc(100vw-2rem))] space-y-3 rounded-xl border border-border bg-popover p-3 text-xs text-popover-foreground shadow-xl"
          data-testid="auto-route-popover"
        >
          <div>
            <p className="text-sm font-semibold">{label}</p>
            {decision.pick && (
              <p className="mt-0.5 text-muted-foreground">
                {decision.pick.engine === 'codex' ? 'Codex' : 'Claude'} · {decision.pick.model} · {decision.pick.effort}
                {decision.pick.account ? ` · ${decision.pick.account}` : ''}
              </p>
            )}
            {overridden && (
              <p className="mt-1 text-muted-foreground">
                {t('autoRoute.overridden', { model: overridden, defaultValue: 'Switched by hand to {{model}} since.' })}
              </p>
            )}
            {decision.escalatedFrom && (
              <p className="mt-1 text-muted-foreground">
                {t('autoRoute.escalatedFrom', {
                  label: decision.escalatedFrom.label,
                  defaultValue: 'Re-evaluated from {{label}}.',
                })}
              </p>
            )}
          </div>

          {decision.fallback && (
            <p className="rounded-md bg-destructive/10 px-2 py-1 text-destructive">{decision.fallback}</p>
          )}

          {decision.why && (
            <div className="space-y-0.5">
              <p><span className="text-muted-foreground">{t('autoRoute.model', { defaultValue: 'Model' })}:</span> {decision.why.capability}</p>
              <p><span className="text-muted-foreground">{t('autoRoute.effort', { defaultValue: 'Effort' })}:</span> {decision.why.effort}</p>
              {decision.why.escalation && (
                <p><span className="text-muted-foreground">{t('autoRoute.escalation', { defaultValue: 'Re-evaluation' })}:</span> {decision.why.escalation}</p>
              )}
              {decision.placement && (
                <p><span className="text-muted-foreground">{t('autoRoute.engine', { defaultValue: 'Engine' })}:</span> {decision.placement}</p>
              )}
            </div>
          )}

          {(decision.probabilities || decision.signals) && (
            <div className="space-y-1 border-t border-border pt-2">
              <ProbabilityRow label={t('autoRoute.capability', { defaultValue: 'Capability' })} values={decision.probabilities?.capability} />
              <ProbabilityRow label={t('autoRoute.depth', { defaultValue: 'Depth' })} values={decision.probabilities?.depth} />
              {decision.signals && (
                <div className="flex items-baseline gap-2">
                  <span className="w-20 shrink-0 text-muted-foreground">{t('autoRoute.signals', { defaultValue: 'Signals' })}</span>
                  <span className="flex flex-wrap gap-x-2 font-mono">
                    <span>routine {percent(decision.signals.routine)}</span>
                    <span>design {percent(decision.signals.design)}</span>
                    <span>stakes {percent(decision.signals.stakes)}</span>
                  </span>
                </div>
              )}
            </div>
          )}

          {quota && (
            <div className="space-y-0.5 border-t border-border pt-2">
              <p>
                <span className="text-muted-foreground">Claude:</span>{' '}
                {claudeQuota
                  ? `${t('autoRoute.ratio', { defaultValue: 'ratio' })} ${claudeQuota.ratio.toFixed(2)}, ${claudeQuota.accounts.filter((row) => row.available).length}/${claudeQuota.accounts.length} ${t('autoRoute.accountsFree', { defaultValue: 'accounts free' })}`
                  : 'error' in quota.claude ? quota.claude.error : '-'}
              </p>
              <p>
                <span className="text-muted-foreground">Codex:</span>{' '}
                {codexQuota
                  ? `${t('autoRoute.ratio', { defaultValue: 'ratio' })} ${codexQuota.ratio.toFixed(2)}, ${percent(codexQuota.used)} ${t('autoRoute.used', { defaultValue: 'used' })}${codexQuota.reached ? ', limit reached' : ''}`
                  : 'error' in quota.codex ? quota.codex.error : '-'}
              </p>
            </div>
          )}

          {brief && (
            <div className="space-y-1 border-t border-border pt-2">
              <p className="text-muted-foreground">
                {t('autoRoute.brief', {
                  model: formatModelName(brief.model) || brief.model,
                  defaultValue: 'Brief by {{model}}',
                })}
                {brief.kind ? ` · ${brief.kind}` : ''}
                {brief.lakeUsed ? ` · ${t('autoRoute.lake', { defaultValue: 'lake' })}` : ''}
                {` · ${brief.toolCalls} ${t('autoRoute.toolCalls', { defaultValue: 'tool calls' })}`}
              </p>
              {brief.error
                ? <p className="text-destructive">{brief.error}</p>
                : <p className="line-clamp-4 whitespace-pre-wrap">{brief.request || brief.text}</p>}
            </div>
          )}

          <div className="flex items-center justify-between gap-2 border-t border-border pt-2">
            <span className="font-mono text-[11px] text-muted-foreground">
              {t('autoRoute.latency', { defaultValue: 'explore' })} {formatLatency(brief?.latencyMs)}
              {' · '}{t('autoRoute.decide', { defaultValue: 'decide' })} {formatLatency(decision.decisionLatencyMs)}
              {' · '}{t('autoRoute.total', { defaultValue: 'total' })} {formatLatency(decision.totalMs)}
            </span>
            {onReevaluate && (
              <button
                type="button"
                onClick={() => {
                  onReevaluate();
                  setOpen(false);
                }}
                disabled={isArmed}
                className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 font-medium hover:bg-muted disabled:opacity-60"
                title={t('autoRoute.reevaluateTitle', {
                  defaultValue: 'The next message explores and decides again, two rungs above this choice',
                })}
              >
                <RefreshCw className="h-3 w-3" aria-hidden />
                {isArmed
                  ? t('autoRoute.reevaluateArmed', { defaultValue: 'Next message re-evaluates' })
                  : t('autoRoute.reevaluate', { defaultValue: 'Re-evaluate' })}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
