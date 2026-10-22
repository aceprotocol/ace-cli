/**
 * What this identity declares: `ace network configure | install-profile` and `ace delegation issue | add`. Every
 * change is published (descriptor, then card record), then saved to network.json; a change the descriptor or card
 * record rules refuse is never saved.
 */
import {
  ACEError, HANDLE_RE, createDelegationCredential, handleAddress, MAX_DELEGATION_LIFETIME, isCaip10Account, isHandle, MAX_DESCRIPTOR_DELEGATIONS,
  MAX_DESCRIPTOR_ERC8004, MAX_PAY_ACCOUNTS, validateCard, validateErc8004Binding, type AgentCard, type DescriptorDelegation,
  type Erc8004Binding, type JSONObject, type PublishedAgent,
} from '@ace-protocol/sdk';
import { writeFile } from 'node:fs/promises';
import { agentView } from '@ace-protocol/sdk/tools';
import { aceDirOf, openLocal, withAgent, type Agent, type CommonOptions, type Local } from './context.js';
import { profiles } from './ops.js';
import { readBoundedJson } from './storage/bounded-json.js';
import { installManifest, loadBaseConfig, loadSettings, resolveRelayUrl, saveSettings, type NetworkSettings } from './storage/config.js';

const SET_ONCE = 'handles are set once per identity: once published at a home relay, a handle can never be changed or removed there';

/** The card record a settings file declares at `relay` (the shape `ace_identity` reports). */
function cardOf(s: NetworkSettings, relay: string) {
  return {
    ...(s.handle ? { handle: s.handle, address: handleAddress(s.handle, relay) } : {}), card: s.card,
    ...(s.pay ? { pay: s.pay } : {}), contact: s.contact, listed: s.listed,
  };
}

/** `s` after a successful publish at `relay`: a handle published there is fixed there. */
function publishedAt(s: NetworkSettings, relay: string): NetworkSettings {
  const next = { ...s };
  if (next.handle) next.handleHome = relay; else delete next.handleHome;
  return next;
}

/**
 * Print a notice (stderr) when the publish at `relay` that just succeeded claimed `s.handle` there first (a relay URL
 * with a path never gets here with a handle: the SDK refuses to sign that card record).
 */
function noteClaim(s: NetworkSettings, relay: string): void {
  if (s.handle && s.handleHome !== relay) console.error(`${handleAddress(s.handle, relay)} is yours for good — handles never change`);
}

/**
 * A publish the relay refused, explained (the relay's code becomes the error code): a taken handle, or a card record
 * without the handle this identity already has at that relay (set once: `invalid_argument`, explained only when
 * `handleInvolved`; otherwise the relay's answer stands as is).
 */
export function explainRefusal(err: unknown, s: NetworkSettings, relay: string, handleInvolved = s.handle !== undefined): unknown {
  if (!(err instanceof ACEError) || err.code !== 'relay_rejected') return err;
  const opts = { cause: err, ...(err.status !== undefined ? { status: err.status } : {}), relayCode: err.relayCode };
  if (err.relayCode === 'handle_taken' && s.handle) {
    return new ACEError('handle_taken', `${handleAddress(s.handle, relay)} belongs to another identity; choose another with --handle`, opts);
  }
  if (err.relayCode === 'invalid_argument' && handleInvolved) {
    return new ACEError('invalid_argument', `${relay} refused the card record (${err.detail}): ${SET_ONCE}. `
      + 'If this identity already has a handle there, configure exactly that one (ace network configure --handle <name>)', opts);
  }
  return err;
}

/**
 * Publish through `a` (opened with `s`) and return the descriptor, its view with the card record, and `s` as recorded
 * after the publish; a refusal comes back explained.
 */
