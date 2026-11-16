import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@/shared/api';
import type { AutoRouteDecision, AutoRouteSessionRecord, LLMProvider } from '@/shared/types';
import { subscribeToUserPreferences } from '@/shared/userSettings';
import {
  isAutoRouteEngine,
  readAutoModelPreference,
  writeAutoModelPreference,
} from '@/modules/chat/utils/autoRoute';

/** What a turn routed by Auto is sent with. */
export type AutoRouteTurn = {
  provider: 'claude' | 'codex';
  model: string;
  effort: string;
  decisionId: string;
  decision: AutoRouteDecision;
};

/** The "Exploring…" step shown in the transcript while a decision is being taken. */
export type AutoRouteStep = {
  /** What was typed: the transcript shows it while the session does not exist yet. */
  prompt: string;
  startedAt: number;
  reevaluation: boolean;
};

/** What the composer asks of Auto when it sends. */
export type AutoRouteComposerControls = {
  /** Whether this send goes through explore + decide. */
  appliesTo: (sessionId: string | null) => boolean;
  /** A decision is being taken: the composer ignores other sends meanwhile. */
  busy: boolean;
  /** Explores and decides; null when the request failed (the composer then sends as it would without Auto). */
  route: (input: { prompt: string; projectPath: string; sessionId: string | null }) => Promise<AutoRouteTurn | null>;
  /** Removes the exploring step: called once the real user turn is in the transcript, or the send gave up. */
  endStep: () => void;
};

type DecisionResponse = { success?: boolean; data?: { decision?: AutoRouteDecision }; error?: string };
type RecordResponse = { success?: boolean; data?: { record?: AutoRouteSessionRecord | null } };

/**
 * Fork (Auto model choice). Owned by ChatInterface. Holds whether new chats
 * start in Auto (a user preference), the decision the open session runs on,
 * whether its next message re-evaluates, and the exploring step; and runs
 * POST /api/auto-route/decisions for the composer.
 */
