import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { buildProgram, type CliEnv } from '../../src/index.js';
import { RELAY, type FakeRelay } from '@ace-protocol/sdk/testing';
import type { OSKeyStore } from '../../src/storage/os-keystore.js';

export interface Home {
  dir: string;
  env: CliEnv;
  aceId: string;
  /** Run `ace <args>` in this home; resolves to the command's JSON result, rejects with its error. */
  run(...args: string[]): Promise<any>;
}

export async function makeHome(root: string, name: string, relay: FakeRelay, init: string[] = []): Promise<Home> {
  const dir = join(root, name);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true, mode: 0o700 });
  let last: unknown;
  const env: CliEnv = {
    aceDir: dir, fetch: relay.fetch, out: (v) => { last = v; },
    isTTY: true, confirm: async () => {}, listen: { maintainMs: 200, retryMs: 50, log: () => {} },
  };
  const run = async (...args: string[]): Promise<any> => {
    last = undefined;
    await buildProgram(env).parseAsync(['node', 'ace', ...args]);
    return last;
  };
  const { aceId } = await run('--relay', RELAY, 'init', '--keystore', 'file', ...init);
  return { dir, env, aceId, run };
}

export async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** An in-memory OS keystore (`save` replaces, like the platform stores): tests never touch the real one. */
export function memoryKeyStore(): OSKeyStore & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  const key = (service: string, account: string) => `${service}/${account}`;
  return {
    entries,
    async save(service, account, secret) { entries.set(key(service, account), secret); },
    async load(service, account) { return entries.get(key(service, account)) ?? null; },
    async delete(service, account) { entries.delete(key(service, account)); },
  };
}
