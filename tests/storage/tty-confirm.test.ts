import { describe, it, expect } from 'vitest';
import { requireTTY, buildConfirmWord, resetNotice } from '../../src/storage/tty-confirm.js';

describe('tty-confirm', () => {
  describe('requireTTY', () => {
    it('throws when stdin is not a TTY', () => {
      expect(() => requireTTY(false)).toThrow('requires an interactive terminal');
    });

    it('does not throw when stdin is a TTY', () => {
      expect(() => requireTTY(true)).not.toThrow();
    });
  });

  describe('buildConfirmWord', () => {
    it('returns destroy-{suffix} for valid ACE ID', () => {
      const aceId = 'ace:sha256:abcdef1234567890';
      const word = buildConfirmWord(aceId);
      expect(word).toBe('destroy-67890');
    });

    it('returns "destroy" for short ACE ID', () => {
      const word = buildConfirmWord('ace:x');
      expect(word).toBe('destroy');
    });
  });
});

describe('buildConfirmWord for an unreadable identity', () => {
  it('falls back to "destroy" when the ACE ID is unknown', () => {
    expect(buildConfirmWord(null)).toBe('destroy');
  });
});

describe('resetNotice', () => {
  it('a reset says a new identity is generated and peers must re-discover it', () => {
    const text = resetNotice('ace:sha256:abcdef1234567890', undefined);
    expect(text).toContain('A new identity will be generated');
    expect(text).toContain('All peers must re-discover your new identity');
  });

  it('an import names the imported identity and promises no new one', () => {
    const text = resetNotice('ace:sha256:abcdef1234567890', undefined, { importing: 'ace:sha256:feed' });
    expect(text).toContain('Your current identity key will be permanently deleted');
    expect(text).toContain('The imported identity replaces it: ace:sha256:feed');
    expect(text).not.toContain('new identity will be generated');
    expect(text).not.toContain('re-discover');
  });

  it('a recovery names the recovered identity and promises no new one', () => {
    const text = resetNotice('ace:sha256:abcdef1234567890', undefined, { recovering: 'ace:sha256:feed' });
    expect(text).toContain('Your current identity key will be permanently deleted');
    expect(text).toContain('The recovered identity replaces it: ace:sha256:feed');
    expect(text).toContain('recover');
    expect(text).not.toContain('new identity');
    expect(text).not.toContain('re-discover');
  });
});
