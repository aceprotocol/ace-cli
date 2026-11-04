import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

/**
 * Read and parse a small JSON file given on the command line (`flag` names the option in errors).
 * Errors name the file, never its contents: JSON.parse messages can quote the input, so they are
 * not chained.
 */
export async function readBoundedJson(flag: string, file: string, maxBytes: number): Promise<unknown> {
  const cannotRead = (err: unknown) =>
    new Error(`${flag}: cannot read ${file} (${(err as NodeJS.ErrnoException).code ?? 'error'})`);
  let fh;
  try {
    // O_NONBLOCK: opening a FIFO must not wait for a writer (it is then refused as not a regular file).
    fh = await open(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch (err) {
    throw cannotRead(err);
  }
  // Bounded read: a file that reports a smaller size, or grows after the stat, is still capped.
  const buf = Buffer.alloc(maxBytes + 1);
  let n = 0;
  let failed = false;
  try {
    // Checked on the descriptor that is read: no FIFO/device/directory.
    const s = await fh.stat().catch((err: unknown) => { throw cannotRead(err); });
    if (!s.isFile()) throw new Error(`${flag}: ${file} is not a regular file`);
    while (n < buf.length) {
      const { bytesRead } = await fh.read(buf, n, buf.length - n, n).catch((err: unknown) => { throw cannotRead(err); });
      if (bytesRead === 0) break;
      n += bytesRead;
    }
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    // A close failure never masks the error that is already on its way out.
    await fh.close().catch((err: unknown) => { if (!failed) throw cannotRead(err); });
  }
  if (n > maxBytes) throw new Error(`${flag}: ${file} exceeds ${maxBytes / 1024} KiB`);
  try {
    return JSON.parse(buf.subarray(0, n).toString('utf8'));
  } catch {
    throw new Error(`${flag}: ${file} is not valid JSON`);
  }
}
