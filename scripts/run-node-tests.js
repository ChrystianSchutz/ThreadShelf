#!/usr/bin/env node

/**
 * Runs the node:test files in one directory through tsx.
 *
 * npm scripts cannot glob portably: cmd.exe passes `test/*.test.js` through
 * unexpanded, so the pattern reaches node as a literal path and the suite never
 * runs on Windows. Enumerate the files here and pass them explicitly instead.
 * Extra arguments are forwarded to node, so `npm test -- --test-name-pattern=x`
 * keeps working.
 */

import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const [, , directoryArg, ...extraArgs] = process.argv;

const listTestFiles = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.js'))
    .map((entry) => join(directory, entry.name))
    .sort();
};

const run = async () => {
  if (!directoryArg) {
    console.error('Usage: node scripts/run-node-tests.js <test-directory> [node flags]');
    return 1;
  }

  const directory = resolve(directoryArg);

  let testFiles;
  try {
    testFiles = await listTestFiles(directory);
  } catch (error) {
    console.error(`Cannot read test directory ${directory}: ${error.message}`);
    return 1;
  }

  if (testFiles.length === 0) {
    console.error(`No *.test.js files found in ${directory}`);
    return 1;
  }

  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--test', ...extraArgs, ...testFiles],
    { stdio: 'inherit' },
  );

  if (result.error) {
    console.error(`Failed to start the test runner: ${result.error.message}`);
    return 1;
  }

  // A signal-killed runner reports a null status; treat that as a failure.
  return result.status ?? 1;
};

process.exitCode = await run();
