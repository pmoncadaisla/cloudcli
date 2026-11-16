/**
 * Fork (Hemilake): where Auto decisions live, under Studio's data directory
 * (`~/.cloudcli/auto-route`, so each instance's HOME keeps its own):
 *
 *   decisions/<id>.json     every decision, from the moment it is taken
 *   sessions/<id>.json      the decision a session runs on (the last one, after
 *                           a re-evaluation) and what happened to it since
 *   decisions.jsonl         one line per event (decided, applied, overridden,
 *                           completed, failed) with the prompt's hash, never the
 *                           prompt, so the choice can be measured later
 */

import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AutoRouteDecision } from '@/shared/types.js';

/** What the store keeps per session besides the decision itself. */
export type AutoRouteSessionRecord = {
  decision: AutoRouteDecision;
  /** Ids of earlier decisions of this session, oldest first. */
  previous: string[];
  /** The model the session was switched to by hand after the decision, if any. */
  overriddenTo: string | null;
};

const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temp, file);
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/**
 * File-backed store of Auto decisions. Exported for the service's composition
 * root and the module's tests, which point it at a scratch directory.
 */
export function createAutoRouteStore(root = process.env.CLOUDCLI_AUTO_ROUTE_DIR
  || path.join(os.homedir(), '.cloudcli', 'auto-route')) {
  const decisionFile = (id: string) => path.join(root, 'decisions', `${id}.json`);
  const sessionFile = (id: string) => path.join(root, 'sessions', `${id}.json`);

  return {
    root,

    async log(event: string, fields: Record<string, unknown>): Promise<void> {
      try {
        await mkdir(root, { recursive: true });
        const row = { at: new Date().toISOString(), event, ...fields };
        await appendFile(path.join(root, 'decisions.jsonl'), `${JSON.stringify(row)}\n`, 'utf8');
      } catch (error) {
        console.warn('[auto-route] could not write the decision log:', error);
      }
    },

    async saveDecision(decision: AutoRouteDecision): Promise<void> {
      await writeJsonAtomic(decisionFile(decision.id), decision);
    },

    async getDecision(id: string): Promise<AutoRouteDecision | null> {
      return SAFE_ID.test(id) ? readJson<AutoRouteDecision>(decisionFile(id)) : null;
    },

    async getSession(sessionId: string): Promise<AutoRouteSessionRecord | null> {
      return SAFE_ID.test(sessionId) ? readJson<AutoRouteSessionRecord>(sessionFile(sessionId)) : null;
    },

    async saveSession(sessionId: string, record: AutoRouteSessionRecord): Promise<void> {
      if (SAFE_ID.test(sessionId)) {
        await writeJsonAtomic(sessionFile(sessionId), record);
      }
    },
  };
}

export type AutoRouteStore = ReturnType<typeof createAutoRouteStore>;
