/**
 * Fork (Hemilake): phase 1 of the Auto model choice. Before anything is
 * decided, a fast and cheap read-only pass turns the request, which is often
 * vague, into a short task brief: what is wanted, the kind of work, the files
 * and areas likely involved, what the lake knows, and what is still open.
 *
 *   scan       `git ls-files` and `git grep` in the session's folder for the
 *              request's words: a map of the project in a second.
 *   lake       `recall` on the Hemilake MCP, when the instance has the
 *              Hemilake plugin installed and enabled (the same bridge Claude
 *              Code sessions use).
 *   explorer   Claude Haiku at low effort through the Agent SDK with Glob, Grep
 *              and Read only, no session file, no MCP, no hooks; or, when every
 *              Claude account is used up, GPT-5.6 Luna through `codex exec` in
 *              its read-only sandbox.
 *
 * The whole pass has a time budget and a token cap; whatever it cannot finish
 * comes back as `error`, and the router then decides on the raw request.
 */

import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { query } from '@anthropic-ai/claude-agent-sdk';

import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';
import type { AutoRouteBrief, AutoRouteEngine } from '@/shared/types.js';

/** Read-only tools the Claude explorer may use; everything else is denied. */
const CLAUDE_EXPLORER_TOOLS = ['Glob', 'Grep', 'Read'];
const CLAUDE_EXPLORER_MODEL = 'haiku';
const CODEX_EXPLORER_MODEL = 'gpt-5.6-luna';
const MAX_TOOL_CALLS = 8;
const PROMPT_CHARS = 6000;
const BRIEF_KINDS = ['question', 'research', 'small-change', 'large-change', 'writing', 'ops'];
const STOPWORDS = new Set([
  'about', 'after', 'again', 'also', 'antes', 'aqui', 'bien', 'cada', 'como', 'cuando', 'desde', 'donde', 'esta',
  'este', 'esto', 'from', 'have', 'hacer', 'haz', 'into', 'just', 'like', 'make', 'mira', 'more', 'para', 'pero',
  'please', 'porque', 'puedes', 'que', 'quiero', 'should', 'sobre', 'some', 'that', 'the', 'then', 'there', 'this',
  'todo', 'todos', 'what', 'when', 'where', 'which', 'with', 'would', 'your',
]);

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 200);

