import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { FileStore, RECEIVE_LOCK } from '@ace-protocol/sdk';

// The built CLI, compiled here (not into dist/) so the test runs the current sources.
const ROOT = join(import.meta.dirname, '.mcp-stdin');
const BUILD = join(ROOT, 'build');
const ACE = join(BUILD, 'bin', 'ace.js');
const TSC = createRequire(import.meta.url).resolve('typescript/bin/tsc');

beforeAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
  execFileSync(process.execPath, [TSC, '-p', join(import.meta.dirname, '..', 'tsconfig.json'), '--outDir', BUILD], { stdio: 'inherit' });
});
afterAll(() => rm(ROOT, { recursive: true, force: true }));

describe('ace mcp over stdio', () => {
  it('stops the receiver, releases the receive lock and exits when stdin closes', async () => {
    const aceDir = join(ROOT, 'ace');
    await mkdir(join(ROOT, 'home'), { recursive: true, mode: 0o700 });
    // Nothing listens on the discard port: the receiver keeps retrying until it is stopped.
    const env = {
      ...process.env, HOME: join(ROOT, 'home'), ACE_HOME: aceDir, ACE_KEYSTORE: 'file',
      ACE_RELAY: 'http://127.0.0.1:9', ACE_ALLOW_INSECURE_RELAY: '1',
    };
    execFileSync(process.execPath, [ACE, 'init'], { env, stdio: 'ignore' });

    const child = spawn(process.execPath, [ACE, 'mcp'], { env, stdio: ['pipe', 'ignore', 'pipe'] });
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    await new Promise<void>((resolve, reject) => {
      let err = '';
      child.stderr.on('data', (c: Buffer) => { err += c.toString(); if (err.includes('Listening as')) resolve(); });
      child.once('exit', () => reject(new Error(`ace mcp exited before listening: ${err}`)));
    });
    await expect(new FileStore(join(aceDir, 'state')).lock(RECEIVE_LOCK, { timeoutMs: 0 })).rejects.toThrow(/held/);

    child.stdin.end();
    const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 10_000).unref());
    const code = await Promise.race([exited, timeout]);
    if (code === 'timeout') child.kill('SIGKILL');
    expect(code).toBe(0);
    const release = await new FileStore(join(aceDir, 'state')).lock(RECEIVE_LOCK, { timeoutMs: 0 });
    await release();
  });
});
