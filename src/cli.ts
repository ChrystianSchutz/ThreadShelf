#!/usr/bin/env tsx
import { parseFile } from './parser.js';
import { invocation } from './paths.js';

const file = process.argv[2];
if (!file) {
  console.error(`Usage: ${invocation('parse')} <file> -- [--no-user] [--no-thinking] [--no-ai]`);
  process.exit(1);
}

const options = {
  includeUser: !process.argv.includes('--no-user'),
  includeThinking: !process.argv.includes('--no-thinking'),
  includeAi: !process.argv.includes('--no-ai'),
};

try {
  const result = await parseFile(file, options);
  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }
  console.log(JSON.stringify(result.turns, null, 2));
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
