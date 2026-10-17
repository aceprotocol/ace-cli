/**
 * The one place a NetworkClient is built: identity and key ring from the keystore, sealed SDK state under
 * `<aceDir>/state`, prekeys sealed in the same directory, settings from network.json; the SDK adds the MessageLog and
 * (with the commerce profile) the ThreadStore and commerceRules.
 */
import {
  ACEError, FileStore, NetworkClient, RelayClient, StorePrekeyVault, publicRelay, type SoftwareIdentity,
} from '@ace-protocol/sdk';
import { join } from 'node:path';
import { ACE_DIR, loadIdentity, loadKeyRing, type KeyRing } from './storage/keychain.js';
import { loadBaseConfig, loadSettings, resolveProfiles, resolveRelayUrl, type BaseConfig, type NetworkSettings } from './storage/config.js';
import type { OSKeyStore } from './storage/os-keystore.js';
import { SealedStore } from './storage/sealed-store.js';

export interface CommonOptions {
  aceDir?: string;
  /** The OS keystore to use instead of the platform's (tests inject an in-memory one). */
  osKeyStore?: OSKeyStore;
  relay?: string;
  allowInsecureRelay?: boolean;
  /** Injected into every RelayClient (tests). */
  fetch?: typeof fetch;
}

export interface Local {
  aceDir: string;
  /** config.json. */
  base: BaseConfig;
  identity: SoftwareIdentity;
  ring: KeyRing;
  /** Sealed SDK state. */
  store: SealedStore;
  /** The unsealed directory store (locks, sealed prekey vault). */
  raw: FileStore;
}

export interface Agent extends Local {
  client: NetworkClient;
  close(): Promise<void>;
}

/** What `openAgent` reuses instead of loading: an already opened `local`, or `settings` not yet saved. */
export interface OpenWith { local?: Local; settings?: NetworkSettings }

/** Rethrow `lock_busy` with a message naming what holds the lock; any other error unchanged. */
export const busyAs = (message: string) => (err: unknown): never => {
  if (err instanceof ACEError && err.code === 'lock_busy') throw new ACEError('lock_busy', message, { cause: err });
  throw err;
};

export const aceDirOf = (o: CommonOptions) => o.aceDir ?? ACE_DIR;

/** Identity, key ring and sealed state; no relay. */
export async function openLocal(o: CommonOptions = {}): Promise<Local> {
  const aceDir = aceDirOf(o);
  const base = await loadBaseConfig(aceDir);
  if (!base) throw new Error(`${join(aceDir, 'config.json')} not found: run "ace init"`);
  const ring = await loadKeyRing(aceDir, base, o.osKeyStore);
  const identity = await loadIdentity(aceDir, ring);
  const raw = new FileStore(join(aceDir, 'state'));
  return { aceDir, base, identity, ring, raw, store: new SealedStore(raw, ring) };
}

export function relayClient(o: CommonOptions, url: string): RelayClient {
  return new RelayClient(url, { ...(o.fetch ? { fetch: o.fetch } : {}), allowLoopbackRelays: isLoopback(url) });
}

/** A resolved relay URL is canonical, so `http://` means a loopback development relay. */
const isLoopback = (url: string) => url.startsWith('http://');

/**
 * Open the agent (`NetworkClient.open`). `receive`: this process owns the Inbox (exclusive; `lock_busy` while
 * `ace listen` / `ace mcp` runs). `send`: a send-only client (`receive: false`) that never takes the receive lock nor
 * touches inbox state, usable next to a running receiver.
 */
export async function openAgent(o: CommonOptions, mode: 'receive' | 'send', w: OpenWith = {}): Promise<Agent> {
  const aceDir = aceDirOf(o);
  const declared = async () => {
    const settings = w.settings ?? await loadSettings(aceDir);
    return { settings, profiles: await resolveProfiles(aceDir, settings) };
  };
  const [local, { settings, profiles }] = await Promise.all([w.local ?? openLocal(o), declared()]);
  const relayUrl = resolveRelayUrl(o, local.base);
  const client = await NetworkClient.open({
    identity: local.identity, store: local.store, relayUrl, profiles, receive: mode === 'receive',
    ...(o.fetch ? { fetch: o.fetch } : {}), allowLoopbackRelays: isLoopback(relayUrl),
    vault: new StorePrekeyVault(local.raw, { protect: local.ring.protector('prekeys', 'prekeys.json') }),
    foreignRelay: (url: string) => o.fetch ? new RelayClient(url, { fetch: o.fetch }) : publicRelay(url),
    visibility: settings.visibility, ...(settings.handle ? { handle: settings.handle } : {}), card: settings.card,
    ...(settings.ext ? { ext: settings.ext } : {}),
    delegations: settings.delegations, // the SDK publishes only the live ones
    erc8004: settings.erc8004, acceptProfiles: settings.acceptProfiles,
  }).catch(busyAs('"ace listen" or "ace mcp" is receiving for this identity; stop it first'));
  return { ...local, client, close: () => client.close() };
}

export async function withAgent<T>(o: CommonOptions, mode: 'receive' | 'send', fn: (a: Agent) => Promise<T>, w: OpenWith = {}): Promise<T> {
  const agent = await openAgent(o, mode, w);
  try { return await fn(agent); } finally { await agent.close(); }
}

/**
 * `withAgent` on a receiving client (`receiving`: this process pulls the relay), or, while `ace listen` / `ace mcp`
 * receives for this identity (which pulls and keeps the local state current), on a send-only one.
 */
export async function withReceiving<T>(o: CommonOptions, fn: (a: Agent, receiving: boolean) => Promise<T>): Promise<T> {
  let agent: Agent, receiving = true;
  try { agent = await openAgent(o, 'receive'); } catch (err) {
    if (!(err instanceof ACEError && err.code === 'lock_busy')) throw err;
    agent = await openAgent(o, 'send');
    receiving = false;
  }
  try { return await fn(agent, receiving); } finally { await agent.close(); }
}
