import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildExplorerPrompt,
  explore,
  findLakeBridge,
  parseBrief,
  pickKeywords,
  readRecallFacts,
  scanProject,
  type ExplorerDependencies,
} from '../auto-route.explorer.js';

test('parseBrief reads the fields, markdown or not', () => {
  const brief = parseBrief([
    '**Request:** make auto-archive work for Codex.',
    '**Kind:** small-change',
    'Files: `server/a.ts`, server/b.ts; docs/fork/CHANGES.md',
    'Context: the matcher exists.',
    'Unknowns: none',
  ].join('\n'));
  assert.equal(brief.request, 'make auto-archive work for Codex.');
  assert.equal(brief.kind, 'small-change');
  assert.deepEqual(brief.files, ['server/a.ts', 'server/b.ts', 'docs/fork/CHANGES.md']);
  assert.equal(brief.unknowns, null);
  assert.deepEqual(parseBrief('Kind: large change\nFiles: none').files, []);
  assert.equal(parseBrief('Kind: large change').kind, 'large-change');
});

test('pickKeywords prefers identifiers and drops filler words', () => {
  const words = pickKeywords('quiero que mira el ComposerModelMenu y server/index.ts para que funcione');
  assert.deepEqual(words.slice(0, 2), ['ComposerModelMenu', 'server/index.ts']);
  assert.ok(!words.includes('quiero'));
});

test('readRecallFacts takes the facts of a recall result', () => {
  const result = { content: [{ type: 'text', text: JSON.stringify({ facts: [{ fact: 'Studio runs Codex.', valid_at: '2026-10-27T00:00:00Z' }, { fact: '' }] }) }] };
  assert.deepEqual(readRecallFacts(result), ['(2026-10-27) Studio runs Codex.']);
  assert.deepEqual(readRecallFacts({ content: [{ type: 'text', text: 'not json' }] }), []);
});

test('buildExplorerPrompt carries the scan, the lake and the request', () => {
  const prompt = buildExplorerPrompt({ prompt: 'fix it', cwd: '/w', scan: 'Folder: /w', lakeFacts: ['fact one'], canUseTools: true });
  assert.match(prompt, /Folder: \/w/);
  assert.match(prompt, /- fact one/);
  assert.match(prompt, /<request>\nfix it\n<\/request>/);
  assert.match(prompt, /Glob, Grep and Read/);
});

test('scanProject lists a plain folder', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'auto-scan-'));
  try {
    await writeFile(path.join(dir, 'notes.md'), 'x');
    await mkdir(path.join(dir, 'src'));
    const scan = await scanProject(dir, 'anything');
    assert.match(scan, /Not a git repository\. Contents: .*notes\.md/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('findLakeBridge reads the installed Hemilake plugin and honours a disabled one', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'auto-home-'));
  try {
    const pluginRoot = path.join(home, 'plugin');
    await mkdir(path.join(home, '.claude', 'plugins'), { recursive: true });
    await mkdir(pluginRoot);
    await writeFile(path.join(pluginRoot, '.mcp.json'), JSON.stringify({ hemilake: { command: 'python3', args: ['${CLAUDE_PLUGIN_ROOT}/hooks/mcp_stdio.py'] } }));
    await writeFile(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({
      plugins: { 'hemilake@hemilake': [{ scope: 'user', installPath: pluginRoot }] },
    }));
    const bridge = await findLakeBridge(home);
    assert.equal(bridge?.command, 'python3');
    assert.deepEqual(bridge?.args, [`${pluginRoot}/hooks/mcp_stdio.py`]);
    await writeFile(path.join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'hemilake@hemilake': false } }));
    assert.equal(await findLakeBridge(home), null);
    assert.equal(await findLakeBridge(path.join(home, 'nobody')), null);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

const fakes = (overrides: Partial<ExplorerDependencies> = {}): ExplorerDependencies => ({
  scan: async () => 'Folder: /w',
  findLake: async () => ({ command: 'x', args: [], env: {} }),
  recall: async () => ['a fact'],
  claude: async () => ({ text: 'Request: do it\nKind: question\nFiles: none\nUnknowns: none', toolCalls: 2, model: 'claude-haiku-5-5', error: null }),
  codex: async () => ({ text: '', toolCalls: 0, model: 'gpt-5.6-luna', error: 'codex failed' }),
  ...overrides,
});

const input = { prompt: 'do it', cwd: '/w', timeoutMs: 20_000, tokenCap: 1000, lakeTimeoutMs: 1000, codexBinary: 'codex' } as const;

test('explore returns a parsed brief from the engine it was given', async () => {
  const brief = await explore({ ...input, engine: 'claude' }, fakes());
  assert.equal(brief.kind, 'question');
  assert.equal(brief.lakeUsed, true);
  assert.equal(brief.toolCalls, 2);
  assert.equal(brief.error, null);
  const viaCodex = await explore({ ...input, engine: 'codex' }, fakes());
  assert.equal(viaCodex.engine, 'codex');
  assert.equal(viaCodex.error, 'codex failed');
});

test('explore never throws', async () => {
  const brief = await explore({ ...input, engine: 'claude' }, fakes({ scan: async () => { throw new Error('boom'); } }));
  assert.equal(brief.error, 'boom');
  assert.equal(brief.text, '');
});
