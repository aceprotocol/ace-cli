/**
 * The CLI's network operations. Every command with an agent-tool equivalent runs the SDK tool table
 * (`@ace-protocol/sdk/tools`): the same operations and result shapes as the local `ace mcp` and the hosted MCP tools.
 * Only the inbox drain (the CLI pulls when no receiver runs), waiting for a contact answer and the profile listing are
 * CLI-specific.
 */
import { ACEError, BUNDLED_MANIFESTS, MAX_INBOX_PAGE, ProfileSet, type JSONObject, type ReceiveOutcome } from '@ace-protocol/sdk';
import { setTimeout as sleep } from 'node:timers/promises';
import { AGENT_TOOLS, manifestView } from '@ace-protocol/sdk/tools';
import type { Agent } from './context.js';
import { BUNDLED_PROFILES, installedManifests, resolveProfiles, type NetworkSettings } from './storage/config.js';

const TABLE = new Map(AGENT_TOOLS.map((t) => [t.name, t]));

/** Run agent tool `name` as this agent (the CLI is the owner: no scope applies) and return its result data. */
export async function tool(a: Agent, name: string, args: JSONObject = {}): Promise<Record<string, unknown>> {
  return (await TABLE.get(name)!.run(a.client, args)).data as Record<string, unknown>;
}

/** A directory entry as printed: who it is and what its card says (`lookup` its aceId for the rest). */
interface CardEntry { aceId: string; address?: string; card: { description?: string; tags?: string[] } }

/**
 * `ace network discover`: the directory page through `ace_network` discover, each entry cut to its handle address,
 * description, tags and ACE ID. The description and tags are what the agent wrote about itself.
 */
export async function discover(a: Agent, args: JSONObject) {
  const page = await tool(a, 'ace_network', { ...args, action: 'discover' }) as { cards: CardEntry[]; cursor: string | null };
  const cards = page.cards.map((c) => ({
    aceId: c.aceId, ...(c.address ? { address: c.address } : {}),
    ...(c.card.description !== undefined ? { description: c.card.description } : {}), ...(c.card.tags ? { tags: c.card.tags } : {}),
  }));
  return { cards, cursor: page.cursor, untrusted: ['cards[].description', 'cards[].tags'] };
}

/** Pull every waiting relay page (receive side only). */
export async function drain(a: Agent) {
  const counts: Record<ReceiveOutcome['kind'], number> = { delivered: 0, duplicate: 0, rejected: 0, receipt: 0, contact: 0, dropped: 0, deferred: 0 };
  for (let page = 0; page < 50; page++) {
    const outcomes = await a.client.pull({ limit: MAX_INBOX_PAGE });
    for (const o of outcomes) counts[o.kind]++;
    if (outcomes.length === 0 || outcomes.some((o) => o.kind === 'deferred')) break;
  }
  return counts;
}

/** How often `awaitAnswer` looks again. */
const ANSWER_POLL_MS = 1000;

/**
 * Until `peer` answers our contact request or `ms` pass: pull the relay when `receiving` (else a running receiver
 * does), then read the admission table. `admitted` with `canSend`: `ace send` works now; `rejected`: the request was
 * declined (the record is gone); `pending`: no answer yet. Sending stays the separate, permit-checked step.
 */
export async function awaitAnswer(a: Agent, peer: string, receiving: boolean, ms: number) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (receiving) {
      try { await drain(a); } catch (err) { if (!(err instanceof ACEError && err.isTransient)) throw err; }
    }
    const { peers } = await tool(a, 'ace_network', { action: 'peers' }) as { peers: Array<{ aceId: string; status: string; canSend: boolean }> };
    const p = peers.find((e) => e.aceId === peer);
    const answer = { status: p?.status ?? 'rejected', canSend: p?.canSend ?? false };
    if (answer.status !== 'pending' || Date.now() >= deadline) return answer;
    await sleep(Math.min(ANSWER_POLL_MS, deadline - Date.now()));
  }
}

/** Installed profiles (descriptor `profiles`) with message digests, and every profile available to install. */
export async function profiles(aceDir: string, s: NetworkSettings) {
  const [resolved, installed] = await Promise.all([resolveProfiles(aceDir, s), installedManifests(aceDir)]);
  const set = new ProfileSet(resolved);
  const available = [...BUNDLED_PROFILES, ...installed.map((m) => m.id)];
  return { installed: set.manifests().map(manifestView), core: manifestView(BUNDLED_MANIFESTS.core), available, acceptProfiles: s.acceptProfiles };
}
