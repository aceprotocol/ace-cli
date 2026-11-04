import { platform } from 'node:os';
import { execFileSync } from 'node:child_process';

export type KeystoreMode = 'auto' | 'os' | 'file' | 'env';
export type ResolvedKeystoreMode = Exclude<KeystoreMode, 'auto'>;

export const RESOLVED_KEYSTORE_MODES: ReadonlySet<unknown> = new Set<ResolvedKeystoreMode>(['os', 'file', 'env']);
const MODES: ReadonlySet<unknown> = new Set(['auto', ...RESOLVED_KEYSTORE_MODES]);

export interface KeystoreProbe { platform: string; hasSecretTool(): boolean }

function defaultProbe(): KeystoreProbe {
  return {
    platform: platform(),
    hasSecretTool() {
      try { execFileSync('sh', ['-c', 'command -v secret-tool'], { stdio: 'ignore' }); return true; } catch { return false; }
    },
  };
}

/**
 * Which store holds the master key. `ACE_IDENTITY_KEY` set → env, always. Otherwise the request
 * (flag, then ACE_KEYSTORE, then auto). `auto` prefers the OS keystore where one is usable.
 */
export function resolveKeystoreMode(requested: KeystoreMode | undefined, env: NodeJS.ProcessEnv, probe: KeystoreProbe = defaultProbe()): ResolvedKeystoreMode {
  if (env.ACE_IDENTITY_KEY) return 'env';
  let mode: string | undefined = requested ?? (env.ACE_KEYSTORE?.trim() || undefined);
  if (mode !== undefined && !MODES.has(mode)) throw new Error(`ACE_KEYSTORE / --keystore must be one of auto, os, file, env (got "${mode}")`);
  mode ??= 'auto';
  if (mode === 'env') throw new Error('keystore mode "env" requires ACE_IDENTITY_KEY to be set');
  if (mode !== 'auto') return mode as ResolvedKeystoreMode;
  if (probe.platform === 'darwin' || probe.platform === 'win32') return 'os';
  if (probe.platform === 'linux' && env.DBUS_SESSION_BUS_ADDRESS && probe.hasSecretTool()) return 'os';
  return 'file';
}