async function publishDeclared(a: Agent, s: NetworkSettings, publish: () => Promise<PublishedAgent>, handleInvolved?: boolean) {
  const relay = a.client.relay.baseUrl;
  let source: PublishedAgent;
  try { source = await publish(); } catch (err) { throw explainRefusal(err, s, relay, handleInvolved); }
  noteClaim(s, relay);
  return { source, view: { ...await agentView(a.client, source), ...cardOf(s, relay) }, recorded: publishedAt(s, relay) };
}

/** Publish `next` and save it; a change the descriptor or card record rules refuse is not saved, one not yet published is. */
async function apply(o: CommonOptions, next: NetworkSettings, local?: Local, hadHandle = false) {
  const aceDir = aceDirOf(o);
  let published;
  try {
    published = await withAgent(o, 'send', (a) => publishDeclared(a, next, () => a.client.publish(), hadHandle || next.handle !== undefined),
      { settings: next, ...(local ? { local } : {}) });
  } catch (err) {
    if (err instanceof ACEError && !err.isTransient) throw err;
    await saveSettings(aceDir, next);
    console.error(`WARNING: settings saved but not published (${(err as Error).message}); run "ace network publish".`);
    return { saved: true, published: false };
  }
  await saveSettings(aceDir, published.recorded);
  return published.view;
}

/** `ace network publish`: republish what network.json declares (optionally writing the descriptor to `out`). */
export async function runPublish(o: CommonOptions & { out?: string }) {
  const aceDir = aceDirOf(o);
  const s = await loadSettings(aceDir);
  return withAgent(o, 'send', async (a) => {
    const { source, view, recorded } = await publishDeclared(a, s, () => a.client.publish({ force: true }));
    if (recorded.handleHome !== s.handleHome) await saveSettings(aceDir, recorded);
    if (o.out !== undefined) await writeFile(o.out, `${JSON.stringify(source)}\n`, { flag: 'wx', mode: 0o644 });
    return view;
  }, { settings: s });
}

export interface ConfigureFlags {
  handle?: string;
  contact?: string;
  listed?: boolean;
  /** CAIP-10 accounts; an empty list clears. */
  pay?: string[];
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
  const aceDir = aceDirOf(o);
  const s = await loadSettings(aceDir);
  const hadHandle = s.handle !== undefined;
  if (o.handle !== undefined) {
    const want = o.handle === '' ? undefined : o.handle;
    if (want !== undefined && !isHandle(want)) throw new ACEError('invalid_argument', `--handle must be 3-32 characters matching ${HANDLE_RE.source}`);
    const relay = resolveRelayUrl(o, await loadBaseConfig(aceDir));
    if (s.handle !== undefined && s.handleHome === relay && want !== s.handle) {
      throw new ACEError('invalid_argument', `${SET_ONCE}; this identity's handle at ${relay} is ${handleAddress(s.handle, relay)}`);
    }
    if (want === undefined) { delete s.handle; delete s.handleHome; } else if (want !== s.handle) { s.handle = want; delete s.handleHome; }
  }
  if (o.contact !== undefined) {
    if (o.contact !== 'open' && o.contact !== 'closed') throw new ACEError('invalid_argument', '--contact is open or closed');
    s.contact = o.contact;
  }
  if (o.listed !== undefined) s.listed = o.listed;
  if (o.pay !== undefined) {
    if (o.pay.length === 0) delete s.pay;
    else {
      const bad = o.pay.findIndex((p) => !isCaip10Account(p));
      if (bad >= 0) throw new ACEError('invalid_argument', `--pay takes CAIP-10 accounts <namespace>:<chain>:<address>, e.g. eip155:8453:0x… (got "${o.pay[bad]!.slice(0, 160)}")`);
      if (o.pay.length > MAX_PAY_ACCOUNTS || new Set(o.pay).size !== o.pay.length) {
        throw new ACEError('invalid_argument', `--pay takes 1-${MAX_PAY_ACCOUNTS} distinct accounts`);
      }
      s.pay = o.pay;
    }
  }
  const card: AgentCard = { ...s.card };
  for (const k of ['description', 'image'] as const) {
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
  return apply(o, s, undefined, hadHandle);
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
