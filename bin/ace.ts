#!/usr/bin/env node
import { main } from '../src/index.js';

process.exit(await main(process.argv));
