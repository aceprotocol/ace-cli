import { createInterface } from 'node:readline';
import { isatty } from 'node:tty';

const CONFIRM_SUFFIX_LEN = 5;
const COUNTDOWN_SECONDS = 5;

/**
 * Throw unless this is an interactive TTY. Destroying or resetting keys must be done by a person at a terminal,
 * never by a script.
 */
export function requireTTY(isTTY: boolean = isatty(0)): void {
  if (!isTTY) {
    throw new Error(
      'This operation requires an interactive terminal (TTY). ' +
      'Key destruction cannot be performed in scripts or piped input.',
    );
  }
}

/**
 * A confirmation word derived from the ACE ID suffix, so the prompt cannot be answered by blind copy and paste.
 */
export function buildConfirmWord(aceId: string | null): string {
  if (aceId !== null && aceId.length >= CONFIRM_SUFFIX_LEN + 1) {
    return `destroy-${aceId.slice(-CONFIRM_SUFFIX_LEN)}`;
  }
  return 'destroy';
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** What replaces the current identity: an imported one (`ace init --import`) or a recovered one (`ace key recover`). */
export type Replacement = { importing: string } | { recovering: string };

/**
 * The reset prompt: the current identity and what will happen (`replacement`: an imported or recovered identity
 * replaces it instead of a newly generated one).
 */
export function resetNotice(aceId: string | null, unreadableReason?: string, replacement?: Replacement): string {
  const then = replacement === undefined
    ? ['A new identity will be generated', 'All peers must re-discover your new identity']
    : 'recovering' in replacement
    ? [
      `The recovered identity replaces it: ${replacement.recovering}`,
      'Its root moves to the next-root file\'s key and it is registered on the relay; every earlier delegation is revoked',
    ]
    : [
      `The imported identity replaces it: ${replacement.importing}`,
      'It is re-keyed and registered on the relay; the previous custodian\'s keys stop being current',
    ];
  const steps = ['Your current identity key will be permanently deleted', ...then];
  return '\n' +
    '  IDENTITY RESET — THIS CANNOT BE UNDONE\n' +
    '\n' +
    (aceId !== null
      ? `  ACE ID: ${aceId}\n`
      : `  ACE ID: unknown (existing identity is unreadable: ${unreadableReason ?? 'unknown error'})\n`) +
    '\n' +
    '  What will happen:\n' +
    steps.map((step, i) => `    ${i + 1}. ${step}\n`).join('') +
    '\n';
}

/**
 * The full TTY confirmation:
 * 1. check for a TTY
 * 2. show the warning and the current identity
 * 3. ask for the confirmation word
 * 4. count down
 */
export async function confirmKeyDestruction(
  aceId: string | null, unreadableReason?: string, replacement?: Replacement,
): Promise<void> {
  requireTTY();

  const confirmWord = buildConfirmWord(aceId);

  process.stderr.write(resetNotice(aceId, unreadableReason, replacement) + `  Type '${confirmWord}' to confirm: `);

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise<string>(resolve => {
    rl.question('', (ans) => { rl.close(); resolve(ans.trim()); });
  });

  if (answer !== confirmWord) {
    throw new Error('Identity reset aborted.');
  }

  // Countdown: the last chance to change your mind
  process.stderr.write('\nDestruction begins in: ');
  for (let i = COUNTDOWN_SECONDS; i >= 1; i--) {
    process.stderr.write(`${i}... `);
    await sleep(1000);
  }
  process.stderr.write('\n');
}
