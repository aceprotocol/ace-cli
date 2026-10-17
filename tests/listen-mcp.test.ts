import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { startListener } from '../src/listen.js';
import { serveMcp } from '../src/mcp.js';
import { FakeRelay, RELAY } from '@ace-protocol/sdk/testing';
import { AGENT_TOOLS } from '@ace-protocol/sdk/tools';
import { makeHome, waitFor } from './helpers/cli.js';

const ROOT = join(import.meta.dirname, '.listen');
afterAll(() => rm(ROOT, { recursive: true, force: true }));
beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });

const text = (r: unknown) => JSON.parse((r as { content: Array<{ text: string }> }).content[0].text);
const PEER = `ace:sha256:${'0'.repeat(64)}`;

/** A local MCP client over `serveMcp` (no agent needed for listing). */
async function local(allowAdmission: boolean, agent: () => never = () => { throw new Error('unused'); }) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const serving = serveMcp(agent, serverSide, { allowAdmission });
  const mcp = new Client({ name: 'test', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  await mcp.connect(clientSide);
  return { mcp, close: async () => { await mcp.close(); await serving.close(); } };
}
const networkActions = (tools: Array<{ name: string; inputSchema: { properties?: Record<string, { enum?: string[] }> } }>) =>
  tools.find((t) => t.name === 'ace_network')!.inputSchema.properties!.action.enum!;

describe('ace listen and ace mcp', () => {
  it('a resident receiver handles contacts, messages and receipts; CLI commands keep working beside it; MCP exposes the same operations', async () => {
    const relay = new FakeRelay();
    const alice = await makeHome(ROOT, 'alice', relay);
    const bob = await makeHome(ROOT, 'bob', relay);
    await alice.run('network', 'configure', '--visibility', 'public', '--handle', 'alice', '--accept-profiles', 'ace:text:1');
    await bob.run('network', 'publish');

    const listener = await startListener({ aceDir: alice.dir, fetch: relay.fetch, relay: RELAY, maintainMs: 200, retryMs: 50, log: () => {}, warn: () => {} });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const serving = serveMcp(listener.agent, serverSide);
    const mcp = new Client({ name: 'test', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    try {
      await mcp.connect(clientSide);
      expect((await mcp.listTools()).tools.map((t) => t.name).sort()).toEqual(AGENT_TOOLS.map((t) => t.name).sort());

      // contact: accepted by the resident receiver through the acceptProfiles rule
      await bob.run('network', 'connect', '@alice@relay.test', '--profile', 'ace:text:1');
      await waitFor(async () => (await alice.run('network', 'peers')).peers.some((p: { aceId: string; status: string }) => p.aceId === bob.aceId && p.status === 'admitted'));
      // alice records bob admitted before its `accepted` reply is posted (05 § Flow step 3): wait for the reply too
      await waitFor(async () => { await bob.run('inbox'); return (await bob.run('network', 'peers')).peers[0]?.status === 'admitted'; });
      expect((await bob.run('network', 'peers')).peers).toMatchObject([{ aceId: alice.aceId, status: 'admitted' }]);

      // bob → alice: received while the model is idle, read and acknowledged over MCP
      const sent = await bob.run('send', alice.aceId, 'ace:text:1', JSON.stringify({ message: 'hi alice' }));
      await waitFor(async () => text(await mcp.callTool({ name: 'ace_inbox', arguments: {} })).messages.length === 1);
      const inbox = text(await mcp.callTool({ name: 'ace_inbox', arguments: {} }));
      expect(inbox.messages[0]).toMatchObject({ from: bob.aceId, messageId: sent.messageId, body: { message: 'hi alice' } });
      // `ace inbox` beside the receiver lists without pulling
      expect((await alice.run('inbox')).messages).toHaveLength(1);
      expect(text(await mcp.callTool({ name: 'ace_inbox', arguments: { action: 'ack', messages: [{ from: bob.aceId, messageId: sent.messageId }] } }))).toEqual({ acknowledged: 1, untrusted: [] });
      await waitFor(async () => (await bob.run('inbox')).received.receipt === 1 || (await bob.run('outbox')).messages[0].status === 'delivered');
      expect((await bob.run('outbox')).messages).toMatchObject([{ messageId: sent.messageId, status: 'delivered' }]);

      // alice → bob from MCP (the listener's client) and from the CLI beside it (send-only client)
      text(await mcp.callTool({ name: 'ace_send', arguments: { to: bob.aceId, type: 'ace:text:1', body: { message: 'from mcp' } } }));
      await alice.run('send', bob.aceId, 'ace:text:1', JSON.stringify({ message: 'from cli' }));
      const got = await bob.run('inbox');
      expect(got.messages.map((m: { body: { message: string } }) => m.body.message).sort()).toEqual(['from cli', 'from mcp']);
      await waitFor(async () => text(await mcp.callTool({ name: 'ace_outbox', arguments: { action: 'list' } })).messages.every((e: { status: string }) => e.status === 'delivered'));

      const peers = text(await mcp.callTool({ name: 'ace_network', arguments: { action: 'peers' } }));
      expect(peers.peers).toMatchObject([{ aceId: bob.aceId, status: 'admitted', canSend: true }]);
      expect((await mcp.callTool({ name: 'ace_threads', arguments: {} })).isError).toBe(true);

      // settings changes are picked up by the running receiver
      await alice.run('network', 'configure', '--name', 'Alice Two');
      await waitFor(() => relay.descriptors.get(alice.aceId)!.descriptor.card.name === 'Alice Two');
      await waitFor(async () => text(await mcp.callTool({ name: 'ace_identity', arguments: {} })).card.name === 'Alice Two');

      // key changes need the receiver stopped
      await expect(alice.run('key', 'delegate')).rejects.toThrow(/stop it first/);
    } finally {
      await mcp.close();
      await serving.close();
      expect(await listener.stop()).toBe(0);
    }
  });
});

describe('ace network connect --wait', () => {
  it('receives until the peer accepts, so the first send works at once; beside a running receiver it reads the state that receiver keeps', async () => {
    const relay = new FakeRelay();
    const alice = await makeHome(ROOT, 'wait-alice', relay);
    const bob = await makeHome(ROOT, 'wait-bob', relay);
    const carol = await makeHome(ROOT, 'wait-carol', relay);
    await alice.run('network', 'configure', '--visibility', 'public', '--handle', 'alice', '--accept-profiles', 'ace:text:1');
    await bob.run('network', 'publish');
    await carol.run('network', 'publish');
    const aliceRx = await startListener({ aceDir: alice.dir, fetch: relay.fetch, relay: RELAY, maintainMs: 200, retryMs: 50, log: () => {}, warn: () => {} });
    try {
      // no receiver for bob: --wait pulls the relay itself
      expect(await bob.run('network', 'connect', '@alice@relay.test', '--profile', 'ace:text:1', '--wait', '10'))
        .toMatchObject({ aceId: alice.aceId, status: 'admitted', canSend: true, profile: 'ace:text:1' });
      await bob.run('send', alice.aceId, 'ace:text:1', JSON.stringify({ message: 'hi' }));

      // carol runs a receiver: --wait reads the admission state it keeps
      const carolRx = await startListener({ aceDir: carol.dir, fetch: relay.fetch, relay: RELAY, maintainMs: 200, retryMs: 50, log: () => {}, warn: () => {} });
      try {
        expect(await carol.run('network', 'connect', alice.aceId, '--profile', 'ace:text:1', '--wait', '10'))
          .toMatchObject({ aceId: alice.aceId, status: 'admitted', canSend: true });
      } finally { await carolRx.stop(); }
    } finally { await aliceRx.stop(); }
  });

  it('times out while the request is pending: send still fails with not_permitted and queues nothing', async () => {
    const relay = new FakeRelay();
    const alice = await makeHome(ROOT, 'wait-pending-alice', relay);
    const bob = await makeHome(ROOT, 'wait-pending-bob', relay);
    await alice.run('network', 'configure', '--visibility', 'public');
    await bob.run('network', 'publish');
    const started = Date.now();
    expect(await bob.run('network', 'connect', alice.aceId, '--profile', 'ace:text:1', '--wait', '1'))
      .toMatchObject({ aceId: alice.aceId, status: 'pending', canSend: false });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
    await expect(bob.run('send', alice.aceId, 'ace:text:1', JSON.stringify({ message: 'hi' }))).rejects.toMatchObject({ code: 'not_permitted' });
    expect((await bob.run('outbox')).messages).toEqual([]);

    // a rejection ends the wait
    const waiting = bob.run('network', 'connect', alice.aceId, '--profile', 'ace:text:1', '--wait', '10');
    await waitFor(async () => { await alice.run('inbox'); return (await alice.run('network', 'requests')).requests.length > 0; });
    await alice.run('network', 'reject', bob.aceId);
    expect(await waiting).toMatchObject({ aceId: alice.aceId, status: 'rejected', canSend: false });
  });
});

describe('ace mcp tool table', () => {
  it('local mcp lists the same tool names as hosted minus hosted-only', async () => {
    // Hosted serves AGENT_TOOLS plus its hosted-only tools; the local endpoint serves AGENT_TOOLS as they are.
    for (const allow of [false, true]) {
      const { mcp, close } = await local(allow);
      try { expect((await mcp.listTools()).tools.map((t) => t.name).sort()).toEqual(AGENT_TOOLS.map((t) => t.name).sort()); } finally { await close(); }
    }
  });

  it('admission-widening actions (ace:admission) are exposed and allowed only with --allow-admission', async () => {
    const closed = await local(false, () => { throw new Error('the agent must not be reached'); });
    try {
      const actions = networkActions((await closed.mcp.listTools()).tools as never);
      for (const a of ['invite', 'accept', 'unblock']) expect(actions).not.toContain(a);
      for (const a of ['discover', 'lookup', 'requests', 'peers', 'import', 'import_invitation', 'publish', 'connect', 'reject', 'block']) expect(actions).toContain(a);
      const refused = await closed.mcp.callTool({ name: 'ace_network', arguments: { action: 'accept', peer: PEER } });
      expect(refused).toMatchObject({ isError: true, structuredContent: { error: 'insufficient_scope' } });
    } finally { await closed.close(); }
    const open = await local(true);
    try {
      expect(networkActions((await open.mcp.listTools()).tools as never)).toEqual(expect.arrayContaining(['invite', 'accept', 'unblock']));
    } finally { await open.close(); }
  });

  it('after a signing-key change the receiver re-issues permits to admitted peers (SDK upkeep)', async () => {
    const relay = new FakeRelay();
    const alice = await makeHome(ROOT, 'rekey-alice', relay);
    const bob = await makeHome(ROOT, 'rekey-bob', relay);
    await alice.run('network', 'configure', '--visibility', 'public', '--accept-profiles', 'ace:text:1');
    await bob.run('network', 'publish');
    await bob.run('network', 'connect', alice.aceId, '--profile', 'ace:text:1');
    await alice.run('inbox');
    await bob.run('inbox');
    expect((await bob.run('network', 'peers')).peers).toMatchObject([{ aceId: alice.aceId, status: 'admitted' }]);

    const { signingSeq } = await alice.run('key', 'delegate');
    const listener = await startListener({ aceDir: alice.dir, fetch: relay.fetch, relay: RELAY, maintainMs: 200, retryMs: 50, log: () => {}, warn: () => {} });
    try {
      await waitFor(async () => (await listener.agent().client.admission.get(bob.aceId))?.issued?.seq === signingSeq);
    } finally {
      await listener.stop();
    }
  });
});
