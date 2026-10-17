import { open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { FileStore } from '@ace-protocol/sdk';
import type { OSKeyStore } from './os-keystore.js';

export const MASTER_KEY_FILE = 'master.key';

/**
 * The master key next to identity.enc, for hosts without a keystore. Permissions and ownership
 * are enforced on read, checked on the same descriptor that is read (no stat-then-open race).
 */
export function createFileKeyStore(dir: string): OSKeyStore {
  const path = join(dir, MASTER_KEY_FILE);
  return {
    async save(_service, _account, secret) {
      await new FileStore(dir).write(MASTER_KEY_FILE, new TextEncoder().encode(secret + '\n'));
    },
    async load(_service, _account) {
      let fh;
      try { fh = await open(path, 'r'); } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
      try {
        const s = await fh.stat();
        if (process.platform !== 'win32') {
          if ((s.mode & 0o077) !== 0) {
            throw new Error(`${path} is accessible to other users; set its mode to 0600 (chmod 600 "${path}")`);
          }
          const uid = process.getuid?.();
          if (uid !== undefined && s.uid !== uid) {
            throw new Error(`${path} is not owned by the current user (uid ${uid}); refusing to use it`);
          }
        }
        const text = (await fh.readFile('utf8')).trim();
        return text === '' ? null : text;
      } finally {
        await fh.close();
      }
    },
    async delete(_service, _account) {
      try { await unlink(path); } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
    },
  };
}
