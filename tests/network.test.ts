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
  it('configure publishes card, visibility, handle, profiles and ERC-8004 bindings; discover and lookup find them', async () => {
    const relay = new FakeRelay();
    const alice = await makeHome(ROOT, 'cfg-alice', relay);
    const bob = await makeHome(ROOT, 'cfg-bob', relay);
    const registry = 'eip155:8453:0x8004a169fb4a3325136eb29fa0ceb6d2e539a432';
    const published = await alice.run('network', 'configure', '--visibility', 'public', '--handle', 'alice', '--name', 'Alice',
      '--tags', 'translation,legal', '--profiles', 'text,commerce', '--erc8004', `${registry}:42`,
      '--ext', JSON.stringify({ 'ace:commerce:1': { settlement: [{ method: 'stripe-link' }] } }));
    expect(published).toMatchObject({ aceId: alice.aceId, visibility: 'public', handle: 'alice', card: { name: 'Alice', tags: ['translation', 'legal'] },
      profiles: [{ id: 'ace:text:1' }, { id: 'ace:commerce:1' }], erc8004: [{ agentRegistry: registry, agentId: '42' }] });
    expect(relay.descriptors.get(alice.aceId)!.descriptor.ext).toEqual({ 'ace:commerce:1': { settlement: [{ method: 'stripe-link' }] } });

    // a second publish neither re-registers the unchanged log nor fails
    const before = relay.registrations;
    await alice.run('network', 'publish');
    expect(relay.registrations).toBe(before);

    expect((await bob.run('network', 'discover', '--profile', 'ace:commerce:1')).agents.map((a: { aceId: string }) => a.aceId)).toEqual([alice.aceId]);
    expect((await bob.run('network', 'lookup', '@alice@relay.test')).agent.aceId).toBe(alice.aceId);

    // invalid settings are refused and never saved
    await expect(alice.run('network', 'configure', '--erc8004', 'not-a-binding')).rejects.toThrow(/erc8004/);
    await expect(alice.run('network', 'configure', '--visibility', 'private')).rejects.toThrow(/handle/);
    await expect(alice.run('network', 'configure', '--ext', JSON.stringify({ 'urn:x:1': {} }))).rejects.toMatchObject({ code: 'invalid_authorization' });
    expect(JSON.parse(await readFile(join(alice.dir, 'network.json'), 'utf8')).ext).toEqual({ 'ace:commerce:1': { settlement: [{ method: 'stripe-link' }] } });
    const cleared = await alice.run('network', 'configure', '--erc8004', '');
    expect(cleared.erc8004).toBeUndefined();
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
    await alice.run('network', 'configure', '--visibility', 'public', '--handle', 'alice');
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

  it('private pairing through an invitation', async () => {
    const relay = new FakeRelay();
    const carol = await makeHome(ROOT, 'pair-carol', relay);
    const dave = await makeHome(ROOT, 'pair-dave', relay);
    const daveFile = join(dave.dir, 'dave.json');
    await dave.run('network', 'publish', '--out', daveFile);
    await expect(carol.run('network', 'invite', dave.aceId)).rejects.toThrow(/share its descriptor/);
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

    await org.run('network', 'configure', '--visibility', 'public', '--profiles', 'text,commerce', '--accept-profiles', 'ace:commerce:1');
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
