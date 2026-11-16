import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import type { AutoRouteDecision, AutoRouteSessionRecord } from '@/shared/types';
import ComposerModelMenu from '@/modules/chat/composer/ComposerModelMenu';
import AutoRouteBadge from '@/modules/chat/transcript/AutoRouteBadge';
import AssistantHeader from '@/modules/chat/transcript/AssistantHeader';
import {
  autoRouteBadgeLabel,
  formatLatency,
  formatModelName,
  sortedProbabilities,
} from '@/modules/chat/utils/autoRoute';

const EFFORTS = ['low', 'medium', 'high'].map((value) => ({ value }));
const MODELS = [{ value: 'opus', label: 'Opus' }, { value: 'sonnet', label: 'Sonnet' }];

const decision: AutoRouteDecision = {
  id: 'd1',
  createdAt: '2026-11-16T17:00:00.000Z',
  projectPath: '/w',
  promptHash: 'abcdef0123456789',
  promptChars: 20,
  forcedEngine: null,
  escalatedFrom: null,
  brief: {
    text: 'Request: fix the login redirect\nKind: small-change',
    kind: 'small-change',
    request: 'fix the login redirect',
    files: ['src/auth.ts'],
    unknowns: null,
    engine: 'claude',
    model: 'claude-haiku-5-5',
    lakeUsed: true,
    toolCalls: 3,
    latencyMs: 14_200,
    error: null,
  },
  capability: 'standard',
  effort: 'high',
  probabilities: {
    capability: { light: 0.2, standard: 0.49, strong: 0.31 },
    depth: { low: 0.1, medium: 0.4, high: 0.4, xhigh: 0.1 },
  },
  signals: { routine: 0.3, design: 0.4, stakes: 0.2 },
  why: { capability: 'unsure (top standard 0.49 < 0.60): the middle pair', effort: "capability unsure: the middle pair's high", escalation: null },
  decisionLatencyMs: 420,
  decisionError: null,
  quota: {
    at: '2026-11-16T17:00:00.000Z',
    claude: { ratio: 1.4, accounts: [{ account: 'a', available: true, weekly: 0.3, fiveHour: 0.1, ratio: 1.4, parked: null }] },
    codex: { used: 0.2, ratio: 2.1, reached: false },
  },
  placement: 'Claude 1.40',
  pick: { engine: 'claude', model: 'sonnet', effort: 'high', account: 'a', label: 'Sonnet 5.5 · high' },
  fallback: null,
  totalMs: 15_000,
  sessionId: 's1',
};

const record: AutoRouteSessionRecord = { decision, previous: [], overriddenTo: null };

describe('Auto model choice helpers', () => {
  it('names models the way people say them', () => {
    expect(formatModelName('claude-sonnet-5-5')).toBe('Sonnet 5.5');
    expect(formatModelName('claude-opus-5-5-20261001')).toBe('Opus 5.5');
    expect(formatModelName('claude-haiku-5')).toBe('Haiku 5');
    expect(formatModelName('gpt-5.6-terra')).toBe('GPT-5.6 Terra');
    expect(formatModelName('opus[1m]')).toBe('Opus (1M)');
    expect(formatModelName('some-custom-model')).toBe('some-custom-model');
    expect(formatModelName(undefined)).toBe('');
  });

  it('labels the badge with model and effort, and sorts probabilities', () => {
    expect(autoRouteBadgeLabel(decision)).toBe('Auto → Sonnet 5.5 · high');
    expect(autoRouteBadgeLabel({ pick: null })).toBe('Auto');
    expect(sortedProbabilities(decision.probabilities?.capability)[0]).toEqual(['standard', 0.49]);
    expect(formatLatency(420)).toBe('0.4 s');
    expect(formatLatency(21_400)).toBe('21 s');
    expect(formatLatency(null)).toBe('-');
  });
});