function run(command: string, args: string[], options: { cwd: string; timeoutMs: number }): Promise<string> {
  return new Promise((resolve) => {
    execFile(command, args, { cwd: options.cwd, timeout: options.timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (_error, stdout) => resolve(typeof stdout === 'string' ? stdout : ''));
  });
}

/** Up to six words of the request worth grepping for: identifiers and paths first. Exported for tests. */
export function pickKeywords(prompt: string): string[] {
  const words = prompt.match(/[\p{L}\p{N}_./-]{4,}/gu) ?? [];
  const seen = new Set<string>();
  const scored: Array<{ word: string; score: number }> = [];
  for (const raw of words) {
    const word = raw.replace(/^[./-]+|[./-]+$/g, '');
    const key = word.toLowerCase();
    if (word.length < 4 || seen.has(key) || STOPWORDS.has(key) || /^https?:/.test(key)) {
      continue;
    }
    seen.add(key);
    const looksLikeCode = /[A-Z_./-]|\d/.test(word.slice(1)) ? 2 : 0;
    scored.push({ word, score: looksLikeCode + Math.min(word.length, 12) / 12 });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, 6).map((entry) => entry.word);
}

/**
 * A few lines about the folder: how many files git tracks, the top level, and
 * the files that mention the request's words. Plain listing when the folder
 * is not a git repository. Exported for tests.
 */
export async function scanProject(cwd: string, prompt: string, timeoutMs = 3_000): Promise<string> {
  const tracked = (await run('git', ['ls-files'], { cwd, timeoutMs })).split('\n').filter(Boolean);
  const lines = [`Folder: ${cwd}`];
  if (tracked.length > 0) {
    const top = new Map<string, number>();
    for (const file of tracked) {
      const head = file.includes('/') ? `${file.split('/')[0]}/` : file;
      top.set(head, (top.get(head) ?? 0) + 1);
    }
    const entries = [...top.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)
      .map(([name, count]) => (name.endsWith('/') ? `${name} (${count})` : name));
    lines.push(`Git repository, ${tracked.length} tracked files. Top level: ${entries.join(', ')}`);
    const keywords = pickKeywords(prompt);
    if (keywords.length > 0) {
      const args = ['grep', '-l', '-i', '-F', ...keywords.flatMap((word) => ['-e', word]), '--', '.'];
      const hits = (await run('git', args, { cwd, timeoutMs })).split('\n').filter(Boolean);
      if (hits.length > 0) {
        const shown = hits.slice(0, 20).join(', ');
        const more = hits.length > 20 ? ` and ${hits.length - 20} more` : '';
        lines.push(`Files mentioning ${keywords.map((word) => `"${word}"`).join(', ')}: ${shown}${more}`);
      } else {
        lines.push(`No tracked file mentions ${keywords.map((word) => `"${word}"`).join(', ')}.`);
      }
    }
  } else {
    try {
      const entries = (await readdir(cwd, { withFileTypes: true }))
        .filter((entry) => !entry.name.startsWith('.'))
        .slice(0, 40)
        .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
      lines.push(`Not a git repository. Contents: ${entries.join(', ') || 'empty'}`);
    } catch (error) {
      lines.push(`Could not list the folder: ${errorText(error)}`);
    }
  }
  return lines.join('\n');
}

type LakeBridge = { command: string; args: string[]; env: NodeJS.ProcessEnv };

/**
 * The stdio bridge of the Hemilake plugin when Claude Code has it installed
 * and enabled for this HOME (Pablo's instance does, Beatriz's does not).
 * Exported for tests.
 */
export async function findLakeBridge(home = os.homedir()): Promise<LakeBridge | null> {
  try {
    const installed = JSON.parse(await readFile(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), 'utf8'));
    const entries = (installed?.plugins?.['hemilake@hemilake'] ?? []) as Array<{ scope?: string; installPath?: string }>;
    const entry = entries.find((candidate) => candidate.scope === 'user' && candidate.installPath) ?? entries[0];
    if (!entry?.installPath) {
      return null;
    }
    try {
      const settings = JSON.parse(await readFile(path.join(home, '.claude', 'settings.json'), 'utf8'));
      if (settings?.enabledPlugins?.['hemilake@hemilake'] === false) {
        return null;
      }
    } catch {
      // No settings file: installed plugins are enabled.
    }
    const config = JSON.parse(await readFile(path.join(entry.installPath, '.mcp.json'), 'utf8'));
    const server = config?.hemilake ?? config?.mcpServers?.hemilake;
    if (typeof server?.command !== 'string') {
      return null;
    }
    const root = entry.installPath;
    const args = (Array.isArray(server.args) ? server.args : []).map((arg: unknown) => String(arg)
      .replaceAll('${CLAUDE_PLUGIN_ROOT}', root));
    return { command: server.command, args, env: { ...process.env, CLAUDE_PLUGIN_ROOT: root } };
  } catch {
    return null;
  }
}

/**
 * The facts `recall` returns for the request, one line each, at most eight.
 * Empty on any failure: the lake is a help, never a requirement.
 */
