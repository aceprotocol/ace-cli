/**
 * What this identity declares: `ace network configure | install-profile` and `ace delegation issue | add`. Every
 * change is published, then saved to network.json; a change the descriptor rules refuse is never saved.
 */
import {
  ACEError, createDelegationCredential, MAX_DELEGATION_LIFETIME, isHandle, MAX_DESCRIPTOR_DELEGATIONS, MAX_DESCRIPTOR_ERC8004,
  validateCard, validateErc8004Binding, type AgentCard, type DescriptorDelegation, type Erc8004Binding,
  type JSONObject, type Visibility,
} from '@ace-protocol/sdk';
import { writeFile } from 'node:fs/promises';
import { agentView } from '@ace-protocol/sdk/tools';
import { aceDirOf, openLocal, withAgent, type CommonOptions, type Local } from './context.js';
import { profiles } from './ops.js';
import { readBoundedJson } from './storage/bounded-json.js';
import { installManifest, loadSettings, saveSettings, type NetworkSettings } from './storage/config.js';

/** Publish `next` and save it; a change the descriptor rules refuse is not saved, one not yet published is. */
async function apply(o: CommonOptions, next: NetworkSettings, local?: Local) {
  const aceDir = aceDirOf(o);
  let published;
  try {
    published = await withAgent(o, 'send', async (a) => agentView(a.client, await a.client.publish()), { settings: next, ...(local ? { local } : {}) });
  } catch (err) {
    if (err instanceof ACEError && !err.isTransient) throw err;
    await saveSettings(aceDir, next);
    console.error(`WARNING: settings saved but not published (${(err as Error).message}); run "ace network publish".`);
    return { saved: true, published: false };
  }
  await saveSettings(aceDir, next);
  return published;
}

export interface ConfigureFlags {
  visibility?: string;
  handle?: string;
  name?: string;
  description?: string;
  image?: string;
  tags?: string[];
  profiles?: string[];
  acceptProfiles?: string[];
  ext?: string;
  /** `<CAIP-10 registry>:<agentId>` entries; an empty list clears. */
  erc8004?: string[];
}

/** `eip155:8453:0xabc…:42` → `{agentRegistry: 'eip155:8453:0xabc…', agentId: '42'}`. */
export function parseErc8004(value: string): Erc8004Binding {
  const i = value.lastIndexOf(':');
  try {
    return validateErc8004Binding({ agentRegistry: value.slice(0, i), agentId: value.slice(i + 1) });
  } catch (err) {
    throw new ACEError('invalid_argument', `--erc8004 takes <CAIP-10 registry>:<agentId>, e.g. eip155:8453:0x…:42 (got "${value.slice(0, 120)}")`, { cause: err });
  }
}

export async function runConfigure(o: CommonOptions & ConfigureFlags) {
  const s = await loadSettings(aceDirOf(o));
  if (o.visibility !== undefined) {
    if (o.visibility !== 'private' && o.visibility !== 'public') throw new ACEError('invalid_argument', '--visibility is private or public');
    s.visibility = o.visibility as Visibility;
  }
  if (o.handle !== undefined) {
    if (o.handle === '') delete s.handle;
    else if (!isHandle(o.handle)) throw new ACEError('invalid_argument', '--handle must match [a-z][a-z0-9_-]{2,31}');
    else s.handle = o.handle;
  }
  if (s.handle && s.visibility !== 'public') throw new ACEError('invalid_argument', 'a handle needs --visibility public');
  const card: AgentCard = { ...s.card };
  for (const k of ['name', 'description', 'image'] as const) {
    if (o[k] === '') delete card[k]; else if (o[k] !== undefined) card[k] = o[k];
  }
  if (o.tags !== undefined) { if (o.tags.length) card.tags = o.tags; else delete card.tags; }
  s.card = validateCard(card);
  if (o.profiles !== undefined) s.profiles = o.profiles;
  if (o.acceptProfiles !== undefined) s.acceptProfiles = o.acceptProfiles;
  if (o.ext !== undefined) {
    if (o.ext === '') delete s.ext;
    else {
      let ext: unknown;
      try { ext = JSON.parse(o.ext); } catch { throw new ACEError('invalid_argument', '--ext must be a JSON object keyed by profile ID'); }
      s.ext = ext as Record<string, JSONObject>;
    }
  }
  if (o.erc8004 !== undefined) {
    if (o.erc8004.length > MAX_DESCRIPTOR_ERC8004) throw new ACEError('invalid_argument', `at most ${MAX_DESCRIPTOR_ERC8004} --erc8004 bindings`);
    s.erc8004 = o.erc8004.map(parseErc8004);
  }
  return apply(o, s);
}

export async function runInstallProfile(o: CommonOptions & { file: string }) {
  const aceDir = aceDirOf(o);
  const m = await installManifest(aceDir, await readBoundedJson('--file', o.file, 256 * 1024));
  const { available } = await profiles(aceDir, await loadSettings(aceDir));
  return { installed: m.id, available, next: `ace network configure --profiles <list including ${m.id}>` };
}

/** A delegation credential: this identity (issuer) declares that `subject` acts on its behalf (≤ 7 days). */
export async function runDelegationIssue(o: CommonOptions & { subject: string; days?: number; out?: string }) {
  const days = o.days ?? 7;
  if (!Number.isInteger(days) || days < 1 || days * 86400 > MAX_DELEGATION_LIFETIME) throw new ACEError('invalid_argument', '--days must be 1..7');
  const { identity } = await openLocal(o);
  const entry: DescriptorDelegation = { kel: identity.getKel(), credential: await createDelegationCredential(identity, o.subject, { ttl: days * 86400 }) };
  if (o.out !== undefined) {
    await writeFile(o.out, `${JSON.stringify(entry, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
    return { issuer: identity.getACEId(), subject: o.subject, expiresAt: entry.credential.expiresAt, file: o.out };
  }
  return entry;
}

/** Attach a credential naming this identity as subject to its descriptor (replacing one from the same issuer). */
export async function runDelegationAdd(o: CommonOptions & { file: string }) {
  const value = await readBoundedJson('--file', o.file, 2 * 1024 * 1024);
  const local = await openLocal(o);
  const now = Math.floor(Date.now() / 1000);
  const ok = await withAgent(o, 'send', (a) => a.client.verifyDelegation(value), { local });
  if (ok === null) throw new ACEError('expired', 'the delegation credential has expired; ask the issuer for a new one');
  const s = await loadSettings(aceDirOf(o));
  const kept = s.delegations.filter((d) => d.credential.issuer !== ok.issuer && d.credential.expiresAt > now);
  if (kept.length >= MAX_DESCRIPTOR_DELEGATIONS) throw new ACEError('invalid_argument', `a descriptor carries at most ${MAX_DESCRIPTOR_DELEGATIONS} delegations`);
  s.delegations = [...kept, value as DescriptorDelegation];
  return apply(o, s, local);
}
