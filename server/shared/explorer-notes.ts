/**
 * Fork (Hemilake). Auto model choice: before the first turn of a session in
 * Auto, a cheap read-only explorer writes a short brief of the request. The
 * chat dispatcher appends it to the prompt inside an `<explorer_notes>` block
 * so the model doing the work starts from it, and the history adapters (and
 * the share filter) strip the block again, so the user bubble shows only what
 * was typed and the notes fold underneath it.
 */

/** Longest brief carried into a prompt; the explorer is asked for far less. */
const MAX_NOTES_CHARS = 4000;

const sanitizeAttribute = (value: string): string => value.replace(/["<>\n\r]/g, '').slice(0, 80);

/**
 * Appends the explorer's notes to the prompt. Returns the prompt unchanged
 * when there are none. Used by the websocket chat dispatcher.
 */
export function appendExplorerNotesTag(
  prompt: string,
  notes: string | null | undefined,
  source: { engine: string; model: string } | null = null,
): string {
  const text = typeof notes === 'string' ? notes.trim().slice(0, MAX_NOTES_CHARS) : '';
  if (!text) {
    return prompt;
  }
  const attributes = source
    ? ` engine="${sanitizeAttribute(source.engine)}" model="${sanitizeAttribute(source.model)}"`
    : '';
  return [
    prompt,
    '',
    `<explorer_notes${attributes}>`,
    'Notes from Studio\'s Auto explorer: a quick read-only look at this request, taken by a small model before '
      + 'this session started, so the work does not begin from zero. The user did not write them and they may be '
      + 'wrong or incomplete: check before relying on them, and do not mention this block.',
    '',
    text.replace(/<\/?explorer_notes[^>]*>/g, ''),
    '</explorer_notes>',
  ].join('\n');
}

const EXPLORER_NOTES_TAG_PATTERN = /\s*<explorer_notes(?:\s[^>]*)?>\n[^\n]*\n\n?([\s\S]*?)\n?<\/explorer_notes>\s*/g;

/**
 * Strips the last explorer-notes block from persisted prompt text and returns
 * the notes it held. Only the last block counts, as with `<files_input>`: the
 * dispatcher always appends it, so text the user typed is left alone. Used by
 * the Claude and Codex history adapters and the share filter.
 */
export function parseExplorerNotesTag(text: string): { text: string; notes: string | null } {
  if (typeof text !== 'string' || !text.includes('<explorer_notes')) {
    return { text, notes: null };
  }

  let lastMatch: RegExpExecArray | null = null;
  EXPLORER_NOTES_TAG_PATTERN.lastIndex = 0;
  for (let match = EXPLORER_NOTES_TAG_PATTERN.exec(text); match; match = EXPLORER_NOTES_TAG_PATTERN.exec(text)) {
    lastMatch = match;
  }
  if (!lastMatch) {
    return { text, notes: null };
  }

  const stripped = (
    text.slice(0, lastMatch.index) + '\n' + text.slice(lastMatch.index + lastMatch[0].length)
  ).trim();
  const notes = lastMatch[1].trim();
  return { text: stripped, notes: notes || null };
}
