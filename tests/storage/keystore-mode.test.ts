import { describe, expect, it } from 'vitest';
import { resolveKeystoreMode } from '../../src/storage/keystore-mode.js';

const probe = (platform: string, secretTool = false) => ({ platform, hasSecretTool: () => secretTool });

describe('resolveKeystoreMode', () => {
  it('env wins whenever ACE_IDENTITY_KEY is set', () => {
    expect(resolveKeystoreMode('auto', { ACE_IDENTITY_KEY: 'x' }, probe('linux'))).toBe('env');
    expect(resolveKeystoreMode('os', { ACE_IDENTITY_KEY: 'x' }, probe('darwin'))).toBe('env');
  });
  it('auto: os on macOS and Windows, os on Linux with secret-tool + DBus, else file', () => {
    expect(resolveKeystoreMode('auto', {}, probe('darwin'))).toBe('os');
    expect(resolveKeystoreMode('auto', {}, probe('win32'))).toBe('os');
    expect(resolveKeystoreMode('auto', { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/x' }, probe('linux', true))).toBe('os');
    expect(resolveKeystoreMode('auto', {}, probe('linux', true))).toBe('file');
    expect(resolveKeystoreMode('auto', { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/x' }, probe('linux', false))).toBe('file');
    expect(resolveKeystoreMode('auto', {}, probe('freebsd'))).toBe('file');
  });
  it('explicit modes are honoured; env without the variable is an error', () => {
    expect(resolveKeystoreMode('file', {}, probe('darwin'))).toBe('file');
    expect(resolveKeystoreMode('os', {}, probe('linux'))).toBe('os');
    expect(() => resolveKeystoreMode('env', {}, probe('linux'))).toThrow('ACE_IDENTITY_KEY');
  });
  it('ACE_KEYSTORE env stands in for the flag', () => {
    expect(resolveKeystoreMode(undefined, { ACE_KEYSTORE: 'file' }, probe('darwin'))).toBe('file');
    expect(() => resolveKeystoreMode(undefined, { ACE_KEYSTORE: 'bogus' }, probe('darwin'))).toThrow('ACE_KEYSTORE');
  });
});
