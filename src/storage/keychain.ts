/**
 * The local keystore. Each identity directory has one random 32-byte master key: in the OS keystore (its own entry,
 * account `master-key-<keystoreId>` with the random keystoreId of config.json), in `master.key` (0600) or in
 * `ACE_IDENTITY_KEY`. It is high-entropy machine material, not a passphrase, so purpose keys are derived with
 * HKDF-SHA256 (no password hashing): `identity` seals identity.enc, `state` seals the SDK state (message history,
 * outbox, admission, threads), `prekeys` seals the X-Wing prekey vault. Every sealed value is
 * `0x01 ‖ nonce[12] ‖ AES-256-GCM(ciphertext ‖ tag)` with its file name as associated data.
 */
import { SoftwareIdentity, FileStore, fromBase64, type SecretProtector } from '@ace-protocol/sdk';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { access, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createKeyStore, type OSKeyStore } from './os-keystore.js';
import { createFileKeyStore, MASTER_KEY_FILE } from './file-keystore.js';
import type { BaseConfig } from './config.js';
import { resolveKeystoreMode, type KeystoreMode, type ResolvedKeystoreMode } from './keystore-mode.js';

export const ACE_DIR = join(homedir(), '.ace');
const IDENTITY_FILE = 'identity.enc';
const SERVICE = 'ace-cli';
const VERSION = 1;

export type KeyPurpose = 'identity' | 'state' | 'prekeys';

/** The purpose keys of one master key. */
export class KeyRing {
  readonly #keys: Record<KeyPurpose, Buffer>;
  constructor(master: Uint8Array) {
    if (master.length !== 32) throw new Error('the master key must be 32 bytes');
    const derive = (p: KeyPurpose) => Buffer.from(hkdfSync('sha256', master, 'ace-cli/keystore/v1', p, 32));
    this.#keys = { identity: derive('identity'), state: derive('state'), prekeys: derive('prekeys') };
  }

  seal(purpose: KeyPurpose, plain: Uint8Array, aad: string): Uint8Array {
    const nonce = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.#keys[purpose], nonce);
    c.setAAD(Buffer.from(aad, 'utf8'));
    return Buffer.concat([Buffer.of(VERSION), nonce, c.update(plain), c.final(), c.getAuthTag()]);
  }

