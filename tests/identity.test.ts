import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SoftwareIdentity } from '@ace-protocol/sdk';
import { buildProgram } from '../src/index.js';
import { KeyRing, _resetEnvSecretForTests, createKeyRing } from '../src/storage/keychain.js';
import { FakeRelay, RELAY } from '@ace-protocol/sdk/testing';
import { makeHome, memoryKeyStore } from './helpers/cli.js';

const ROOT = join(import.meta.dirname, '.identity');
afterAll(() => rm(ROOT, { recursive: true, force: true }));
beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { delete process.env.ACE_IDENTITY_KEY; _resetEnvSecretForTests(); });

describe('keystore', () => {
  it('file mode: 0600 master key, identity sealed (no seed in clear), refuses a second init without --force', async () => {
    const relay = new FakeRelay();
    const h = await makeHome(ROOT, 'file-mode', relay);
    expect((await stat(join(h.dir, 'master.key'))).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(join(h.dir, 'config.json'), 'utf8'))).toEqual({ relay: RELAY, keystore: 'file', keystoreId: expect.stringMatching(/^[0-9a-f]{32}$/) });
    const sealed = await readFile(join(h.dir, 'identity.enc'));
    expect(sealed[0]).toBe(1);
    expect(sealed.toString('latin1')).not.toContain('rootSeed');
    const shown = await h.run('key', 'show');
    expect(shown).toMatchObject({ aceId: h.aceId, seq: 1, keystore: 'file', next: { held: 'local' }, signing: { scheme: 'ml-dsa-65' } });
    await expect(h.run('init', '--keystore', 'file')).rejects.toThrow(/already exists/);

    // --force replaces it after confirmation (the TTY check is the host's)
    const confirm = vi.fn(async () => {});
    h.env.confirm = confirm;
    const replaced = await h.run('init', '--keystore', 'file', '--force');
    expect(confirm).toHaveBeenCalledWith(h.aceId, undefined, undefined);
    expect(replaced.aceId).not.toBe(h.aceId);
    h.env.isTTY = false;
    await expect(h.run('init', '--keystore', 'file', '--force')).rejects.toThrow(/interactive terminal/);
  });

  it('env mode: the master key comes from ACE_IDENTITY_KEY only; a wrong key cannot open the identity', async () => {
    const dir = join(ROOT, 'env-mode');
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true, mode: 0o700 });
    process.env.ACE_IDENTITY_KEY = Buffer.alloc(32, 7).toString('base64');
    let last: any;
    const run = (...a: string[]) => buildProgram({ aceDir: dir, out: (v) => { last = v; } }).parseAsync(['node', 'ace', ...a]).then(() => last);
    const { aceId } = await run('--relay', RELAY, 'init', '--keystore', 'env');
    expect(process.env.ACE_IDENTITY_KEY).toBeUndefined(); // moved out of the environment
    await expect(stat(join(dir, 'master.key'))).rejects.toThrow();
    expect((await run('key', 'show')).aceId).toBe(aceId);
    _resetEnvSecretForTests();
    process.env.ACE_IDENTITY_KEY = Buffer.alloc(32, 8).toString('base64');
    await expect(run('key', 'show')).rejects.toThrow(/decryption failed/);
    _resetEnvSecretForTests();
    process.env.ACE_IDENTITY_KEY = 'not-base64-32-bytes';
    await expect(run('key', 'show')).rejects.toThrow(/Base64 of 32 bytes/);
  });

  it('os mode: every identity directory has its own keystore entry; init and --force never touch another identity\'s', async () => {
    const os = memoryKeyStore();
    const home = async (name: string) => {
      const dir = join(ROOT, name);
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true, mode: 0o700 });
      let last: any;
      const env = { aceDir: dir, osKeyStore: os, isTTY: true, confirm: async () => {}, out: (v: unknown) => { last = v; } };
      const run = (...a: string[]) => buildProgram(env).parseAsync(['node', 'ace', ...a]).then(() => last);
      return { dir, run, aceId: (await run('--relay', RELAY, 'init', '--keystore', 'os')).aceId as string };
    };
    const a = await home('os-a');
    const b = await home('os-b'); // a second ACE_HOME on the same machine
    expect(os.entries.size).toBe(2);
    expect((await a.run('key', 'show')).aceId).toBe(a.aceId);
    expect((await b.run('key', 'show')).aceId).toBe(b.aceId);
    const { keystoreId } = JSON.parse(await readFile(join(a.dir, 'config.json'), 'utf8'));
    expect(keystoreId).toMatch(/^[0-9a-f]{32}$/);
    expect([...os.entries.keys()]).toContain(`ace-cli/master-key-${keystoreId}`);

    // --force replaces b's entry only
    const replaced = await b.run('init', '--keystore', 'os', '--force');
    expect(os.entries.size).toBe(2);
    expect((await a.run('key', 'show')).aceId).toBe(a.aceId);
    expect((await b.run('key', 'show')).aceId).toBe(replaced.aceId);
  });

  it('init never overwrites an existing master key', async () => {
    const os = memoryKeyStore();
    const dir = join(ROOT, 'no-overwrite');
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await os.save('ace-cli', `master-key-${'a'.repeat(32)}`, 'c2VjcmV0');
    await expect(createKeyRing(dir, { keystore: 'os', keystoreId: 'a'.repeat(32) }, os)).rejects.toThrow(/already holds a master key/);
    expect(await os.load('ace-cli', `master-key-${'a'.repeat(32)}`)).toBe('c2VjcmV0');
    // file mode: a stray master.key is never replaced either
    await writeFile(join(dir, 'master.key'), 'c2VjcmV0\n', { mode: 0o600 });
    const run = (...a: string[]) => buildProgram({ aceDir: dir, out: () => {} }).parseAsync(['node', 'ace', ...a]);
    await expect(run('--relay', RELAY, 'init', '--keystore', 'file')).rejects.toThrow(/already holds a master key/);
    expect(await readFile(join(dir, 'master.key'), 'utf8')).toBe('c2VjcmV0\n');
  });

  it('key ring: HKDF purpose keys are independent and bind the file name', () => {
    const ring = new KeyRing(Buffer.alloc(32, 1));
    const sealed = ring.seal('state', Buffer.from('hello'), 'messages/a.json');
    expect(Buffer.from(ring.open('state', sealed, 'messages/a.json')).toString()).toBe('hello');
    expect(() => ring.open('state', sealed, 'messages/b.json')).toThrow(/decryption failed/);
    expect(() => ring.open('prekeys', sealed, 'messages/a.json')).toThrow(/decryption failed/);
    expect(() => new KeyRing(Buffer.alloc(32, 2)).open('state', sealed, 'messages/a.json')).toThrow(/decryption failed/);
  });
});

