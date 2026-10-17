// fixtures/cli-schema.json is generated from the real command tree: `npm run cli-schema` rewrites it.
import { expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Command } from 'commander';
import { buildProgram } from '../src/index.js';

interface Node { name: string; description: string; arguments: string[]; options: Array<{ flags: string; description: string }>; commands: Node[] }

const tree = (c: Command): Node => ({
  name: c.name(), description: c.description(),
  arguments: c.registeredArguments.map((a) => (a.required ? `<${a.name()}>` : `[${a.name()}]`)),
  options: c.options.map((o) => ({ flags: o.flags, description: o.description })),
  commands: c.commands.map(tree),
});

it('fixtures/cli-schema.json matches the command tree', async () => {
  const file = join(import.meta.dirname, '..', 'fixtures', 'cli-schema.json');
  const actual = `${JSON.stringify(tree(buildProgram()), null, 2)}\n`;
  if (process.env.UPDATE_CLI_SCHEMA === '1') await writeFile(file, actual);
  expect(await readFile(file, 'utf8')).toBe(actual);
});