  open(purpose: KeyPurpose, sealed: Uint8Array, aad: string): Uint8Array {
    const b = Buffer.from(sealed);
    if (b.length < 29 || b[0] !== VERSION) throw new Error(`${aad}: not a sealed value`);
    const d = createDecipheriv('aes-256-gcm', this.#keys[purpose], b.subarray(1, 13));
    d.setAAD(Buffer.from(aad, 'utf8'));
    d.setAuthTag(b.subarray(b.length - 16));
    try {
      return Buffer.concat([d.update(b.subarray(13, b.length - 16)), d.final()]);
    } catch {
      throw new Error(`${aad}: decryption failed (wrong master key or tampered data)`);
    }
  }

  /** A `SecretProtector` for the SDK's `StorePrekeyVault`. */
  protector(purpose: KeyPurpose, aad: string): SecretProtector {
    return { seal: async (p) => this.seal(purpose, p, aad), open: async (s) => this.open(purpose, s, aad) };
  }
}

// ACE_IDENTITY_KEY is moved out of the environment on first use so child processes do not inherit it.
let envSecret: string | undefined;

/** Tests only. */
export function _resetEnvSecretForTests(): void { envSecret = undefined; }

function takeEnvSecret(): string | undefined {
  const s = process.env.ACE_IDENTITY_KEY;
  if (s) { envSecret = s; delete process.env.ACE_IDENTITY_KEY; }
  return envSecret;
}

/** `resolveKeystoreMode` for this process (an already consumed ACE_IDENTITY_KEY still selects `env`). */
export function resolveProcessKeystoreMode(requested: KeystoreMode | undefined): ResolvedKeystoreMode {
  return envSecret ? 'env' : resolveKeystoreMode(requested, process.env);
}

/** Where one identity's master key lives (config.json). */
export type Keystore = Pick<BaseConfig, 'keystore' | 'keystoreId'>;

/** A fresh keystore ID: names a new identity's OS keystore entry, so identity directories never share one. */
export const newKeystoreId = () => randomBytes(16).toString('hex');

const accountOf = (k: Keystore) => `master-key-${k.keystoreId}`;

const whereOf = (dir: string, k: Keystore) => k.keystore === 'env' ? 'ACE_IDENTITY_KEY'
  : k.keystore === 'file' ? join(dir, MASTER_KEY_FILE) : `the OS keystore (service "${SERVICE}", account "${accountOf(k)}")`;

/** `os`: the OS keystore to use instead of the platform's (tests inject an in-memory one). */
function storeFor(mode: ResolvedKeystoreMode, dir: string, os?: OSKeyStore): OSKeyStore | null {
  if (mode === 'env') return null;
  return mode === 'file' ? createFileKeyStore(dir) : os ?? createKeyStore();
}

function decodeMaster(text: string): Buffer {
  let raw: Uint8Array | null;
  try { raw = fromBase64(text.trim()); } catch { raw = null; }
  if (raw?.length !== 32) throw new Error('the master key must be the Base64 of 32 bytes');
  return Buffer.from(raw);
}

/** The key ring of an existing keystore (ACE_IDENTITY_KEY, when set, always wins). */
export async function loadKeyRing(dir: string, k: Keystore, os?: OSKeyStore): Promise<KeyRing> {
  const text = takeEnvSecret() ?? await storeFor(k.keystore, dir, os)?.load(SERVICE, accountOf(k)) ?? null;
  if (!text) throw new Error(`master key not found in ${whereOf(dir, k)}; the identity cannot be decrypted without it`);
  return new KeyRing(decodeMaster(text));
}

/** A new master key in its own store entry, never replacing an existing one (`env`: ACE_IDENTITY_KEY is used as given). */
export async function createKeyRing(dir: string, k: Keystore, os?: OSKeyStore): Promise<KeyRing> {
  if (k.keystore === 'env') {
    const text = takeEnvSecret();
    if (!text) throw new Error('ACE_IDENTITY_KEY is not set');
    return new KeyRing(decodeMaster(text));
  }
  const store = storeFor(k.keystore, dir, os)!;
  if (await store.load(SERVICE, accountOf(k)) !== null) throw new Error(`${whereOf(dir, k)} already holds a master key; refusing to overwrite it`);
  const master = randomBytes(32);
  await store.save(SERVICE, accountOf(k), master.toString('base64'));
  return new KeyRing(master);
}

export async function identityExists(dir: string): Promise<boolean> {
  try { await access(join(dir, IDENTITY_FILE)); return true; } catch { return false; }
}

export async function saveIdentity(dir: string, ring: KeyRing, identity: SoftwareIdentity): Promise<void> {
  const plain = new TextEncoder().encode(JSON.stringify(identity.exportPrivateKey()));
  await new FileStore(dir).write(IDENTITY_FILE, ring.seal('identity', plain, IDENTITY_FILE));
}

export async function loadIdentity(dir: string, ring: KeyRing): Promise<SoftwareIdentity> {
  const raw = await new FileStore(dir).read(IDENTITY_FILE);
  if (raw === null) throw new Error(`${join(dir, IDENTITY_FILE)} not found: run "ace init"`);
  return SoftwareIdentity.fromExport(JSON.parse(new TextDecoder().decode(ring.open('identity', raw, IDENTITY_FILE))));
}

/** Delete identity.enc, master.key and (os mode) this identity's keystore entry (`k` null: config.json was unreadable). */
export async function destroyKeys(dir: string, k: Keystore | null, os?: OSKeyStore): Promise<void> {
  for (const file of [IDENTITY_FILE, MASTER_KEY_FILE]) {
    await unlink(join(dir, file)).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; });
  }
  if (k?.keystore !== 'os') return;
  let store: OSKeyStore;
  try { store = os ?? createKeyStore(); } catch { return; }
  await store.delete(SERVICE, accountOf(k));
}