export function useAutoRoute({
  sessionId,
  sessionProvider,
}: {
  sessionId: string | null;
  /** The open session's provider; Auto can only re-decide on Claude and Codex sessions. */
  sessionProvider: LLMProvider | null;
}) {
  const [enabled, setEnabled] = useState<boolean>(readAutoModelPreference);
  const [record, setRecord] = useState<AutoRouteSessionRecord | null>(null);
  const [armedSessionId, setArmedSessionId] = useState<string | null>(null);
  const [step, setStep] = useState<AutoRouteStep | null>(null);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  // A session the composer itself just routed: its record is set from the
  // decision, so the GET that follows the session switch must not clear it.
  const justRoutedRef = useRef<{ sessionId: string; record: AutoRouteSessionRecord } | null>(null);

  useEffect(() => subscribeToUserPreferences(() => setEnabled(readAutoModelPreference())), []);

  useEffect(() => {
    if (!sessionId) {
      setRecord(null);
      return undefined;
    }
    if (justRoutedRef.current?.sessionId === sessionId) {
      setRecord(justRoutedRef.current.record);
      justRoutedRef.current = null;
      return undefined;
    }
    let cancelled = false;
    setRecord(null);
    void (async () => {
      try {
        const response = await api.autoRoute.forSession(sessionId);
        const body = (await response.json()) as RecordResponse;
        if (!cancelled && sessionIdRef.current === sessionId) {
          setRecord(body?.data?.record ?? null);
        }
      } catch {
        // No badge for this session.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const canRouteSession = sessionId ? isAutoRouteEngine(sessionProvider) : true;
  const isArmed = Boolean(sessionId && armedSessionId === sessionId);
  /** Auto is what the composer shows: on for a new chat, or an Auto session not switched by hand. */
  const isActive = sessionId
    ? isArmed || Boolean(record && !record.overriddenTo)
    : enabled;

  const appliesTo = useCallback((targetSessionId: string | null) => {
    if (!targetSessionId) {
      return enabled;
    }
    return armedSessionId === targetSessionId && isAutoRouteEngine(sessionProvider);
  }, [armedSessionId, enabled, sessionProvider]);

  const route = useCallback<AutoRouteComposerControls['route']>(async ({ prompt, projectPath, sessionId: targetSessionId }) => {
    const reevaluation = Boolean(targetSessionId);
    setStep({ prompt, startedAt: Date.now(), reevaluation });
    try {
      const response = await api.autoRoute.decide({
        prompt,
        projectPath,
        ...(targetSessionId ? { reevaluateSessionId: targetSessionId } : {}),
        ...(targetSessionId && isAutoRouteEngine(sessionProvider) ? { forcedEngine: sessionProvider } : {}),
      });
      const body = (await response.json()) as DecisionResponse;
      const decision = body?.data?.decision;
      if (!response.ok || !decision?.pick) {
        console.warn('[auto-route] no decision:', body?.error ?? response.status);
        return null;
      }
      if (targetSessionId) {
        setArmedSessionId((current) => (current === targetSessionId ? null : current));
      }
      return {
        provider: decision.pick.engine,
        model: decision.pick.model,
        effort: decision.pick.effort,
        decisionId: decision.id,
        decision,
      };
    } catch (error) {
      console.warn('[auto-route] the decision request failed:', error);
      return null;
    }
  }, [sessionProvider]);

  const endStep = useCallback(() => setStep(null), []);

  /** Called once the routed turn is sent, with the session it went to. */
  const recordApplied = useCallback((targetSessionId: string, decision: AutoRouteDecision) => {
    const next: AutoRouteSessionRecord = {
      decision: { ...decision, sessionId: targetSessionId },
      previous: record && record.decision.sessionId === targetSessionId && record.decision.id !== decision.id
        ? [...record.previous, record.decision.id]
        : [],
      overriddenTo: null,
    };
    justRoutedRef.current = { sessionId: targetSessionId, record: next };
    if (sessionIdRef.current === targetSessionId || !sessionIdRef.current) {
      setRecord(next);
    }
  }, [record]);

  /** The Auto row of the model menu. */
  const toggle = useCallback(() => {
    if (!sessionId) {
      writeAutoModelPreference(!enabled);
      setEnabled(!enabled);
      return;
    }
    if (isActive) {
      setArmedSessionId(null);
      setRecord((current) => (current ? { ...current, overriddenTo: current.overriddenTo ?? 'manual' } : current));
      return;
    }
    if (canRouteSession) {
      setArmedSessionId(sessionId);
      writeAutoModelPreference(true);
      setEnabled(true);
    }
  }, [canRouteSession, enabled, isActive, sessionId]);

  /** A model or effort picked by hand wins over Auto. */
  const noteManualPick = useCallback((model?: string) => {
    if (!sessionId) {
      if (enabled) {
        writeAutoModelPreference(false);
        setEnabled(false);
      }
      return;
    }
    setArmedSessionId((current) => (current === sessionId ? null : current));
    setRecord((current) => (current && !current.overriddenTo ? { ...current, overriddenTo: model ?? 'manual' } : current));
  }, [enabled, sessionId]);

  /** The badge's "Re-evaluate": the next message explores and decides again, two rungs up. */
  const reevaluate = useCallback(() => {
    if (sessionId && canRouteSession) {
      setArmedSessionId(sessionId);
    }
  }, [canRouteSession, sessionId]);

  const composer = useMemo<AutoRouteComposerControls>(() => ({
    appliesTo,
    busy: step !== null,
    route,
    endStep,
  }), [appliesTo, endStep, route, step]);

  return {
    enabled,
    isActive,
    isArmed,
    canRouteSession,
    record,
    step,
    composer,
    toggle,
    noteManualPick,
    reevaluate,
    recordApplied,
  };
}

export type AutoRouteState = ReturnType<typeof useAutoRoute>;
