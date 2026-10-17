/**
 * The resident receiver (`ace listen`, and the background of `ace mcp`): follows the home relay (each packet is
 * processed, receipted and acknowledged by the SDK Inbox), and every `maintainMs` runs the SDK upkeep (descriptor and
 * prekey renewal, fresh permits after a signing-key change, due Outbox retries) and reloads when network.json changes.
 */
import { ACEError, type ReceiveOutcome } from '@ace-protocol/sdk';
import { setTimeout as sleep } from 'node:timers/promises';
import { aceDirOf, openAgent, type Agent, type CommonOptions } from './context.js';
import { describeError, safeText } from './errors.js';
import { settingsFingerprint } from './storage/config.js';

export interface ListenOptions extends CommonOptions {
  log?: (line: string) => void;
  warn?: (line: string) => void;
  /** Upkeep interval (default 60 s). */
  maintainMs?: number;
  /** Pause after back-pressure or a transient failure (default 30 s). */
  retryMs?: number;
}

export interface Listener {
  aceId: string;
  /** The live agent (replaced on reload). */
  agent(): Agent;
  stop(): Promise<number>;
  /** Exit code once stopped: 0 on request, 1 on a fatal error. */
  done: Promise<number>;
}

const pause = (ms: number, signal: AbortSignal) => sleep(ms, undefined, { signal }).catch(() => undefined);

export async function startListener(o: ListenOptions = {}): Promise<Listener> {
  const log = o.log ?? ((l: string) => console.error(l));
  const warn = o.warn ?? ((l: string) => console.error(l));
  const aceDir = aceDirOf(o);
  const stopped = new AbortController();

  const report = (out: ReceiveOutcome) => {
    switch (out.kind) {
      case 'delivered': log(`[inbox] ${safeText(out.message.type)} from ${out.message.from} (${out.message.messageId})`); break;
      case 'receipt': log(`[receipt] ${out.body.outcome}${out.body.code ? `:${out.body.code}` : ''} for ${out.body.messageId}`); break;
      case 'contact': log(`[contact] ${out.event.body.kind} for ${safeText(out.event.body.profile)} from ${out.event.from}`); break;
      case 'rejected': warn(`[inbox] rejected ${out.messageId} from ${out.from}: ${describeError(out.error)}`); break;
      case 'dropped': case 'deferred': warn(`[inbox] ${out.kind}: ${describeError(out.error)}`); break;
      default: break;
    }
  };

  const open = async () => {
    const fingerprint = await settingsFingerprint(aceDir);
    const a = await openAgent(o, 'receive');
    try { await a.client.maintain(); } catch (err) { warn(`[network] ${describeError(err)}`); }
    return { a, fingerprint };
  };

  let gen = await open();
  log(`Listening as ${gen.a.identity.getACEId()} on ${gen.a.client.relay.baseUrl}`);

  const run = async (): Promise<number> => {
    while (!stopped.signal.aborted) {
      const g = new AbortController();
      const onStop = () => g.abort();
      stopped.signal.addEventListener('abort', onStop, { once: true });
      let reload = false, fatal = false;
      const upkeep = (async () => {
        while (!g.signal.aborted) {
          await pause(o.maintainMs ?? 60_000, g.signal);
          if (g.signal.aborted) return;
          try {
            if (await settingsFingerprint(aceDir) !== gen.fingerprint) { reload = true; g.abort(); return; }
            await gen.a.client.maintain();
          } catch (err) { warn(`[network] ${describeError(err)}`); }
        }
      })();
      try {
        for await (const out of gen.a.client.follow({ signal: g.signal })) report(out);
        if (!g.signal.aborted) await pause(o.retryMs ?? 30_000, g.signal); // back-pressure: the message stays on the relay
      } catch (err) {
        if (!g.signal.aborted) {
          warn(`[listen] ${describeError(err)}`);
          if (err instanceof ACEError && err.isTransient) await pause(o.retryMs ?? 30_000, g.signal);
          else fatal = true;
        }
      } finally {
        g.abort();
        stopped.signal.removeEventListener('abort', onStop);
        await upkeep;
      }
      if (fatal) return 1;
      if (reload && !stopped.signal.aborted) {
        await gen.a.close();
        try { gen = await open(); log('[listen] settings changed: reloaded'); } catch (err) {
          warn(`[listen] reload failed: ${describeError(err)}`);
          return 1;
        }
      }
    }
    return 0;
  };

  const done = run().finally(() => gen.a.close());
  return {
    aceId: gen.a.identity.getACEId(),
    agent: () => gen.a,
    stop: async () => { stopped.abort(); return done; },
    done,
  };
}

/** `ace listen`: run until SIGINT/SIGTERM or a fatal error. */
export async function runListen(o: ListenOptions = {}): Promise<number> {
  const listener = await startListener(o);
  const stop = () => { void listener.stop(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return listener.done;
}
