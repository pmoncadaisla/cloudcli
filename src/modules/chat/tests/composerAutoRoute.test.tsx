import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import type { AutoRouteComposerControls, AutoRouteTurn } from '@/modules/chat/hooks/useAutoRoute';
import { resetChatDrafts } from '@/shared/chatDrafts';
import type { AutoRouteDecision, PermissionMode, Project } from '@/shared/types';

/**
 * Fork (Auto model choice). An Auto send explores and decides first, then
 * creates the session on the engine Auto picked and sends with its model,
 * effort and decision id. Without a decision it sends as it would without Auto.
 */

const PROJECT: Project = {
  projectId: 'project-1',
  displayName: 'Project One',
  fullPath: '/tmp/project-one',
};

const createSession = vi.fn();

vi.mock('@/shared/api', () => {
  const okJson = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });
  return {
    api: {
      user: {
        drafts: () => okJson({ success: true, drafts: [] }),
        saveDraft: () => okJson({ success: true }),
        deleteDraft: () => okJson({ success: true }),
        preferences: () => okJson({ success: true, preferences: {} }),
        savePreferences: () => okJson({ success: true, preferences: {} }),
      },
      providers: {
        createSession: (payload: unknown) => {
          createSession(payload);
          return okJson({ success: true, data: { sessionId: 'new-session' } });
        },
      },
      commands: { list: () => okJson({ success: true, commands: [] }) },
      files: { search: () => okJson({ success: true, files: [] }) },
    },
  };
});

const decision = {
  id: 'decision-1',
  brief: { text: 'Request: rename a helper', error: null },
  pick: { engine: 'codex', model: 'gpt-5.6-terra', effort: 'high', account: null, label: 'Codex · GPT-5.6 Terra · high' },
} as unknown as AutoRouteDecision;

const turn: AutoRouteTurn = { provider: 'codex', model: 'gpt-5.6-terra', effort: 'high', decisionId: 'decision-1', decision };

const renderComposer = (autoRoute: AutoRouteComposerControls) => {
  const sendMessage = vi.fn();
  const addMessage = vi.fn();
  const onAutoRouteApplied = vi.fn();
  const onSessionEstablished = vi.fn();
  const view = renderHook(() => useChatComposerState({
    selectedProject: PROJECT,
    selectedSession: null,
    currentSessionId: null,
    provider: 'claude',
    permissionMode: 'default',
    cyclePermissionMode: () => undefined,
    resolvePermissionModeForProvider: () => 'default' as PermissionMode,
    currentProviderModel: 'opus',
    currentProviderEffort: 'medium',
    autoRoute,
    onAutoRouteApplied,
    onSessionEstablished,
    isLoading: false,
    canAbortSession: false,
    tokenBudget: null,
    sendMessage,
    scrollToBottom: () => undefined,
    addMessage,
    setIsUserScrolledUp: () => undefined,
    setPendingPermissionRequests: () => undefined,
  }));
  return { view, sendMessage, addMessage, onAutoRouteApplied, onSessionEstablished };
};

const submit = async (view: { result: { current: ReturnType<typeof useChatComposerState> } }, text: string) => {
  await act(async () => {
    view.result.current.setInput(text);
  });
  await act(async () => {
    await view.result.current.handleSubmit({ preventDefault: () => undefined } as never);
  });
};

beforeEach(() => {
  localStorage.clear();
  resetChatDrafts();
  createSession.mockClear();
});

test('an Auto send creates the session on the picked engine and sends the pick', async () => {
  const route = vi.fn<AutoRouteComposerControls['route']>(async () => turn);
  const endStep = vi.fn();
  const { view, sendMessage, addMessage, onAutoRouteApplied, onSessionEstablished } = renderComposer({
    appliesTo: () => true,
    busy: false,
    route,
    endStep,
  });
  await submit(view, 'rename formatLatency');

  assert.deepEqual(route.mock.calls[0][0], { prompt: 'rename formatLatency', projectPath: '/tmp/project-one', sessionId: null });
  assert.equal((createSession.mock.calls[0][0] as { provider: string }).provider, 'codex');
  assert.equal(onSessionEstablished.mock.calls[0][1].provider, 'codex');
  assert.deepEqual(onAutoRouteApplied.mock.calls[0], ['new-session', turn]);

  const frame = sendMessage.mock.calls[0][0];
  assert.equal(frame.sessionId, 'new-session');
  assert.equal(frame.options.model, 'gpt-5.6-terra');
  assert.equal(frame.options.effort, 'high');
  assert.equal(frame.options.autoRouteDecisionId, 'decision-1');

  // The bubble carries the brief, and the exploring step ends once it is there.
  assert.equal(addMessage.mock.calls[0][0].explorerNotes, 'Request: rename a helper');
  assert.equal(endStep.mock.calls.length, 1);
  assert.equal(view.result.current.input, '');
});

test('without a decision the send goes out as it would without Auto', async () => {
  const { view, sendMessage, onAutoRouteApplied } = renderComposer({
    appliesTo: () => true,
    busy: false,
    route: async () => null,
    endStep: vi.fn(),
  });
  await submit(view, 'hello');

  assert.equal((createSession.mock.calls[0][0] as { provider: string }).provider, 'claude');
  assert.equal(onAutoRouteApplied.mock.calls.length, 0);
  const frame = sendMessage.mock.calls[0][0];
  assert.equal(frame.options.model, 'opus');
  assert.equal(frame.options.autoRouteDecisionId, undefined);
});

test('a send Auto does not apply to skips the decision', async () => {
  const route = vi.fn<AutoRouteComposerControls['route']>(async () => turn);
  const { view, sendMessage } = renderComposer({ appliesTo: () => false, busy: false, route, endStep: vi.fn() });
  await submit(view, 'hello');

  assert.equal(route.mock.calls.length, 0);
  assert.equal(sendMessage.mock.calls[0][0].options.model, 'opus');
});