describe('ComposerModelMenu with Auto', () => {
  function renderMenu(autoRoute: Parameters<typeof ComposerModelMenu>[0]['autoRoute'], onSelectModel = vi.fn()) {
    render(
      <ComposerModelMenu
        effort="high"
        effortOptions={EFFORTS}
        onSelectEffort={vi.fn()}
        model="opus"
        modelOptions={MODELS}
        onSelectModel={onSelectModel}
        modelsLoading={false}
        autoRoute={autoRoute}
      />,
    );
    return screen.getByRole('button', { name: 'Select model and reasoning effort' });
  }

  it('reads "Auto → pick" on the trigger and toggles from the first row', () => {
    const onToggle = vi.fn();
    const trigger = renderMenu({ active: true, pickLabel: 'Sonnet 5.5 · high', onToggle });
    expect(trigger.textContent).toContain('Auto → Sonnet 5.5 · high');
    fireEvent.click(trigger);
    const autoRow = screen.getByRole('menuitemradio', { name: /Auto → Sonnet 5.5 · high/ });
    expect(autoRow.getAttribute('aria-checked')).toBe('true');
    // No manual row looks selected while Auto is on.
    expect(screen.getByRole('menuitemradio', { name: 'high' }).getAttribute('aria-checked')).toBe('false');
    fireEvent.click(autoRow);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('shows the model as usual when Auto is off, and a manual pick still goes through', () => {
    const onSelectModel = vi.fn();
    const trigger = renderMenu({ active: false, pickLabel: null, onToggle: vi.fn() }, onSelectModel);
    expect(trigger.textContent).toContain('Opus');
    expect(trigger.textContent).not.toContain('Auto');
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Opus' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Sonnet' }));
    expect(onSelectModel).toHaveBeenCalledWith('sonnet');
  });

  it('explains why Auto is unavailable for a session on another engine', () => {
    const trigger = renderMenu({ active: false, pickLabel: null });
    fireEvent.click(trigger);
    expect(screen.getByText('Auto only places sessions on Claude or Codex')).toBeTruthy();
  });
});

describe('AutoRouteBadge', () => {
  it('shows the pick, and the popover explains it and arms a re-evaluation', () => {
    const onReevaluate = vi.fn();
    render(<AutoRouteBadge record={record} isArmed={false} onReevaluate={onReevaluate} />);
    const badge = screen.getByTestId('auto-route-badge');
    expect(badge.textContent).toContain('Auto → Sonnet 5.5 · high');
    fireEvent.click(badge);
    const popover = screen.getByTestId('auto-route-popover');
    expect(popover.textContent).toContain('standard 49%');
    expect(popover.textContent).toContain('routine 30%');
    expect(popover.textContent).toContain('ratio 1.40');
    expect(popover.textContent).toContain('fix the login redirect');
    expect(popover.textContent).toContain('small-change · lake · 3 tool calls');
    expect(popover.textContent).toContain('decide 0.4 s');
    fireEvent.click(screen.getByRole('button', { name: /Re-evaluate/ }));
    expect(onReevaluate).toHaveBeenCalledTimes(1);
  });

  it('says when the decision fell back or was switched by hand', () => {
    render(
      <AutoRouteBadge
        record={{ ...record, overriddenTo: 'opus', decision: { ...decision, fallback: 'Gemini Decisions failed (HTTP 500): the middle pair runs' } }}
        isArmed
      />,
    );
    fireEvent.click(screen.getByTestId('auto-route-badge'));
    const popover = screen.getByTestId('auto-route-popover');
    expect(popover.textContent).toContain('HTTP 500');
    expect(popover.textContent).toContain('Switched by hand');
    expect(screen.queryByRole('button', { name: /Re-evaluate/ })).toBeNull();
  });
});

describe('AssistantHeader', () => {
  it('names the model a turn ran on next to the provider', () => {
    render(<AssistantHeader kind="assistant" provider="codex" model="gpt-5.6-terra" />);
    expect(screen.getByTestId('assistant-model').textContent).toBe('GPT-5.6 Terra');
  });

  it('shows nothing extra when the transcript does not say', () => {
    render(<AssistantHeader kind="assistant" provider="claude" />);
    expect(screen.queryByTestId('assistant-model')).toBeNull();
  });
});
