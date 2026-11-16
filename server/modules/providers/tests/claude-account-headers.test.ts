import assert from 'node:assert/strict';
import test from 'node:test';

import { buildClaudeAccountHeaders } from '@/modules/providers/list/claude/claude-runtime.provider.js';

// Fork (Auto model choice): the account an Auto decision prefers rides to
// claude-oauth-proxy in ANTHROPIC_CUSTOM_HEADERS.
test('buildClaudeAccountHeaders adds the account to existing headers and rejects odd labels', () => {
  assert.equal(buildClaudeAccountHeaders('acct-1', undefined), 'x-claude-account: acct-1\nx-claude-account-mode: prefer');
  assert.equal(buildClaudeAccountHeaders('acct-1', 'x-a: b'), 'x-a: b\nx-claude-account: acct-1\nx-claude-account-mode: prefer');
  assert.equal(buildClaudeAccountHeaders('bad\nx-evil: 1', undefined), null);
  assert.equal(buildClaudeAccountHeaders(undefined, 'x-a: b'), null);
});
