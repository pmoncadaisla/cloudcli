/**
 * Fork (Hemilake): asks Gemini Decisions (gemini-decision-1, through think's
 * LiteLLM pass-through) the Auto router's four questions about a request, as
 * scripts/agent/router.py does for the Linear dispatcher: ~1-2k input tokens,
 * a few hundredths of a cent, 0.2-0.5 s.
 *
 * Decisions only exists on Google AI Studio (no Vertex, no EU region), so
 * what it reads leaves for Google. It gets the explorer's reading of the
 * request and the request itself, never the lake facts or code excerpts the
 * explorer saw.
 */

import path from 'node:path';

import type { AutoRouteBrief } from '@/shared/types.js';

import { AUTO_ROUTE_QUESTIONS } from './auto-route.policy.js';

const MODEL = 'gemini-decision-1';
const PROMPT_CHARS = 4000;

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * What the decision reads: the folder's name, the explorer's reading (request,
 * kind, files, unknowns) and the user's words. Exported for tests.
 */
export function describeForDecision(prompt: string, brief: AutoRouteBrief | null, projectPath: string): string {
  const lines = [
    'A request to an AI assistant in Hemilake Studio, a workspace that both chats and writes code, working in the '
      + `folder "${path.basename(projectPath) || projectPath}".`,
  ];
  if (brief && !brief.error && brief.text) {
    lines.push(
      'A quick read-only look at the request before choosing the model found:',
      `Request: ${brief.request ?? '-'}`,
      `Kind: ${brief.kind ?? '-'}`,
      `Files likely involved (${brief.files.length}): ${brief.files.slice(0, 12).join(', ') || 'none'}`,
      `Unknowns: ${brief.unknowns ?? '-'}`,
    );
  } else {
    lines.push('No look at the project was possible; only the words of the request are known.');
  }
  lines.push('', 'The request as written:', prompt.trim().slice(0, PROMPT_CHARS) || '(empty)');
  return lines.join('\n');
}

/**
 * Posts the four questions about `text` and returns the raw answers
 * (`{ question: answer }`). Throws on any failure; the caller falls back.
 */
export async function askDecisions(
  text: string,
  options: { url: string; key: string; timeoutMs: number; fetchImpl?: FetchLike },
): Promise<unknown> {
  if (!options.key) {
    throw new Error('no key for Gemini Decisions');
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(options.url, {
      method: 'POST',
      headers: { 'x-goog-api-key': options.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, input: text, questions: AUTO_ROUTE_QUESTIONS }),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    throw new Error(name === 'TimeoutError' || name === 'AbortError'
      ? `Gemini Decisions: no answer in ${options.timeoutMs} ms`
      : `Gemini Decisions: ${(error instanceof Error ? error.message : String(error)).slice(0, 160)}`);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Gemini Decisions: HTTP ${response.status} ${body.slice(0, 160)}`.trim());
  }
  const data = await response.json() as { answers?: unknown };
  return data?.answers ?? {};
}
