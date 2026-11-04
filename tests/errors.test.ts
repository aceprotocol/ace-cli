import { describe, expect, it } from 'vitest';
import { ACEError } from '@ace-protocol/sdk';
import { describeError, safeText, errorResult } from '../src/errors.js';

describe('describeError', () => {
  it('escapes control and bidi characters from remote text; SDK errors stay on one line', () => {
    const relayText = new ACEError('relay_rejected', 'HTTP 400 x: \u001b[31mred\u001b[0m\nfake line‮');
    expect(describeError(relayText)).toBe('relay_rejected: HTTP 400 x: \\u{1b}[31mred\\u{1b}[0m\\u{a}fake line\\u{202e}');
    // a CLI-composed error keeps its line breaks
    expect(describeError(new Error('first\nRetry with: ace outbox retry x\u0007'))).toBe('first\nRetry with: ace outbox retry x\\u{7}');
    expect(describeError('plain\r')).toBe('plain\\u{d}');
    expect(safeText('ok é 日本')).toBe('ok é 日本');
  });
});

it('reports the innermost ACE code through CLI wrappers', () => {
  const cause = new ACEError('receiver_capacity', 'full', { retryAfterSeconds: 30 });
  const wrapped = new Error('could not deliver', { cause });
  expect(errorResult(wrapped)).toMatchObject({ ok: false, error: 'receiver_capacity', retryable: true, retryAfterSeconds: 30 });
  expect(errorResult(new ACEError('invalid_signature', 'rejected'))).toMatchObject({ retryable: false, error: 'invalid_signature' });
  expect(errorResult(new Error('plain'))).toMatchObject({ error: 'command_failed', retryable: false });
});
