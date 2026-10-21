import { ACEError, type JSONObject } from '@ace-protocol/sdk';
import { Command, InvalidArgumentError } from 'commander';
import pkg from '../package.json' with { type: 'json' };
import { withAgent, withReceiving, type CommonOptions } from './context.js';
import { errorResult } from './errors.js';
import * as ops from './ops.js';
import { readBoundedJson } from './storage/bounded-json.js';
import { ACE_DIR } from './storage/keychain.js';
import type { KeystoreMode } from './storage/keystore-mode.js';
import type { OSKeyStore } from './storage/os-keystore.js';
import type { Replacement } from './storage/tty-confirm.js';

/** What the command tree needs from its host (tests inject a relay `fetch`, a home, an OS keystore and the confirmation prompt). */
export interface CliEnv {
  aceDir?: string;
  osKeyStore?: OSKeyStore;
  fetch?: typeof fetch;
  out?: (value: unknown) => void;
  confirm?: (aceId: string | null, reason?: string, replacement?: Replacement) => Promise<void>;
  isTTY?: boolean;
  listen?: { maintainMs?: number; retryMs?: number; log?: (l: string) => void };
}

const positiveInt = (v: string) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw new InvalidArgumentError('must be a positive integer');
  return n;
};
const list = (v: string) => v.split(',').map((t) => t.trim()).filter((t) => t !== '');
const jsonObject = (v: string): JSONObject => {
  let parsed: unknown;
  try { parsed = JSON.parse(v); } catch { throw new InvalidArgumentError('must be valid JSON'); }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new InvalidArgumentError('must be a JSON object');
  return parsed as JSONObject;
};
/** Run agent tool `name` on a send-only client (usable beside a running receiver). */
const sendTool = (o: CommonOptions, name: string, args: JSONObject = {}) => withAgent(o, 'send', (a) => ops.tool(a, name, args));
/** `--flag` values that are set (commander leaves the others undefined). */
const defined = (v: Record<string, unknown>): JSONObject => JSON.parse(JSON.stringify(v)) as JSONObject;

