import type { ACEStore } from '@ace-protocol/sdk';
import type { KeyRing } from './keychain.js';

/**
 * An ACEStore whose values are sealed with the keystore's `state` key (the key name is the associated data, so files
 * cannot be swapped). Message history, outbox content, contact notes and thread state are therefore encrypted at
 * rest; keys (SDK-hashed names) and locks pass through.
 */
export class SealedStore implements ACEStore {
  constructor(readonly inner: ACEStore, readonly ring: KeyRing) {}
  async read(key: string): Promise<Uint8Array | null> {
    const raw = await this.inner.read(key);
    return raw === null ? null : this.ring.open('state', raw, key);
  }
  write(key: string, value: Uint8Array): Promise<void> { return this.inner.write(key, this.ring.seal('state', value, key)); }
  delete(key: string): Promise<void> { return this.inner.delete(key); }
  list(prefix: string): Promise<string[]> { return this.inner.list(prefix); }
  lock(name: string, opts?: { timeoutMs?: number }): Promise<() => Promise<void>> { return this.inner.lock(name, opts); }
}

