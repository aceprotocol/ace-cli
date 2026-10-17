/**
 * Plain (non-secret) local configuration under the ACE directory:
 * - `config.json`: relay URL, where the master key lives and the random keystore ID naming its OS keystore entry;
 * - `network.json`: what the descriptor declares (visibility, handle, card, profiles, ext, delegations, ERC-8004) and
 *   the local `acceptProfiles` policy;
 * - `manifests/<sha256(id)>.json`: installed third-party profile manifests.
 */
import {
  ACEError, BUNDLED_MANIFESTS, FileStore, isCanonicalRelayUrl, normalizeRelayUrl, sha256Hex, validateProfileManifest,
  type AgentCard, type DescriptorDelegation, type Erc8004Binding, type JSONObject, type ProfileManifest, type Visibility,
} from '@ace-protocol/sdk';
import { join } from 'node:path';
import { RESOLVED_KEYSTORE_MODES, type ResolvedKeystoreMode } from './keystore-mode.js';

export const DEFAULT_RELAY = 'https://relay.aceprotocol.org';

async function readJson(dir: string, name: string): Promise<unknown | null> {
  const raw = await new FileStore(dir).read(name);
  if (raw === null) return null;
  try {
    return JSON.parse(new TextDecoder().decode(raw));
  } catch (err) {
    throw new Error(`${join(dir, name)} is corrupt (not valid JSON); fix or delete it`, { cause: err });
  }
}

async function writeJson(dir: string, name: string, value: unknown): Promise<void> {
  await new FileStore(dir).write(name, new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`));
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// --- config.json ---

export interface BaseConfig { relay: string; keystore: ResolvedKeystoreMode; keystoreId: string }

export async function loadBaseConfig(dir: string): Promise<BaseConfig | null> {
  const c = await readJson(dir, 'config.json');
  if (c === null) return null;
  if (!isObj(c) || typeof c.relay !== 'string' || !RESOLVED_KEYSTORE_MODES.has(c.keystore)
    || typeof c.keystoreId !== 'string' || !/^[0-9a-f]{32}$/.test(c.keystoreId)) throw new Error(`${join(dir, 'config.json')} is invalid`);
  return { relay: c.relay, keystore: c.keystore as ResolvedKeystoreMode, keystoreId: c.keystoreId };
}

export async function saveBaseConfig(dir: string, c: BaseConfig): Promise<void> { await writeJson(dir, 'config.json', c); }

/**
 * --relay, then ACE_RELAY, then config.json, then the default, normalized (02 § Relay URL). `http://` to a loopback
 * host needs an explicit development opt-in; any other `http://` relay is refused.
 */
export function resolveRelayUrl(o: { relay?: string; allowInsecureRelay?: boolean }, base: BaseConfig | null): string {
  const url = normalizeRelayUrl(o.relay || process.env.ACE_RELAY || base?.relay || DEFAULT_RELAY);
  const insecure = o.allowInsecureRelay || ['1', 'true', 'yes'].includes((process.env.ACE_ALLOW_INSECURE_RELAY ?? '').toLowerCase());
  if (!isCanonicalRelayUrl(url, { allowLoopback: insecure })) {
    throw new Error(insecure
      ? `Insecure relay URL rejected: ${url}. --allow-insecure-relay admits http:// only to localhost, 127.0.0.1 or [::1].`
      : `Insecure relay URL rejected: ${url}. Use https://, or --allow-insecure-relay / ACE_ALLOW_INSECURE_RELAY=1 for a loopback development relay.`);
  }
  return url;
}

// --- network.json ---

export interface NetworkSettings {
  visibility: Visibility;
  handle?: string;
  card: AgentCard;
  /** Installed profiles: `text`, `commerce` or the ID of a manifest installed with `ace network install-profile`. */
  profiles: string[];
  /** Local policy: contact requests for these profile IDs are accepted without `ace network accept`. */
  acceptProfiles: string[];
  ext?: Record<string, JSONObject>;
  delegations: DescriptorDelegation[];
  erc8004: Erc8004Binding[];
}

export const DEFAULT_SETTINGS: NetworkSettings = { visibility: 'private', card: {}, profiles: ['text'], acceptProfiles: [], delegations: [], erc8004: [] };

export async function loadSettings(dir: string): Promise<NetworkSettings> {
  const s = await readJson(dir, 'network.json');
  if (s === null) return structuredClone(DEFAULT_SETTINGS);
  if (!isObj(s)) throw new Error(`${join(dir, 'network.json')} is invalid`);
  return { ...structuredClone(DEFAULT_SETTINGS), ...s } as NetworkSettings;
}

export async function saveSettings(dir: string, s: NetworkSettings): Promise<void> { await writeJson(dir, 'network.json', s); }

/** The raw bytes of network.json (the listener reloads when they change). */
export async function settingsFingerprint(dir: string): Promise<string> {
  const raw = await new FileStore(dir).read('network.json');
  return raw === null ? '' : sha256Hex(raw);
}

// --- manifests ---

const manifestFile = (id: string) => `manifests/${sha256Hex(id)}.json`;

export async function installManifest(dir: string, value: unknown): Promise<ProfileManifest> {
  const m = validateProfileManifest(value);
  if (Object.values(BUNDLED_MANIFESTS).some((b) => b.id === m.id)) throw new ACEError('invalid_argument', `${m.id} is bundled`);
  await writeJson(dir, manifestFile(m.id), m);
  return m;
}

/** Bundled profiles a descriptor may declare by name (core is always declared). */
export const BUNDLED_PROFILES = ['text', 'commerce'] as const;
type BundledProfile = typeof BUNDLED_PROFILES[number];
const isBundled = (p: string): p is BundledProfile => (BUNDLED_PROFILES as readonly string[]).includes(p);

/** Every installed third-party manifest. */
export async function installedManifests(dir: string): Promise<ProfileManifest[]> {
  const keys = await new FileStore(dir).list('manifests/');
  const values = await Promise.all(keys.map((k) => readJson(dir, k)));
  return values.filter((v) => v !== null).map(validateProfileManifest);
}

/** The profiles of `settings` as `ProfileSet` input (bundled names or installed manifests). */
export async function resolveProfiles(dir: string, s: NetworkSettings): Promise<Array<BundledProfile | ProfileManifest>> {
  const out: Array<BundledProfile | ProfileManifest> = [];
  for (const p of s.profiles) {
    if (isBundled(p)) { out.push(p); continue; }
    const m = await readJson(dir, manifestFile(p));
    if (m === null) throw new ACEError('invalid_argument', `profile ${p} is not installed (ace network install-profile --file <manifest>)`);
    out.push(validateProfileManifest(m));
  }
  return out;
}
