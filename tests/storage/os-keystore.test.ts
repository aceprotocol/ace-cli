// These tests read and write the real OS keystore (macOS Keychain, Secret Service, Windows Credential Manager) under
// service "ace-cli-test". `npm test` skips them; run them on purpose with `ACE_TEST_OS_KEYSTORE=1 npm test`.
import { describe, it, expect, afterEach } from 'vitest';
import { createKeyStore, type OSKeyStore } from '../../src/storage/os-keystore.js';

const SERVICE = 'ace-cli-test';
const ACCOUNT = 'test-account';
const enabled = process.env.ACE_TEST_OS_KEYSTORE === '1';
const store: OSKeyStore = enabled ? createKeyStore() : null as never;

describe.skipIf(!enabled)('os-keystore (real OS keystore; ACE_TEST_OS_KEYSTORE=1)', () => {
  afterEach(async () => {
    await store.delete(SERVICE, ACCOUNT);
  });

  it('save + load round-trip', async () => {
    const secret = Buffer.from('my-super-secret-value-12345').toString('base64');
    await store.save(SERVICE, ACCOUNT, secret);
    expect(await store.load(SERVICE, ACCOUNT)).toBe(secret);
  });

  it('save overwrites an existing entry', async () => {
    await store.save(SERVICE, ACCOUNT, 'Zmlyc3Q=');
    await store.save(SERVICE, ACCOUNT, 'c2Vjb25k');
    expect(await store.load(SERVICE, ACCOUNT)).toBe('c2Vjb25k');
  });

  it('refuses a secret that is not Base64 (it travels through a command interpreter)', async () => {
    await expect(store.save(SERVICE, ACCOUNT, 'x -w y\ndelete-keychain')).rejects.toThrow('Base64');
  });

  it('load returns null for missing key', async () => {
    expect(await store.load(SERVICE, 'nonexistent-account-xyz')).toBeNull();
  });

  it('delete removes stored key', async () => {
    await store.save(SERVICE, ACCOUNT, 'dG8tYmUtZGVsZXRlZA==');
    await store.delete(SERVICE, ACCOUNT);
    expect(await store.load(SERVICE, ACCOUNT)).toBeNull();
  });
});