export async function recallLake(bridge: LakeBridge, question: string, timeoutMs: number): Promise<string[]> {
  return new Promise((resolve) => {
    let settled = false;
    let buffer = '';
    const child = spawn(bridge.command, bridge.args, { env: bridge.env, stdio: ['pipe', 'pipe', 'ignore'] });
    const finish = (facts: string[]) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(facts);
    };
    const timer = setTimeout(() => finish([]), timeoutMs);
    timer.unref?.();
    child.on('error', () => finish([]));
    child.on('exit', () => finish([]));
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        try {
          const message = JSON.parse(line);
          if (message?.id === 2) {
            finish(readRecallFacts(message?.result));
          }
        } catch {
          // Not a JSON-RPC line.
        }
      }
    });
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    send({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'studio-auto-route', version: '1' } },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'recall', arguments: { query: question.slice(0, 500) } },
    });
  });
}

/** The fact lines of a `recall` tool result (JSON text content with `facts[].fact`). Exported for tests. */
export function readRecallFacts(result: unknown): string[] {
  const content = (result as { content?: Array<{ type?: string; text?: string }> })?.content ?? [];
  const facts: string[] = [];
  for (const part of content) {
    if (typeof part?.text !== 'string') {
      continue;
    }
    try {
      const parsed = JSON.parse(part.text) as { facts?: Array<{ fact?: string; valid_at?: string | null }> };
      for (const fact of parsed.facts ?? []) {
        if (typeof fact?.fact === 'string' && fact.fact.trim()) {
          const date = typeof fact.valid_at === 'string' ? `(${fact.valid_at.slice(0, 10)}) ` : '';
          facts.push(`${date}${fact.fact.trim().slice(0, 300)}`);
        }
      }
    } catch {
      // Not JSON: nothing to take.
    }
  }
  return facts.slice(0, 8);
}

/** The explorer's instructions, with the scan and the lake facts. Exported for tests. */
export function buildExplorerPrompt(input: {
  prompt: string;
  cwd: string;
  scan: string;
  lakeFacts: string[];
  canUseTools: boolean;
}): string {
  const lake = input.lakeFacts.length > 0
    ? ['What the Hemilake lake (the user\'s mail, chats, meetings and notes) recalls for this request:',
      ...input.lakeFacts.map((fact) => `- ${fact}`)].join('\n')
    : 'The lake had nothing for this request, or is not connected.';
  const look = input.canUseTools
    ? `Look at the project in the current folder with Glob, Grep and Read, at most ${MAX_TOOL_CALLS} calls in all. `
      + 'You cannot change anything. If the request does not involve this folder (a general question, a message to '
      + 'write), do not search it.'
    : 'You may not be able to run commands here; work from the map of the folder below.';
  return [
    'You are the explorer of Hemilake Studio\'s Auto mode. Before a model is chosen for the request below, you take '
      + 'a fast, read-only look so the choice is made on what the work really is, and so the model that does it '
      + 'starts from your notes. Do not do the task itself.',
    '',
    look,
    '',
    'Then answer with this brief and nothing else, under 1,200 characters, in the language of the request:',
    '',
    'Request: what the user wants, in one or two sentences, made concrete.',
    `Kind: one of ${BRIEF_KINDS.join(', ')}.`,
    'Files: the files or areas likely involved, comma separated, or none.',
    'Context: what you found in the code or in the lake that matters.',
    'Unknowns: what is still open, or none.',
    '',
    input.scan,
    '',
    lake,
    '',
    '<request>',
    input.prompt.trim().slice(0, PROMPT_CHARS),
    '</request>',
  ].join('\n');
}

/** The fields of a brief written in the format the explorer is asked for. Exported for tests. */
export function parseBrief(text: string): Pick<AutoRouteBrief, 'kind' | 'request' | 'files' | 'unknowns'> {
  const field = (name: string): string | null => {
    const match = new RegExp(`^[\\s*_#>-]*${name}[*_]*\\s*:[*_]*\\s*(.+)$`, 'im').exec(text);
    const value = match?.[1]?.replace(/[*_`]+$/g, '').trim();
    return value || null;
  };
  const kindRaw = field('Kind')?.toLowerCase() ?? '';
  const kind = BRIEF_KINDS.find((candidate) => kindRaw.includes(candidate))
    ?? BRIEF_KINDS.find((candidate) => kindRaw.includes(candidate.replace('-', ' ')))
    ?? null;
  const filesRaw = field('Files');
  const files = filesRaw && !/^none\b|^ninguno|^-$/i.test(filesRaw)
    ? filesRaw.split(/[,;]\s*/).map((file) => file.replace(/[`*]/g, '').trim()).filter(Boolean).slice(0, 20)
    : [];
  const unknowns = field('Unknowns');
  return {
    kind,
    request: field('Request'),
    files,
    unknowns: unknowns && /^none\b|^ninguno/i.test(unknowns) ? null : unknowns,
  };
}

