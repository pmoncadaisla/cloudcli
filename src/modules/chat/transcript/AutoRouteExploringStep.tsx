import { useTranslation } from 'react-i18next';
import { Compass } from 'lucide-react';

import { formatDuration, useNow } from '@/modules/chat/hooks/useNow';
import type { AutoRouteStep } from '@/modules/chat/hooks/useAutoRoute';

/**
 * Fork (Auto model choice). Rendered by ChatMessagesPane while an Auto
 * decision is being taken: the prompt as sent, and a live "Exploring…" row
 * with the elapsed time. When the decision lands the real user turn replaces
 * it, with the brief folded under the bubble.
 */
export default function AutoRouteExploringStep({ step, showPrompt }: { step: AutoRouteStep; showPrompt: boolean }) {
  const { t } = useTranslation('chat');
  const now = useNow(true);
  return (
    <div className="space-y-3" data-testid="auto-route-exploring">
      {showPrompt && (
        <div className="flex justify-end px-3 sm:px-0">
          <div className="max-w-full whitespace-pre-wrap break-words rounded-2xl rounded-br-md border border-border/60 bg-muted/60 px-3 py-2 text-[15px] leading-[1.65] text-foreground shadow-sm dark:bg-gray-800/60 sm:max-w-[85%] sm:px-4 md:max-w-md lg:max-w-lg xl:max-w-xl">
            {step.prompt}
          </div>
        </div>
      )}
      <div className="flex items-center gap-2 px-3 text-xs text-muted-foreground sm:px-0">
        <Compass className="h-3.5 w-3.5 animate-pulse text-hemi-copper" aria-hidden />
        <span className="font-medium text-foreground/80">
          {step.reevaluation
            ? t('autoRoute.reexploring', { defaultValue: 'Re-evaluating: exploring the request…' })
            : t('autoRoute.exploring', { defaultValue: 'Exploring…' })}
        </span>
        <span>
          {t('autoRoute.exploringDetail', {
            defaultValue: 'a quick read-only look before choosing the model',
          })}
        </span>
        <span className="font-mono text-[11px] text-muted-foreground/70">{formatDuration(now - step.startedAt)}</span>
      </div>
    </div>
  );
}
