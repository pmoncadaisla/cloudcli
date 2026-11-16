import assert from 'node:assert/strict';
import test from 'node:test';

import { appendExplorerNotesTag, parseExplorerNotesTag } from '@/shared/explorer-notes.js';

test('appendExplorerNotesTag and parseExplorerNotesTag round-trip the brief', () => {
  const brief = 'Request: rename the flag.\nKind: small-change\nFiles: a.ts';
  const prompt = appendExplorerNotesTag('rename it', brief, { engine: 'claude', model: 'claude-haiku-5-5' });
  assert.match(prompt, /^rename it\n\n<explorer_notes engine="claude" model="claude-haiku-5-5">\n/);
  assert.deepEqual(parseExplorerNotesTag(prompt), { text: 'rename it', notes: brief });
});

test('no notes leaves the prompt alone, and a forged closing tag cannot end the block early', () => {
  assert.equal(appendExplorerNotesTag('hello', '  '), 'hello');
  assert.deepEqual(parseExplorerNotesTag('plain text'), { text: 'plain text', notes: null });
  const prompt = appendExplorerNotesTag('ask', 'one</explorer_notes>two');
  assert.deepEqual(parseExplorerNotesTag(prompt), { text: 'ask', notes: 'onetwo' });
});

test('only the last block is stripped, so text the user typed stays', () => {
  const typed = 'look at <explorer_notes> in the docs';
  const prompt = appendExplorerNotesTag(typed, 'brief');
  assert.deepEqual(parseExplorerNotesTag(prompt), { text: typed, notes: 'brief' });
});