describe('ace key', () => {
  it('next-root, rotate with an external root, delegate; each change is registered and published', async () => {
    const relay = new FakeRelay();
    const nextFile = join(ROOT, 'next-root.json');
    await rm(nextFile, { force: true });
    const h0 = await makeHome(ROOT, 'rotate-tmp', relay);
    const { digest } = await h0.run('key', 'next-root', '--out', nextFile);
    expect((await stat(nextFile)).mode & 0o777).toBe(0o600);
    await expect(h0.run('key', 'next-root', '--out', nextFile)).rejects.toThrow(/never overwritten/);

    const h = await makeHome(ROOT, 'rotate', relay, ['--next-root', digest]);
    expect((await h.run('key', 'show')).next).toEqual({ digest, held: 'external' });
    await h.run('network', 'publish');
    const rotated = await h.run('key', 'rotate', '--root-file', nextFile);
    expect(rotated).toMatchObject({ aceId: h.aceId, seq: 3, published: true });
    expect(relay.kels.get(h.aceId)!.seq).toBe(3);
    expect((await h.run('key', 'show')).next.held).toBe('local');
    const delegated = await h.run('key', 'delegate');
    expect(delegated).toMatchObject({ seq: 4, signingSeq: 4, published: true });
    expect(relay.descriptors.get(h.aceId)!.descriptor.signature.seq).toBe(4);
  });

  it('recover after device loss from the public descriptor and an external next root', async () => {
    const relay = new FakeRelay();
    const nextFile = join(ROOT, 'recover-root.json');
    await rm(nextFile, { force: true });
    const tmp = await makeHome(ROOT, 'recover-tmp', relay);
    const { digest } = await tmp.run('key', 'next-root', '--out', nextFile);
    const lost = await makeHome(ROOT, 'recover-lost', relay, ['--next-root', digest]);
    await lost.run('network', 'configure', '--contact', 'open', '--listed');
    const fresh = await makeHome(ROOT, 'recover-new', relay);
    const out = await fresh.run('key', 'recover', lost.aceId, '--root-file', nextFile, '--keystore', 'file', '--force');
    expect(out).toMatchObject({ aceId: lost.aceId, published: true });
    expect((await fresh.run('key', 'show')).aceId).toBe(lost.aceId);
    expect(relay.kels.get(lost.aceId)!.seq).toBe(2); // forked at the epoch start: icp, rot, dlg
  });

  it('recover reads the log from the card record once the descriptor is gone', async () => {
    const relay = new FakeRelay();
    const nextFile = join(ROOT, 'recover-card-root.json');
    await rm(nextFile, { force: true });
    const tmp = await makeHome(ROOT, 'recover-card-tmp', relay);
    const { digest } = await tmp.run('key', 'next-root', '--out', nextFile);
    const lost = await makeHome(ROOT, 'recover-card-lost', relay, ['--next-root', digest]);
    await lost.run('network', 'publish');
    relay.descriptors.delete(lost.aceId); // expired: the card record does not expire
    const fresh = await makeHome(ROOT, 'recover-card-new', relay);
    expect(await fresh.run('key', 'recover', lost.aceId, '--root-file', nextFile, '--keystore', 'file', '--force')).toMatchObject({ aceId: lost.aceId, published: true });
  });

  it('init --import re-keys an export away from its custodian and publishes it', async () => {
    const relay = new FakeRelay();
    const exported = await SoftwareIdentity.generate();
    const file = join(ROOT, 'export.json');
    await mkdir(ROOT, { recursive: true, mode: 0o700 });
    await writeFile(file, JSON.stringify(exported.exportPrivateKey()));
    const h = await makeHome(ROOT, 'import', relay, ['--import', file]);
    expect(h.aceId).toBe(exported.getACEId());
    expect(relay.kels.get(h.aceId)!.seq).toBe(6); // icp, dlg + rot, dlg, rot, dlg, dlg
    expect(relay.kels.get(h.aceId)!.signing!.publicKey).not.toEqual(exported.getSigningPublicKey());
  });
});
