import { describe, expect, it } from 'vitest';
import { resolveRelayUrl } from '../src/storage/config.js';

describe('resolveRelayUrl', () => {
  it('normalizes, refuses http:// without the opt-in and admits it only to a loopback host', () => {
    expect(resolveRelayUrl({ relay: 'HTTPS://Relay.Example:443/' }, null)).toBe('https://relay.example');
    expect(() => resolveRelayUrl({ relay: 'http://127.0.0.1:8080' }, null)).toThrow(/Insecure relay URL rejected/);
    expect(resolveRelayUrl({ relay: 'http://127.0.0.1:8080/', allowInsecureRelay: true }, null)).toBe('http://127.0.0.1:8080');
    expect(() => resolveRelayUrl({ relay: 'http://relay.example', allowInsecureRelay: true }, null)).toThrow(/only to localhost/);
  });
});
