import { describe, it, expect } from 'vitest';
import { isSafeKeystoreName } from '../../src/storage/os-keystore.js';

describe('keystore name validation (interpolated into security -i / PowerShell scripts)', () => {
  it('accepts valid service:account targets', () => {
    expect(isSafeKeystoreName('ace-cli:master-key')).toBe(true);
    expect(isSafeKeystoreName('ace-cli-test:test-account')).toBe(true);
    expect(isSafeKeystoreName('service_name/sub')).toBe(true);
  });

  it.each([
    ['semicolon injection', 'ace-cli"; Remove-Item -Recurse /'],
    ['subexpression', '$(whoami)'],
    ['backtick escape', 'ace`nmalicious'],
    ['pipe', 'ace|Out-File C:\\evil.txt'],
    ['space (splits arguments)', 'ace cli'],
    ['newline (second security -i command)', 'ace\ndelete-keychain'],
    ['empty', ''],
    ['null byte', 'ace\x00evil'],
  ])('rejects %s', (_name, value) => {
    expect(isSafeKeystoreName(value)).toBe(false);
  });
});