type ExploreResult = { text: string; toolCalls: number; model: string; error: string | null };

/**
 * Haiku at low effort through the Agent SDK: Glob, Grep and Read only, in
 * dontAsk mode with every other tool denied, no settings, MCP servers, hooks
 * or CLAUDE.md, and no session file (it must not show up as a chat). Stops at
 * the time budget or the token cap and keeps whatever text it had.
 */
async function exploreWithClaude(input: {
  explorerPrompt: string;
  cwd: string;
  timeoutMs: number;
  tokenCap: number;
}): Promise<ExploreResult> {
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), input.timeoutMs);
  timer.unref?.();
  let toolCalls = 0;
  let tokens = 0;
  let lastText = '';
  let model = CLAUDE_EXPLORER_MODEL;
  let error: string | null = null;
  let finalText = '';
  const executable = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH);
  try {
    const stream = query({
      prompt: input.explorerPrompt,
      options: {
        cwd: input.cwd,
        model: CLAUDE_EXPLORER_MODEL,
        effort: 'low',
        tools: CLAUDE_EXPLORER_TOOLS,
        allowedTools: CLAUDE_EXPLORER_TOOLS,
        permissionMode: 'dontAsk',
        canUseTool: async (toolName) => (CLAUDE_EXPLORER_TOOLS.includes(toolName)
          ? { behavior: 'allow' }
          : { behavior: 'deny', message: 'The explorer is read-only.' }),
        maxTurns: MAX_TOOL_CALLS + 2,
        persistSession: false,
        settingSources: [],
        strictMcpConfig: true,
        mcpServers: {},
        systemPrompt: 'You are a fast, careful, read-only explorer. You never change files.',
        env: { ...process.env },
        abortController,
        ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
      },
    });
    for await (const message of stream) {
      if (message.type === 'assistant') {
        model = message.message.model || model;
        const usage = message.message.usage as unknown as Record<string, number> | undefined;
        tokens += (usage?.input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0)
          + (usage?.cache_read_input_tokens ?? 0) + (usage?.output_tokens ?? 0);
        for (const part of message.message.content ?? []) {
          if (part.type === 'tool_use') {
            toolCalls += 1;
          } else if (part.type === 'text' && part.text.trim()) {
            lastText = part.text;
          }
        }
        if (tokens > input.tokenCap) {
          error = `token cap of ${input.tokenCap} reached`;
          abortController.abort();
          break;
        }
      } else if (message.type === 'result') {
        if (message.subtype === 'success') {
          finalText = message.result;
        } else {
          error = `explorer ended with ${message.subtype}`;
        }
      }
    }
  } catch (caught) {
    error = abortController.signal.aborted && !error
      ? `no brief within ${Math.round(input.timeoutMs / 1000)} s`
      : error ?? errorText(caught);
  } finally {
    clearTimeout(timer);
  }
  const text = (finalText || lastText).trim();
  return { text, toolCalls, model, error: text ? null : error ?? 'the explorer wrote nothing' };
}

/**
 * GPT-5.6 Luna at low effort through `codex exec` in its read-only sandbox,
 * ephemeral (no rollout file, so no chat) and without MCP servers. Used when
 * every Claude account is used up.
 */
