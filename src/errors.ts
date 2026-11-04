// Control characters (C0 except LF, DEL, C1) and bidi overrides / isolates: never printed raw.
const UNSAFE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;

/**
 * Text for the terminal: control and bidi-control characters are escaped as `\u{…}`, so text
 * that came from a peer or a relay (error messages, codes) cannot move the cursor, recolor or
 * reorder the output. `multiline` keeps LF (CLI-composed hints); otherwise LF is escaped too.
 */
export function safeText(s: string, multiline = false): string {
  const out = s.replace(UNSAFE, (c) => `\\u{${c.charCodeAt(0).toString(16)}}`);
  return multiline ? out : out.replace(/\n/g, '\\u{a}');
}

/**
 * One-line description of an error for CLI output (dependency-free: loaded at startup). An SDK
 * error (it has a `code`) may carry remote text and is single-line; a CLI-composed error keeps
 * its line breaks. Either way control characters are escaped.
 */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return safeText(String(err));
  return safeText(err.message, !('code' in err));
}

/** Stable machine-readable failure (one JSON line on stderr); `message` is for humans. */
export function errorResult(error: unknown) {
  const outer = error instanceof Error ? error : new Error(String(error));
  let source: Error & { code?: unknown; isTransient?: boolean; retryAfterSeconds?: number } = outer;
  for (let depth = 0; depth < 8 && typeof source.code !== 'string' && source.cause instanceof Error; depth++) source = source.cause;
  const code = typeof source.code === 'string' && /^[a-z0-9_]{1,64}$/.test(source.code) ? source.code : 'command_failed';
  return {
    ok: false, error: code, message: describeError(outer), retryable: source.isTransient ?? false,
    ...(source.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: source.retryAfterSeconds }),
  };
}