export function buildProgram(env: CliEnv = {}): Command {
  const out = env.out ?? ((v: unknown) => { console.log(JSON.stringify(v, null, 2)); });
  const program = new Command('ace')
    .description('ACE Protocol CLI: post-quantum agent identity, encrypted agent-to-agent messaging and profile-based interaction')
    .version(pkg.version)
    .option('--relay <url>', 'Home relay URL (default: ACE_RELAY, then config.json)')
    .option('--allow-insecure-relay', 'Allow an http:// relay URL (development only)')
    .exitOverride()
    .configureOutput({ writeErr: (s) => process.stderr.write(s) });

  /** Options of `cmd` with the global relay flags and the host's injections. */
  const common = (cmd: Command): CommonOptions & Record<string, unknown> => ({
    ...cmd.optsWithGlobals(), aceDir: env.aceDir ?? process.env.ACE_HOME ?? ACE_DIR, osKeyStore: env.osKeyStore, fetch: env.fetch,
  });
  const action = <A extends unknown[]>(fn: (o: CommonOptions & Record<string, unknown>, ...args: A) => Promise<unknown>) =>
    async function (this: Command, ...args: unknown[]) {
      const value = await fn(common(this), ...(args.slice(0, -2) as A));
      if (value !== undefined) out(value);
    };
  const identity = () => import('./identity.js');
  const settings = () => import('./settings.js');

  // --- identity ---
  program.command('init')
    .description('Create (or import) this identity; keys are sealed with a master key in the OS keystore, master.key or ACE_IDENTITY_KEY')
    .option('--keystore <mode>', 'auto (default), os, file or env (ACE_KEYSTORE)')
    .option('--next-root <digest>', 'Commit an externally held next root (digest printed by "ace key next-root")')
    .option('--import <file>', 'Import an identity export; it is re-keyed away from its previous custodian and published')
    .option('--force', 'Replace the existing identity (interactive terminal only)')
    .action(action(async (o) => (await identity()).runInit({
      ...o, keystore: o.keystore as KeystoreMode | undefined, nextRoot: o.nextRoot as string | undefined, importFile: o.import as string | undefined, force: o.force as boolean | undefined,
      confirm: env.confirm, isTTY: env.isTTY,
    })));

  const key = program.command('key').description('This identity\'s key event log');
  key.command('show').description('Public facts of the key event log (no key material)')
    .action(action(async (o) => (await identity()).runKeyShow(o)));
  key.command('next-root').description('Write a next root key to a new 0600 file (keep it offline) and print the digest to commit')
    .requiredOption('--out <file>', 'File to create (never overwritten)')
    .action(action(async (o) => (await identity()).runKeyNextRoot({ out: o.out as string })));
  key.command('rotate').description('Reveal the committed next root, commit a new one, re-delegate the signing key and publish (stop ace listen first)')
    .option('--next-root <digest>', 'Commit an externally held next root instead of generating one')
    .option('--root-file <file>', 'Reveal an externally held next root (file written by "ace key next-root")')
    .action(action(async (o) => (await identity()).runKeyRotate(o)));
  key.command('delegate').description('Delegate a fresh signing key and publish (stop ace listen first)')
    .option('--not-after <unix>', 'The key expires at this Unix time', positiveInt)
    .action(action(async (o) => (await identity()).runKeyDelegate(o)));
  key.command('recover <aceId>').description('After device loss: recover the identity with its externally held next root, install it here and publish')
    .requiredOption('--root-file <file>', 'The next-root file committed by the identity')
    .option('--descriptor-file <file>', 'A saved PublishedAgent of the identity (needed when the relay holds neither its live descriptor nor its card record)')
    .option('--keystore <mode>', 'auto (default), os, file or env')
    .option('--force', 'Replace an existing local identity (interactive terminal only)')
    .action(action(async (o, aceId: string) => (await identity()).runKeyRecover({
      ...o, aceId, rootFile: o.rootFile as string, descriptorFile: o.descriptorFile as string | undefined,
      keystore: o.keystore as KeystoreMode | undefined, force: o.force as boolean | undefined, confirm: env.confirm, isTTY: env.isTTY,
    })));

  // --- network ---
  const net = program.command('network').description('Publish, discover, connect and admit peers');
  net.command('publish').description('Register and publish the signed descriptor and card record (rotates the prekey after 24 h)')
    .option('--out <file>', 'Also write the full signed descriptor to a new file, to share out of band')
    .action(action(async (o) => (await settings()).runPublish(o)));
  net.command('configure').description('Change what the card record and descriptor declare, then publish')
    .option('--handle <name>', 'Card record: handle at the home relay, set once (it can never change or be removed after it was published there)')
    .option('--contact <c>', 'Card record: open (strangers may send contact requests) or closed (default; only peers you admitted or invited)')
    .option('--listed', 'Card record: list this identity in the home relay\'s directory')
    .option('--no-listed', 'Card record: do not list it (default)')
    .option('--pay <accounts>', 'Card record: CAIP-10 accounts to be paid at, comma-separated, at most 8 ("" clears)', list)
    .option('--name <name>', 'Card: display name ("" clears)')
    .option('--description <text>', 'Card: one-line description ("" clears)')
    .option('--image <url>', 'Card: image URL ("" clears)')
    .option('--tags <tags>', 'Card: comma-separated tags', list)
    .option('--profiles <ids>', 'Installed profiles: text, commerce and installed manifest IDs (comma-separated)', list)
    .option('--accept-profiles <ids>', 'Local policy: accept contact requests for these profile IDs without "network accept"', list)
    .option('--ext <json>', 'Descriptor ext keyed by installed profile ID, e.g. {"ace:commerce:1":{"settlement":[...]}} ("" clears)')
    .option('--erc8004 <bindings>', 'ERC-8004 bindings <CAIP-10 registry>:<agentId>, comma-separated ("" clears)', list)
    .action(action(async (o) => (await settings()).runConfigure(o as never)));
  net.command('install-profile').description('Install a third-party profile manifest (data only; enable it with configure --profiles)')
    .requiredOption('--file <path>', 'Profile manifest JSON')
    .action(action(async (o) => (await settings()).runInstallProfile({ ...o, file: o.file as string })));
  net.command('profiles').description('Installed profiles with their message types and schema digests')
    .action(action(async (o) => {
      const { loadSettings } = await import('./storage/config.js');
      return ops.profiles(o.aceDir!, await loadSettings(o.aceDir!));
    }));
  net.command('discover').description('Browse the home relay\'s public directory')
    .option('--profile <id>', 'Only agents declaring this profile')
    .option('--cursor <cursor>', 'Continuation')
    .option('--limit <n>', 'Page size (≤ 100)', positiveInt)
    .action(action((o) => sendTool(o, 'ace_network', defined({ action: 'discover', profile: o.profile, cursor: o.cursor, limit: o.limit }))));
  net.command('lookup <target>').description('Resolve an ACE ID or @handle@relay-host: its verified descriptor and card record (handle, card, pay, contact, listed)')
    .action(action((o, target: string) => sendTool(o, 'ace_network', { action: 'lookup', peer: target })));
  net.command('import <file>').description('Import a shared descriptor or an invitation {agent, permit}')
    .action(action(async (o, file: string) => {
      const value = await readBoundedJson('import', file, 2 * 1024 * 1024) as JSONObject;
      const invitation = typeof value === 'object' && value !== null && 'agent' in value && 'permit' in value;
      return sendTool(o, 'ace_network', invitation ? { action: 'import_invitation', invitation: value } : { action: 'import', source: value });
    }));
  net.command('invite <peer>').description('Invite one peer (ACE ID, @handle@relay or its shared descriptor file) to contact this agent; prints {agent, permit} to share privately')
    .option('--profile <id>', 'Profile of the relationship (default ace:text:1)')
    .action(action(async (o, peer: string) => {
      const named = /^(ace:|@)/.test(peer);
      const target = named ? { peer } : { source: await readBoundedJson('invite', peer, 2 * 1024 * 1024) as JSONObject };
      try {
        return (await sendTool(o, 'ace_network', defined({ action: 'invite', ...target, profile: o.profile }))).invitation; // the document to share
      } catch (err) {
        if (!named || !(err instanceof ACEError) || err.code !== 'unknown_peer') throw err;
        throw new ACEError('unknown_peer', 'the peer has no live descriptor at its relay; it must publish or share its descriptor first ("ace network publish --out <file>")', { cause: err });
      }
    }));
  net.command('connect <target>').description('Send a contact request (ACE ID or @handle@relay-host)')
    .requiredOption('--profile <id>', 'A profile both sides have installed, e.g. ace:text:1')
    .option('--note <text>', 'Short note (≤ 512 bytes, encrypted)')
    .option('--wait <seconds>', 'Then receive (like "ace inbox") until the peer answers or <seconds> pass; status admitted with canSend: ace send works now', positiveInt)
    .action(action((o, target: string) => {
      const connect = defined({ action: 'connect', peer: target, profile: o.profile, note: o.note });
      if (o.wait === undefined) return sendTool(o, 'ace_network', connect);
      return withReceiving(o, async (a, receiving) => {
        const sent = await ops.tool(a, 'ace_network', connect); // {status, aceId, messageId, profile}: a handle is resolved
        return { ...sent, ...await ops.awaitAnswer(a, sent.aceId as string, receiving, (o.wait as number) * 1000) };
      });
    }));
  net.command('requests').description('Pending incoming contact requests')
    .action(action((o) => sendTool(o, 'ace_network', { action: 'requests' })));
  net.command('peers').description('The admission table: admitted, pending and blocked peers')
    .action(action((o) => sendTool(o, 'ace_network', { action: 'peers' })));
  for (const [name, text] of [['accept', 'Accept a pending contact request'], ['reject', 'Reject a pending contact request'],
    ['block', 'Block a peer here and at the home relay'], ['unblock', 'Remove a block']] as const) {
    net.command(`${name} <aceId>`).description(text)
      .action(action((o, peer: string) => sendTool(o, 'ace_network', { action: name, peer })));
  }

  // --- delegation ---
  const del = program.command('delegation').description('Delegation credentials: an issuer declares that a subject acts on its behalf (grants no authority)');
  del.command('issue <subject>').description('Issue a credential naming <subject> (an ACE ID) as acting for this identity')
    .option('--days <n>', 'Lifetime in days (1-7, default 7)', positiveInt)
    .option('--out <file>', 'Write the credential to a new file instead of stdout')
    .action(action(async (o, subject: string) => (await settings()).runDelegationIssue({ ...o, subject, days: o.days as number, out: o.out as string })));
  del.command('add <file>').description('Attach a credential issued to this identity to its descriptor and publish')
    .action(action(async (o, file: string) => (await settings()).runDelegationAdd({ ...o, file })));

  // --- messaging ---
  program.command('send <to> <type> <json>').description('Queue an encrypted message of an installed type and try it once (a receipt confirms delivery)')
    .option('--thread <id>', 'Thread ID')
    .action(action((o, to: string, type: string, json: string) => sendTool(o, 'ace_send', defined({ to, type, body: jsonObject(json), threadId: o.thread }))));

  const inbox = program.command('inbox').description('Received messages (pulls the relay first unless a receiver is running)');
  inbox.command('list', { isDefault: true }).description('Unread messages (all with --all)')
    .option('--all', 'Include read messages')
    .option('--from <aceId>', 'Only from this sender')
    .option('--type <type>', 'Only this type')
    .option('--thread <id>', 'Only this thread')
    .option('--limit <n>', 'At most n messages', positiveInt)
    .action(action((o) => withReceiving(o, async (a, receiving) => {
      const read = () => ops.tool(a, 'ace_inbox', defined({ unreadOnly: !o.all, from: o.from, type: o.type, threadId: o.thread, limit: o.limit }));
      if (!receiving) return read(); // the running receiver pulls
      let received: unknown;
      try { received = await ops.drain(a); } catch (err) {
        if (!(err instanceof ACEError && err.isTransient)) throw err;
        received = { error: err.code };
      }
      return { received, ...await read() };
    })));
  inbox.command('ack <from> <messageId>').description('Mark a consumed message read (idempotent)')
    .action(action((o, from: string, messageId: string) => sendTool(o, 'ace_inbox', { action: 'ack', messages: [{ from, messageId }] })));

  const outbox = program.command('outbox').description('Queued sends and their delivery status');
  outbox.command('list', { isDefault: true }).description('Every entry: pending, delivered, rejected or expired (stopped retrying, outcome unknown; a late receipt still settles it)')
    .option('--status <status>', 'Only pending, delivered, rejected or expired')
    .action(action((o) => sendTool(o, 'ace_outbox', defined({ action: 'list', status: o.status }))));
  outbox.command('retry [messageId]').description('Attempt one pending entry now, or every due one')
    .action(action((o, messageId?: string) => sendTool(o, 'ace_outbox', defined({ action: 'retry', messageId }))));
  outbox.command('abandon <messageId>').description('Stop retrying an entry: it becomes expired (outcome unknown; a late receipt still settles it)')
    .action(action((o, messageId: string) => sendTool(o, 'ace_outbox', { action: 'abandon', messageId })));

  program.command('threads').description('Commerce threads (ace:commerce:1) and, with --thread, one thread with the next allowed message types')
    .option('--thread <id>', 'One thread: its history, your role and the types you may send next')
    .option('--peer <aceId>', 'Only threads with this peer')
    .action(action((o) => sendTool(o, 'ace_threads', defined({ threadId: o.thread, peer: o.peer }))));

  // --- resident ---
  program.command('listen').description('Receive continuously: follow the relay, send receipts, retry the outbox, renew descriptor, prekey and permits')
    .action(action(async (o) => { process.exitCode = await (await import('./listen.js')).runListen({ ...o, ...env.listen }); }));
  program.command('mcp').description('Run a local MCP stdio server over the resident receiver (keys stay in the local keystore)')
    .option('--allow-admission', 'also expose tools that widen admission (accept, unblock, invite) to the model')
    .action(action(async (o) => { process.exitCode = await (await import('./mcp.js')).runMcp({ ...o, ...env.listen }); }));

  return program;
}

/** Run the CLI; returns the exit code. Failures are one JSON line on stderr. */
export async function main(argv: string[], env: CliEnv = {}): Promise<number> {
  try {
    await buildProgram(env).parseAsync(argv);
    return Number(process.exitCode ?? 0);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'commander.helpDisplayed' || code === 'commander.version' || code === 'commander.help') return 0;
    if (typeof code === 'string' && code.startsWith('commander.')) return 1; // commander printed the usage error
    console.error(JSON.stringify(errorResult(err)));
    return 1;
  }
}
