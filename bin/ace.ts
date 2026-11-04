#!/usr/bin/env node
import { exit, main } from '../src/index.js';

await exit(await main(process.argv));
