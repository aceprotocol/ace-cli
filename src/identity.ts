/**
 * Identity lifecycle: `ace init` (generate or import), `ace key show | next-root | rotate | delegate | recover`.
 * Keys are software keys sealed in the local keystore (see storage/keychain.ts).
 */
import {
  ACEError, FileStore, fromBase64, generateSoftwareKey, isACEId, isHex64, keyDigest, MAX_PUBLISHED_AGENT_BYTES, RECEIVE_LOCK,
  SoftwareIdentity, SoftwareKey, toBase64, verifyKel, type KelEvent,
} from '@ace-protocol/sdk';
import { constants } from 'node:fs';
import { open, rm, unlink, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { aceDirOf, busyAs, openLocal, relayClient, withAgent, type CommonOptions } from './context.js';
import { readBoundedJson } from './storage/bounded-json.js';
import { loadBaseConfig, loadSettings, resolveRelayUrl, saveBaseConfig, saveSettings } from './storage/config.js';
import {
  createKeyRing, destroyKeys, identityExists, loadIdentity, loadKeyRing, newKeystoreId, resolveProcessKeystoreMode, saveIdentity,
} from './storage/keychain.js';
import type { KeystoreMode } from './storage/keystore-mode.js';
import { confirmKeyDestruction, requireTTY, type Replacement } from './storage/tty-confirm.js';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const nowSec = () => Math.floor(Date.now() / 1000);

/** Root keys are ML-DSA-65 (the only scheme); next-root files name it. */
const SCHEME = 'ml-dsa-65';
/** The verified state of `id`'s key event log. */
const stateOf = (id: SoftwareIdentity) => verifyKel(id.getKel(), nowSec());

/** `--next-root`: the 64-hex digest of an externally held next root. */
function nextRootDigest(v: string | undefined): Uint8Array | undefined {
  if (v === undefined) return undefined;
  if (!isHex64(v)) throw new Error('--next-root must be the 64-hex digest printed by "ace key next-root"');
  return Buffer.from(v, 'hex');
}

/** Take `name` at once or fail with `busy` (`lock_busy`). */
const exclusive = (store: FileStore, name: string, busy: string) => store.lock(name, { timeoutMs: 0 }).catch(busyAs(busy));

/** One `ace init` / `ace key` command at a time per directory. */
const lockInit = (aceDir: string) => exclusive(new FileStore(aceDir), 'init', 'another "ace init" or "ace key" command is running');

export interface InstallOptions extends CommonOptions {
  force?: boolean;
  keystore?: KeystoreMode;
  /** Tests: the confirmation prompt and TTY check. */
  confirm?: (aceId: string | null, reason?: string, replacement?: Replacement) => Promise<void>;
  isTTY?: boolean;
}

/**
 * Install `identity` as this directory's identity: refuses an existing one unless `force` (interactive confirmation),
 * then destroys the previous keys and SDK state, creates a new master key in a new keystore entry and seals the identity.
 */
async function installIdentity(o: InstallOptions, identity: SoftwareIdentity, replacement?: Replacement): Promise<void> {
  const aceDir = aceDirOf(o);
  const mode = resolveProcessKeystoreMode(o.keystore);
  const releaseInit = await lockInit(aceDir);
  let releaseReceive: (() => Promise<void>) | undefined;
  try {
    const state = new FileStore(join(aceDir, 'state'));
    releaseReceive = await exclusive(state, RECEIVE_LOCK, '"ace listen" or "ace mcp" is running on this identity; stop it first');
    const base = await loadBaseConfig(aceDir).catch(() => null);
    if (await identityExists(aceDir)) {
      if (!o.force) throw new Error('an identity already exists; --force replaces it (interactive terminal only)');
      requireTTY(o.isTTY);
      let current: string | null = null, reason: string | undefined;
      try {
        if (!base) throw new Error(`${join(aceDir, 'config.json')} is missing or invalid`);
        current = (await loadIdentity(aceDir, await loadKeyRing(aceDir, base, o.osKeyStore))).getACEId();
      } catch (e) { reason = (e as Error).message; }
      await (o.confirm ?? confirmKeyDestruction)(current, reason, replacement);
      await destroyKeys(aceDir, base, o.osKeyStore);
    }
    // SDK state (sealed under the previous key) and settings that named the previous identity go.
    for (const key of await state.list('')) await state.delete(key);
    await rm(join(aceDir, 'network.json'), { force: true });
    const keystore = { keystore: mode, keystoreId: newKeystoreId() };
    const ring = await createKeyRing(aceDir, keystore, o.osKeyStore);
    await saveIdentity(aceDir, ring, identity);
    await saveBaseConfig(aceDir, { relay: resolveRelayUrl(o, base), ...keystore });
    if (mode === 'file') console.error(`WARNING: no OS keystore in use; the master key is ${join(aceDir, 'master.key')} (0600). Anyone who can read it can use this identity.`);
  } finally {
    await releaseReceive?.();
    await releaseInit();
  }
}

export interface InitOptions extends InstallOptions {
  /** Commit an externally held next root (digest printed by `ace key next-root`). */
  nextRoot?: string;
  /** A SoftwareIdentityExport to import; it is re-keyed away from its previous custodian and published. */
  importFile?: string;
}

export async function runInit(o: InitOptions = {}) {
  const nextRoot = nextRootDigest(o.nextRoot);
  let identity: SoftwareIdentity;
  if (o.importFile !== undefined) {
    if (o.nextRoot !== undefined) throw new Error('--import carries its own key event log; do not pass --next-root');
    identity = await importIdentity(o.importFile);
  } else {
    identity = await SoftwareIdentity.generate(nextRoot ? { nextRootDigest: nextRoot } : {});
  }
  await installIdentity(o, identity, o.importFile !== undefined ? { importing: identity.getACEId() } : undefined);
  const result = { aceId: identity.getACEId(), nextRoot: nextRootHeld(identity), imported: o.importFile !== undefined };
  // An import is re-keyed: the previous custodian's keys stay current at the relay until the new log is registered.
  if (o.importFile !== undefined) {
    await restoreCardRecord(o, result.aceId);
    return { ...result, published: await tryPublish(o) };
  }
  return result;
}

/**
 * A recovered or imported identity's network.json (removed with the replaced identity) starts from its card record at
 * the relay. Publishing the defaults instead would reset the record, and a relay refuses a record without the
 * identity's set-once handle, before the descriptor carrying the new log is posted.
 */
async function restoreCardRecord(o: CommonOptions, aceId: string): Promise<void> {
  const aceDir = aceDirOf(o);
  const relay = resolveRelayUrl(o, await loadBaseConfig(aceDir));
  let r;
  try { r = (await relayClient(o, relay).card(aceId)).card; } catch (err) {
    if (err instanceof ACEError && err.code === 'unknown_peer') return; // never published there
    console.error(`WARNING: cannot read the card record of ${aceId} (${(err as Error).message}); restore it with "ace network configure" (an existing handle exactly) before publishing.`);
    return;
  }
  const s = await loadSettings(aceDir);
  // The handle is bound in its home's namespace only: carried over (and fixed) when that home is this relay.
  const handle = r.handle !== undefined && r.home === relay ? { handle: r.handle, handleHome: relay } : {};
  await saveSettings(aceDir, { ...s, ...handle, card: r.card, contact: r.contact, listed: r.listed, ...(r.pay ? { pay: r.pay } : {}) });
}

async function tryPublish(o: CommonOptions): Promise<boolean> {
  try {
    await withAgent(o, 'receive', (a) => a.client.publish());
    return true;
  } catch (err) {
    console.error(`WARNING: not published (${(err as Error).message}); run "ace network publish" so the relay stops accepting the replaced keys.`);
    return false;
  }
}

/** Re-key an export (`SoftwareIdentityExport`): reveal its next root twice and delegate a fresh signing key. */
async function importIdentity(file: string): Promise<SoftwareIdentity> {
  const data = await readBoundedJson('--import', file, MAX_PUBLISHED_AGENT_BYTES * 2);
  if (typeof data !== 'object' || data === null || !Object.hasOwn(data, 'nextRootSeed')) {
    throw new Error('--import: the export does not hold its next root, so the previous custodian\'s keys cannot be revoked; refusing');
  }
  const now = nowSec();
  const id = SoftwareIdentity.fromExport(data, now);
  await id.rotate({ now });
  await id.rotate({ now });
  await id.delegate({ now });
  return id;
}

const nextRootHeld = (id: SoftwareIdentity) => id.exportPrivateKey().nextRootSeed !== undefined ? 'local' : 'external';

// --- ace key ---

export async function runKeyShow(o: CommonOptions = {}) {
  const { identity: id, base } = await openLocal(o);
  const s = stateOf(id);
  return {
    aceId: s.aceId, seq: s.seq, lastHash: s.lastHash,
    root: { scheme: s.rootScheme, digest: hex(keyDigest(s.rootScheme, s.rootPublicKey)) },
    next: { digest: s.next, held: nextRootHeld(id) },
    signing: { seq: s.signing!.seq, scheme: s.signing!.scheme, notAfter: s.signing!.notAfter },
    events: s.events.map((e: KelEvent) => ({ seq: e.seq, t: e.t, ts: e.ts })),
    keystore: base.keystore,
  };
}

/** Write a fresh root key to `out` (0600, never overwriting) and return the digest to commit. */
export async function runKeyNextRoot(o: { out: string }) {
  const key = generateSoftwareKey();
  const digest = hex(keyDigest(SCHEME, key.publicKey()));
  let fh: FileHandle;
  try {
    fh = await open(o.out, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  } catch (err) {
    throw new Error(`--out: cannot create ${o.out} (${(err as NodeJS.ErrnoException).code ?? 'error'}); it is never overwritten`);
  }
  try {
    await fh.writeFile(`${JSON.stringify({ ace: 'next-root', scheme: SCHEME, seed: toBase64(key.seed), digest }, null, 2)}\n`);
    await fh.sync();
  } catch (err) {
    await unlink(o.out).catch(() => undefined);
    throw err;
  } finally {
    await fh.close();
  }
  console.error(`Keep ${o.out} offline: it holds a root key. Commit it with "ace init --next-root ${digest}" or "ace key rotate --next-root ${digest}".`);
  return { digest, scheme: SCHEME, file: o.out };
}

/** The key of a next-root file: a regular 0600 file owned by this user, `{ace:"next-root", scheme, seed, digest}`. */
export async function readNextRootFile(file: string): Promise<SoftwareKey> {
  const fh = await open(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0)).catch((err: NodeJS.ErrnoException) => {
    throw new Error(`--root-file: cannot read ${file} (${err.code ?? 'error'})`);
  });
  let text: string;
  try {
    const s = await fh.stat();
    if (!s.isFile() || s.size > 4096) throw new Error(`--root-file: ${file} is not a next-root file`);
    if (process.platform !== 'win32' && ((s.mode & 0o077) !== 0 || (process.getuid && s.uid !== process.getuid()))) {
      throw new Error(`--root-file: ${file} must be mode 0600 and owned by the current user`);
    }
    text = await fh.readFile('utf8');
  } finally {
    await fh.close();
  }
  let d: Record<string, unknown>;
  try { d = JSON.parse(text) as Record<string, unknown>; } catch { throw new Error(`--root-file: ${file} is not valid JSON`); }
  if (d?.ace !== 'next-root' || Object.keys(d).length !== 4 || typeof d.seed !== 'string' || typeof d.digest !== 'string') {
    throw new Error(`--root-file: ${file} is not a next-root file (written by "ace key next-root")`);
  }
  if (d.scheme !== SCHEME) throw new Error(`--root-file: ${file}: scheme must be ${SCHEME}`);
  let seed: Uint8Array | null;
  try { seed = fromBase64(d.seed); } catch { seed = null; }
  if (seed?.length !== 32) throw new Error(`--root-file: ${file}: seed must be the Base64 of 32 bytes`);
  const key = new SoftwareKey(seed);
  if (hex(keyDigest(SCHEME, key.publicKey())) !== d.digest) throw new Error(`--root-file: ${file}: the seed does not match its digest`);
  return key;
}

/** Change the keys in place (exclusive: no receiver may run), seal them, then register and publish the new log. */
async function changeKeys(o: CommonOptions, mutate: (id: SoftwareIdentity, now: number) => Promise<void>) {
  const releaseInit = await lockInit(aceDirOf(o));
  try {
    return await withAgent(o, 'receive', async (a) => {
      await mutate(a.identity, nowSec());
      await saveIdentity(a.aceDir, a.ring, a.identity);
      let published = true;
      try { await a.client.publish(); } catch (err) {
        published = false;
        console.error(`WARNING: keys saved but not published (${(err as Error).message}); run "ace network publish".`);
      }
      const s = stateOf(a.identity);
      return { aceId: s.aceId, seq: s.seq, signingSeq: s.signing!.seq, published };
    });
  } finally {
    await releaseInit();
  }
}

export async function runKeyRotate(o: CommonOptions & { nextRoot?: string; rootFile?: string }) {
  const nextRoot = nextRootDigest(o.nextRoot);
  const revealed = o.rootFile !== undefined ? await readNextRootFile(o.rootFile) : undefined;
  return changeKeys(o, (id, now) => id.rotate({
    now, ...(revealed ? { nextRoot: revealed } : {}),
    ...(nextRoot ? { nextRootDigest: nextRoot } : {}),
  }));
}

export async function runKeyDelegate(o: CommonOptions & { notAfter?: number }) {
  return changeKeys(o, (id, now) => id.delegate({ now, ...(o.notAfter !== undefined ? { notAfter: o.notAfter } : {}) }));
}

/**
 * After device loss: extend the identity's log with the externally held next root (revoking every earlier
 * delegation), install it here and publish. The log comes from `--descriptor-file` (any saved PublishedAgent) or the
 * relay: the identity's descriptor while live, else its card record.
 */
export async function runKeyRecover(o: InstallOptions & { aceId: string; rootFile: string; descriptorFile?: string }) {
  if (!isACEId(o.aceId)) throw new Error('recover takes the ACE ID to recover');
  const nextRoot = await readNextRootFile(o.rootFile);
  let kel: unknown;
  if (o.descriptorFile !== undefined) {
    kel = (await readBoundedJson('--descriptor-file', o.descriptorFile, MAX_PUBLISHED_AGENT_BYTES) as { kel?: unknown })?.kel;
  } else {
    const relay = relayClient(o, resolveRelayUrl(o, await loadBaseConfig(aceDirOf(o)).catch(() => null)));
    try { kel = (await relay.getDescriptor(o.aceId)).kel; } catch (err) {
      // A card record does not expire, so it still carries the log after the descriptor lapsed.
      try { kel = (await relay.card(o.aceId)).kel; } catch {
        throw new Error(`cannot read the descriptor or card record of ${o.aceId} (${(err as Error).message}); pass --descriptor-file`, { cause: err });
      }
    }
  }
  let identity: SoftwareIdentity;
  try {
    identity = await SoftwareIdentity.recover(kel, nextRoot, { now: nowSec() });
  } catch (err) {
    throw new Error(`recover: ${(err as Error).message}; nothing changed`, { cause: err });
  }
  if (identity.getACEId() !== o.aceId) throw new ACEError('invalid_argument', 'the key event log names another identity');
  await installIdentity(o, identity, { recovering: o.aceId });
  await restoreCardRecord(o, o.aceId);
  return { aceId: o.aceId, seq: stateOf(identity).seq, published: await tryPublish(o) };
}