async function exploreWithCodex(input: {
  explorerPrompt: string;
  cwd: string;
  timeoutMs: number;
  codexBinary: string;
}): Promise<ExploreResult> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'studio-auto-explore-'));
  const outFile = path.join(dir, 'brief.md');
  try {
    const args = [
      'exec', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only',
      '-m', CODEX_EXPLORER_MODEL, '-c', 'model_reasoning_effort="low"', '-c', 'mcp_servers={}',
      '-C', input.cwd, '-o', outFile, '-',
    ];
    const exitError = await new Promise<string | null>((resolve) => {
      const child = spawn(input.codexBinary, args, { cwd: input.cwd, env: process.env, stdio: ['pipe', 'ignore', 'pipe'] });
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve(`no brief within ${Math.round(input.timeoutMs / 1000)} s`);
      }, input.timeoutMs);
      timer.unref?.();
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-400);
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        resolve(errorText(error));
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve(code === 0 ? null : `codex exec exited ${code}: ${stderr.trim().split('\n').pop() ?? ''}`);
      });
      child.stdin.end(input.explorerPrompt);
    });
    const text = (await readFile(outFile, 'utf8').catch(() => '')).trim();
    return { text, toolCalls: 0, model: CODEX_EXPLORER_MODEL, error: text ? null : exitError ?? 'the explorer wrote nothing' };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export type ExplorerDependencies = {
  scan: typeof scanProject;
  findLake: typeof findLakeBridge;
  recall: typeof recallLake;
  claude: typeof exploreWithClaude;
  codex: typeof exploreWithCodex;
};

const DEFAULT_DEPENDENCIES: ExplorerDependencies = {
  scan: scanProject,
  findLake: findLakeBridge,
  recall: recallLake,
  claude: exploreWithClaude,
  codex: exploreWithCodex,
};

/**
 * Runs phase 1 and returns the brief. Never throws: a failed pass comes back
 * with `error` set. Consumed by the Auto service of this module.
 */
export async function explore(
  input: {
    prompt: string;
    cwd: string;
    engine: AutoRouteEngine;
    timeoutMs: number;
    tokenCap: number;
    lakeTimeoutMs: number;
    codexBinary: string;
  },
  dependencies: ExplorerDependencies = DEFAULT_DEPENDENCIES,
): Promise<AutoRouteBrief> {
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  try {
    const [scan, lakeFacts] = await Promise.all([
      dependencies.scan(input.cwd, input.prompt),
      dependencies.findLake().then((bridge) => (bridge
        ? dependencies.recall(bridge, input.prompt, input.lakeTimeoutMs)
        : [])),
    ]);
    const explorerPrompt = buildExplorerPrompt({
      prompt: input.prompt,
      cwd: input.cwd,
      scan,
      lakeFacts,
      canUseTools: input.engine === 'claude',
    });
    const remainingMs = Math.max(5_000, input.timeoutMs - elapsed());
    const result = input.engine === 'codex'
      ? await dependencies.codex({ explorerPrompt, cwd: input.cwd, timeoutMs: remainingMs, codexBinary: input.codexBinary })
      : await dependencies.claude({ explorerPrompt, cwd: input.cwd, timeoutMs: remainingMs, tokenCap: input.tokenCap });
    return {
      text: result.text,
      ...parseBrief(result.text),
      engine: input.engine,
      model: result.model,
      lakeUsed: lakeFacts.length > 0,
      toolCalls: result.toolCalls,
      latencyMs: elapsed(),
      error: result.error,
    };
  } catch (error) {
    return {
      text: '',
      kind: null,
      request: null,
      files: [],
      unknowns: null,
      engine: input.engine,
      model: input.engine === 'codex' ? CODEX_EXPLORER_MODEL : CLAUDE_EXPLORER_MODEL,
      lakeUsed: false,
      toolCalls: 0,
      latencyMs: elapsed(),
      error: errorText(error),
    };
  }
}
