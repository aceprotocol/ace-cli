import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FakeRelay } from '@ace-protocol/sdk/testing';
import { makeHome } from './helpers/cli.js';

const ROOT = join(import.meta.dirname, '.network');
afterAll(() => rm(ROOT, { recursive: true, force: true }));
beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) if (e.isFile()) out.push(join(e.parentPath, e.name));
  return out;
}

describe('ace network', () => {
  it('configure publishes the card record (handle, card, pay, contact, listed), profiles and ERC-8004 bindings; discover and lookup find them', async () => {
    const relay = new FakeRelay();
    const alice = await makeHome(ROOT, 'cfg-alice', relay);
    const bob = await makeHome(ROOT, 'cfg-bob', relay);
    const registry = 'eip155:8453:0x8004a169fb4a3325136eb29fa0ceb6d2e539a432';
    const pay = ['eip155:8453:0x1111111111111111111111111111111111111111', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin'];
    const published = await alice.run('network', 'configure', '--contact', 'open', '--listed', '--handle', 'alice', '--name', 'Alice',
      '--description', 'Translates', '--tags', 'translation,legal', '--pay', pay.join(','), '--profiles', 'text,commerce', '--erc8004', `${registry}:42`,
      '--ext', JSON.stringify({ 'ace:commerce:1': { settlement: [{ method: 'stripe-link' }] } }));
    expect(published).toMatchObject({ aceId: alice.aceId, handle: 'alice', address: '@alice@relay.test', contact: 'open', listed: true, pay,
      card: { name: 'Alice', description: 'Translates', tags: ['translation', 'legal'] },
      profiles: [{ id: 'ace:text:1' }, { id: 'ace:commerce:1' }], erc8004: [{ agentRegistry: registry, agentId: '42' }] });
    expect(relay.descriptors.get(alice.aceId)!.descriptor.ext).toEqual({ 'ace:commerce:1': { settlement: [{ method: 'stripe-link' }] } });
    expect(relay.cards.get(alice.aceId)!.card).toMatchObject({ home: 'https://relay.test', handle: 'alice', contact: 'open', listed: true, pay });
    expect(relay.handles.get('alice')).toBe(alice.aceId);

    // a second publish neither re-registers the unchanged log nor fails
    const before = relay.registrations;
    expect(await alice.run('network', 'publish')).toMatchObject({ aceId: alice.aceId, handle: 'alice', contact: 'open' });
    expect(relay.registrations).toBe(before);

    expect((await bob.run('network', 'discover', '--profile', 'ace:commerce:1')).agents.map((a: { aceId: string }) => a.aceId)).toEqual([alice.aceId]);
    // lookup prints the verified card record, by handle and by ACE ID
    const card = { home: 'https://relay.test', handle: 'alice', card: { name: 'Alice', description: 'Translates' }, pay, contact: 'open', listed: true };
    expect(await bob.run('network', 'lookup', '@alice@relay.test')).toMatchObject({ agent: { aceId: alice.aceId }, card });
    expect(await bob.run('network', 'lookup', alice.aceId)).toMatchObject({ agent: { aceId: alice.aceId }, card });

    // invalid settings are refused and never saved
    await expect(alice.run('network', 'configure', '--erc8004', 'not-a-binding')).rejects.toThrow(/erc8004/);
    await expect(alice.run('network', 'configure', '--contact', 'public')).rejects.toThrow(/open or closed/);
    await expect(alice.run('network', 'configure', '--pay', 'not-an-account')).rejects.toThrow(/CAIP-10/);
    await expect(alice.run('network', 'configure', '--pay', `${pay[0]},${pay[0]}`)).rejects.toThrow(/distinct/);
    await expect(alice.run('network', 'configure', '--ext', JSON.stringify({ 'urn:x:1': {} }))).rejects.toMatchObject({ code: 'invalid_authorization' });
    const saved = JSON.parse(await readFile(join(alice.dir, 'network.json'), 'utf8'));
    expect(saved).toMatchObject({ ext: { 'ace:commerce:1': { settlement: [{ method: 'stripe-link' }] } }, pay, handle: 'alice', handleHome: 'https://relay.test' });
    const cleared = await alice.run('network', 'configure', '--erc8004', '', '--pay', '', '--no-listed', '--contact', 'closed');
    expect(cleared).toMatchObject({ contact: 'closed', listed: false });
    expect(cleared.erc8004).toBeUndefined();
    expect(cleared.pay).toBeUndefined();
    expect(relay.cards.get(alice.aceId)!.card).toMatchObject({ handle: 'alice', contact: 'closed', listed: false });
    expect(relay.cards.get(alice.aceId)!.card.pay).toBeUndefined();
    // closed and unlisted: not in the directory; lookup still shows the card
    expect((await bob.run('network', 'discover')).agents).toEqual([]);
    expect((await bob.run('network', 'lookup', '@alice@relay.test')).card).toMatchObject({ contact: 'closed', listed: false });
  });

  it('a handle is set once: changing or removing it is refused locally, and the relay refusal is explained', async () => {
    const relay = new FakeRelay();
    const alice = await makeHome(ROOT, 'once-alice', relay);
    const mallory = await makeHome(ROOT, 'once-mallory', relay);
    await alice.run('network', 'configure', '--handle', 'alice');
    await alice.run('network', 'configure', '--handle', 'alice', '--name', 'Alice'); // the same handle is fine
    await expect(alice.run('network', 'configure', '--handle', 'alicia')).rejects.toThrow(/set once per identity.*@alice@relay\.test/);
    await expect(alice.run('network', 'configure', '--handle', '')).rejects.toThrow(/set once per identity/);
    expect(JSON.parse(await readFile(join(alice.dir, 'network.json'), 'utf8')).handle).toBe('alice');

    // a taken handle
    await expect(mallory.run('network', 'configure', '--handle', 'alice')).rejects.toMatchObject({ code: 'handle_taken', message: expect.stringMatching(/@alice@relay\.test belongs to another identity/) });
    await expect(readFile(join(mallory.dir, 'network.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' }); // never saved

    // settings that lost the handle: the relay's invalid_argument names the rule
    await writeFile(join(alice.dir, 'network.json'), JSON.stringify({ card: { name: 'Alice' } }), { mode: 0o600 });
    // with no handle in the request nor set before, the relay's answer stands as is
    const lost = await alice.run('network', 'publish').then(() => null, (e: unknown) => e as { code: string; relayCode: string; message: string });
    expect(lost).toMatchObject({ code: 'relay_rejected', relayCode: 'invalid_argument' });
    expect(lost!.message).not.toMatch(/set once/);
    await expect(alice.run('network', 'configure', '--handle', 'alicia')).rejects.toMatchObject({ code: 'invalid_argument', message: expect.stringMatching(/configure exactly that one/) });
    expect(relay.handles.get('alice')).toBe(alice.aceId);
    expect(relay.handles.has('alicia')).toBe(false);
    // the handle it has is accepted again, and fixed locally from then on
    await alice.run('network', 'configure', '--handle', 'alice');
    expect(JSON.parse(await readFile(join(alice.dir, 'network.json'), 'utf8')).handleHome).toBe('https://relay.test');
  });

  it('the first successful handle claim prints that it is permanent, once', async () => {
    const relay = new FakeRelay();
    const alice = await makeHome(ROOT, 'claim-alice', relay);
    const notice = /^@alice@relay\.test is yours for good — handles never change$/;
    vi.mocked(console.error).mockClear();
    const lines = () => vi.mocked(console.error).mock.calls.map((c) => String(c[0])).filter((l) => notice.test(l));
    await alice.run('network', 'configure', '--name', 'Alice');
    expect(lines()).toHaveLength(0);
    await alice.run('network', 'configure', '--handle', 'alice');
    expect(lines()).toHaveLength(1);
    await alice.run('network', 'configure', '--handle', 'alice', '--name', 'Alice A');
    await alice.run('network', 'publish');
    expect(lines()).toHaveLength(1);
  });

  it('a refusal is explained as the set-once rule only when a handle is involved', async () => {
    const { explainRefusal } = await import('../src/settings.js');
    const { ACEError } = await import('@ace-protocol/sdk');
    const refusal = () => new ACEError('relay_rejected', 'relay rejected', { status: 400, relayCode: 'invalid_argument' });
    const base = { card: {}, contact: 'closed', listed: false, profiles: ['text'], acceptProfiles: [], delegations: [] } as never;
    const R = 'https://relay.test';
    expect(explainRefusal(refusal(), base, R)).toMatchObject({ code: 'relay_rejected' });
    expect(explainRefusal(refusal(), { ...(base as object), handle: 'alice' } as never, R)).toMatchObject({ code: 'invalid_argument', message: expect.stringMatching(/set once/) });
    expect(explainRefusal(refusal(), base, R, { ...(base as object), handle: 'alice' } as never)).toMatchObject({ code: 'invalid_argument', message: expect.stringMatching(/set once/) });
  });

  it('a network.json written with visibility loads as contact + listed', async () => {
    const relay = new FakeRelay();
    const pub = await makeHome(ROOT, 'legacy-public', relay);
    await writeFile(join(pub.dir, 'network.json'), JSON.stringify({ visibility: 'public', handle: 'legacy', card: { name: 'Old' }, profiles: ['text'] }), { mode: 0o600 });
    expect(await pub.run('network', 'publish')).toMatchObject({ handle: 'legacy', contact: 'open', listed: true, card: { name: 'Old' } });
    expect(relay.cards.get(pub.aceId)!.card).toMatchObject({ handle: 'legacy', contact: 'open', listed: true });
    const priv = await makeHome(ROOT, 'legacy-private', relay);
    await writeFile(join(priv.dir, 'network.json'), JSON.stringify({ visibility: 'private' }), { mode: 0o600 });
    const out = await priv.run('network', 'configure', '--name', 'Quiet');
    expect(out).toMatchObject({ contact: 'closed', listed: false, card: { name: 'Quiet' } });
    const saved = JSON.parse(await readFile(join(priv.dir, 'network.json'), 'utf8'));
    expect(saved).toMatchObject({ contact: 'closed', listed: false });
    expect(saved.visibility).toBeUndefined();
  });

  it('installs a third-party profile manifest and lists message digests', async () => {
    const relay = new FakeRelay();
    const a = await makeHome(ROOT, 'profiles', relay);
    const file = join(a.dir, 'manifest.json');
    await writeFile(file, JSON.stringify({ id: 'urn:example:translate:1', messages: [{ type: 'urn:example:translate:request:1',
      schema: { type: 'object', properties: { text: { type: 'string', maxLength: 64 } }, required: ['text'], additionalProperties: false } }] }));
    expect((await a.run('network', 'install-profile', '--file', file)).installed).toBe('urn:example:translate:1');
    await a.run('network', 'configure', '--profiles', 'text,urn:example:translate:1');
    const p = await a.run('network', 'profiles');
    expect(p.installed.map((m: { id: string }) => m.id)).toEqual(['ace:core:1', 'ace:text:1', 'urn:example:translate:1']);
    expect(p.installed[2].messages[0]).toMatchObject({ type: 'urn:example:translate:request:1', schemaDigest: expect.stringMatching(/^[0-9a-f]{64}$/) });
    await expect(a.run('network', 'configure', '--profiles', 'urn:not:installed:1')).rejects.toThrow(/not installed/);
  });

  it('two homes: connect, accept, send, inbox, ack, receipt; history is encrypted at rest; block', async () => {
    const relay = new FakeRelay();
    const alice = await makeHome(ROOT, 'flow-alice', relay);
    const bob = await makeHome(ROOT, 'flow-bob', relay);
    await alice.run('network', 'configure', '--contact', 'open', '--listed', '--handle', 'alice');
    await bob.run('network', 'publish');

    const req = await bob.run('network', 'connect', '@alice@relay.test', '--profile', 'ace:text:1', '--note', 'hello from bob');
    expect(req).toMatchObject({ status: 'pending', aceId: alice.aceId, profile: 'ace:text:1' });
    expect(typeof req.messageId).toBe('string');
    expect((await alice.run('inbox')).received.contact).toBe(1);
    const { requests: pending } = await alice.run('network', 'requests');
    expect(pending).toMatchObject([{ from: bob.aceId, profile: 'ace:text:1', note: 'hello from bob' }]);
    await alice.run('network', 'accept', bob.aceId);
    await bob.run('inbox');
    const [peer] = (await bob.run('network', 'peers')).peers;
    expect(peer).toMatchObject({ aceId: alice.aceId, status: 'admitted' });
    expect(peer.permitExpiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000)); // the permit alice's accept carried

    const secret = 'the quick brown fox 4711';
    const sent = await bob.run('send', alice.aceId, 'ace:text:1', JSON.stringify({ message: secret }));
    expect(sent).toMatchObject({ to: alice.aceId, type: 'ace:text:1', status: 'pending' });
    const inbox = await alice.run('inbox');
    expect(inbox.messages).toMatchObject([{ from: bob.aceId, messageId: sent.messageId, body: { message: secret } }]);

    // message history, outbox content and contact notes are sealed with the keystore key
    for (const home of [alice, bob]) {
      for (const f of await filesUnder(join(home.dir, 'state'))) {
        const text = (await readFile(f)).toString('latin1');
        expect(text).not.toContain(secret);
        expect(text).not.toContain('hello from bob');
      }
    }

    await alice.run('inbox', 'ack', bob.aceId, sent.messageId);
    expect((await alice.run('inbox')).messages).toEqual([]);
    expect((await alice.run('inbox', '--all')).messages).toHaveLength(1);

    expect((await bob.run('inbox')).received.receipt).toBe(1);
    expect((await bob.run('outbox')).messages).toMatchObject([{ messageId: sent.messageId, status: 'delivered' }]);

    await alice.run('network', 'block', bob.aceId);
    expect(relay.blocks.get(`${alice.aceId}|${bob.aceId}`)).toMatchObject({ blocked: true });
    expect((await bob.run('send', alice.aceId, 'ace:text:1', JSON.stringify({ message: 'x' }))).code).toBe('not_permitted');
    await alice.run('network', 'unblock', bob.aceId);
    expect(relay.blocks.get(`${alice.aceId}|${bob.aceId}`)).toMatchObject({ blocked: false });

    // commerce threads need the profile
    await expect(alice.run('threads')).rejects.toThrow(/commerce profile is not installed/);
  });

  it('pairing a closed agent through an invitation', async () => {
    const relay = new FakeRelay();
    const carol = await makeHome(ROOT, 'pair-carol', relay);
    const dave = await makeHome(ROOT, 'pair-dave', relay);
    const daveFile = join(dave.dir, 'dave.json');
    await dave.run('network', 'publish', '--out', daveFile);
    const invitation = await carol.run('network', 'invite', daveFile);
    const file = join(dave.dir, 'invitation.json');
    await writeFile(file, JSON.stringify(invitation));
    expect(await dave.run('network', 'import', file)).toMatchObject({ agent: { aceId: carol.aceId }, permit: true });
    await dave.run('network', 'connect', carol.aceId, '--profile', 'ace:text:1');
    await carol.run('inbox'); // pre-admitted: accepted automatically
    await dave.run('inbox');
    expect((await dave.run('network', 'peers')).peers).toMatchObject([{ aceId: carol.aceId, status: 'admitted' }]);
    const sent = await dave.run('send', carol.aceId, 'ace:text:1', JSON.stringify({ message: 'private hello' }));
    expect((await carol.run('inbox')).messages).toMatchObject([{ messageId: sent.messageId }]);
  });

  it('delegation issue / add and commerce threads', async () => {
    const relay = new FakeRelay();
    const org = await makeHome(ROOT, 'del-org', relay);
    const bot = await makeHome(ROOT, 'del-bot', relay);
    const file = join(org.dir, 'credential.json');
    const issued = await org.run('delegation', 'issue', bot.aceId, '--days', '3', '--out', file);
    expect(issued).toMatchObject({ issuer: org.aceId, subject: bot.aceId });
    await expect(org.run('delegation', 'issue', bot.aceId, '--days', '8')).rejects.toThrow(/1\.\.7/);
    const published = await bot.run('delegation', 'add', file);
    expect(published.delegations).toMatchObject([{ issuer: org.aceId }]);
    expect(relay.descriptors.get(bot.aceId)!.descriptor.delegations![0].credential.issuer).toBe(org.aceId);
    // a credential for someone else is refused
    await expect(org.run('delegation', 'add', file)).rejects.toMatchObject({ code: 'invalid_authorization' });

    await org.run('network', 'configure', '--contact', 'open', '--listed', '--profiles', 'text,commerce', '--accept-profiles', 'ace:commerce:1');
    await bot.run('network', 'configure', '--profiles', 'text,commerce');
    await bot.run('network', 'connect', org.aceId, '--profile', 'ace:commerce:1');
    await org.run('inbox');
    await bot.run('inbox');
    await bot.run('send', org.aceId, 'ace:commerce:rfq:1', JSON.stringify({ need: 'translate "hi" to German' }), '--thread', 'order-1')
      .catch(async (e) => { throw new Error(`rfq refused: ${e.message}`); });
    await org.run('inbox');
    const threads = await org.run('threads');
    expect(threads.threads).toMatchObject([{ peer: bot.aceId, threadId: 'order-1', state: 'requested' }]);
  });
});
