import { execFile, spawn } from 'node:child_process';
import { platform } from 'node:os';

export interface OSKeyStore {
  save(service: string, account: string, secret: string): Promise<void>;
  load(service: string, account: string): Promise<string | null>;
  delete(service: string, account: string): Promise<void>;
}

function execFileAsync(
  cmd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr }));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

function spawnWithStdin(
  cmd: string,
  args: string[],
  stdinData: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${cmd} exited with code ${code}: ${stderr}`));
      }
    });
    child.stdin.write(stdinData);
    child.stdin.end();
  });
}

/** Keystore secrets are Base64 (they travel through command interpreters on stdin). */
const SECRET_RE = /^[A-Za-z0-9+/=]{1,256}$/;

function checkSecret(secret: string): void {
  if (!SECRET_RE.test(secret)) throw new Error('Keystore secret must be Base64');
}

/**
 * Service / account names are interpolated into command scripts (`security -i`
 * stdin, PowerShell): strict whitelist, no whitespace, quotes or metacharacters.
 */
export function isSafeKeystoreName(name: string): boolean {
  return /^[\w.:/-]+$/.test(name);
}

function checkName(name: string): string {
  if (!isSafeKeystoreName(name)) {
    throw new Error('Invalid characters in keystore name: only alphanumeric, hyphen, underscore, dot, colon, slash allowed');
  }
  return name;
}

function createMacOSKeyStore(): OSKeyStore {
  const store: OSKeyStore = {
    async save(service, account, secret) {
      checkSecret(secret);
      checkName(service);
      checkName(account);
      // `security -i` reads the command from stdin, so the secret never appears in
      // argv (visible to every user via `ps`). Interactive mode exits 0 even when a
      // command fails, so read the entry back to confirm it was stored.
      await spawnWithStdin('security', ['-i'],
        `add-generic-password -U -s ${service} -a ${account} -w ${secret}\n`);
      if (await store.load(service, account) !== secret) {
        throw new Error('Failed to store the master key in the macOS keychain');
      }
    },

    async load(service, account) {
      try {
        const { stdout } = await execFileAsync('security', [
          'find-generic-password',
          '-s', service,
          '-a', account,
          '-w',
        ]);
        return stdout.replace(/\n$/, '');
      } catch {
        return null;
      }
    },

    async delete(service, account) {
      try {
        await execFileAsync('security', [
          'delete-generic-password',
          '-s', service,
          '-a', account,
        ]);
      } catch {
        // Ignore errors (key may not exist)
      }
    },
  };
  return store;
}

function createLinuxKeyStore(): OSKeyStore {
  return {
    async save(service, account, secret) {
      await spawnWithStdin('secret-tool', [
        'store',
        '--label', service,
        'service', service,
        'account', account,
      ], secret);
    },

    async load(service, account) {
      try {
        const { stdout } = await execFileAsync('secret-tool', [
          'lookup',
          'service', service,
          'account', account,
        ]);
        if (stdout === '') return null;
        return stdout;
      } catch {
        return null;
      }
    },

    async delete(service, account) {
      try {
        await execFileAsync('secret-tool', [
          'clear',
          'service', service,
          'account', account,
        ]);
      } catch {
        // Ignore errors (key may not exist)
      }
    },
  };
}

const escapePowerShell = checkName;

function credReadScript(target: string): string {
  const safe = escapePowerShell(target);
  return `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class CredManager {
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CredRead(string target, int type, int flags, out IntPtr credential);
    [DllImport("advapi32.dll")]
    public static extern void CredFree(IntPtr credential);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CREDENTIAL {
        public int Flags;
        public int Type;
        public string TargetName;
        public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public int CredentialBlobSize;
        public IntPtr CredentialBlob;
        public int Persist;
        public int AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }
}
"@
$ptr = [IntPtr]::Zero
if ([CredManager]::CredRead("${safe}", 1, 0, [ref]$ptr)) {
    $cred = [System.Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [Type][CredManager+CREDENTIAL])
    $secret = [System.Runtime.InteropServices.Marshal]::PtrToStringUni($cred.CredentialBlob, $cred.CredentialBlobSize / 2)
    [CredManager]::CredFree($ptr)
    Write-Output $secret
} else {
    exit 1
}
`;
}

const CRED_TYPES = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class CredWriter {
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CredWrite(ref CREDENTIAL credential, int flags);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CREDENTIAL {
        public int Flags;
        public int Type;
        public string TargetName;
        public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public int CredentialBlobSize;
        public IntPtr CredentialBlob;
        public int Persist;
        public int AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }
}
"@
`;

function credWriteScript(target: string, user: string): string {
  const safeTarget = escapePowerShell(target);
  const safeUser = escapePowerShell(user);
  return `${CRED_TYPES}
$secret = [Console]::In.ReadLine()
if (-not $secret) { exit 1 }
$blob = [System.Runtime.InteropServices.Marshal]::StringToCoTaskMemUni($secret)
try {
    $cred = New-Object CredWriter+CREDENTIAL
    $cred.Type = 1
    $cred.TargetName = "${safeTarget}"
    $cred.UserName = "${safeUser}"
    $cred.CredentialBlobSize = $secret.Length * 2
    $cred.CredentialBlob = $blob
    $cred.Persist = 2
    if (-not [CredWriter]::CredWrite([ref]$cred, 0)) { exit 1 }
} finally {
    [System.Runtime.InteropServices.Marshal]::ZeroFreeCoTaskMemUnicode($blob)
}
`;
}

function createWindowsKeyStore(): OSKeyStore {
  function credTarget(service: string, account: string): string {
    return `${service}:${account}`;
  }

  return {
    async save(service, account, secret) {
      checkSecret(secret);
      // `cmdkey /pass:<secret>` would put the secret in argv (visible to other
      // processes); CredWrite via PowerShell reads it from stdin instead.
      await spawnWithStdin('powershell', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        credWriteScript(credTarget(service, account), account),
      ], `${secret}\n`);
    },

    async load(service, account) {
      try {
        const { stdout } = await execFileAsync('powershell', [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          credReadScript(credTarget(service, account)),
        ]);
        return stdout.replace(/\r?\n$/, '');
      } catch {
        return null;
      }
    },

    async delete(service, account) {
      try {
        await execFileAsync('cmdkey', [
          `/delete:${credTarget(service, account)}`,
        ]);
      } catch {
        // Ignore errors (key may not exist)
      }
    },
  };
}

export function createKeyStore(): OSKeyStore {
  const os = platform();
  switch (os) {
    case 'darwin':
      return createMacOSKeyStore();
    case 'linux':
      return createLinuxKeyStore();
    case 'win32':
      return createWindowsKeyStore();
    default:
      throw new Error(
        `Unsupported platform "${os}". Set the ACE_IDENTITY_KEY environment variable instead.`,
      );
  }
}
