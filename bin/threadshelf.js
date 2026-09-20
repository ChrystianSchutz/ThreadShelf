#!/usr/bin/env node
/**
 * `npx threadshelf` entrypoint.
 *
 * Plain JavaScript on purpose: the published package must not need tsx or a
 * TypeScript toolchain at runtime. It dispatches to one of the compiled CLIs in
 * dist/, defaulting to the web server.
 *
 * The subcommands exist so an installed package is not poorer than a clone:
 * from the repository these are `npm run parse|ingest|search|mcp`, and without
 * them the compiled CLIs would ship but be unreachable.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

const SUBCOMMANDS = {
  parse: '../dist/src/cli.js',
  ingest: '../dist/src/ingest-cli.js',
  search: '../dist/src/search-cli.js',
};

// `mcp` is handled separately: dist/mcp/server.js only starts itself when it
// decides it is the process entry point, and that check compares URLs in a way
// that is easy to get wrong on Windows. Start it explicitly instead, exactly as
// bin/threadshelf-mcp.js does.
const startMcpServer = async () => {
  const [{ runServer }, { startIndexRecovery }] = await Promise.all([
    import('../dist/mcp/server.js'),
    import('../dist/src/store.js'),
  ]);
  const stopRecovery = startIndexRecovery();
  process.stdin.once('end', stopRecovery);
  runServer();
};

const args = process.argv.slice(2);

const usage = `ThreadShelf ${pkg.version} - local semantic search for your AI chats

Usage:
  npx threadshelf [port]                  Start the web UI and API (default port 3000)
  npx threadshelf search "<query>" [...]  Search the archive from the terminal
  npx threadshelf ingest <folder> [...]   Ingest a folder of exports
  npx threadshelf parse <file> [...]      Parse one export to normalized JSON
  npx threadshelf mcp                     Start the MCP stdio server
                                          (npx threadshelf-mcp is equivalent)

Options:
  -p, --port <port>   Port to listen on (default 3000, or $PORT)
      --host <host>   Interface to bind (default 127.0.0.1, loopback only)
      --data-dir <d>  Directory for persistent data
                      (default: %LOCALAPPDATA%\\ThreadShelf on Windows, ~/.threadshelf elsewhere)
      --where         Print the resolved data and package directories, then exit
  -v, --version       Print the version
  -h, --help          Show this help

Each subcommand takes its own flags; run it with --help for those. Pass
--data-dir before the subcommand, e.g. npx threadshelf --data-dir D:\\shelf search "x".

Environment:
  PORT, HOST, THREADSHELF_DATA_DIR, LANCEDB_PATH and the other documented
  overrides keep working and take precedence over the defaults.
`;

let port = '';
let showWhere = false;
let subcommand = '';
let subcommandArgs = [];

const takeValue = (flag, index) => {
  const value = args[index + 1];
  if (!value || value.startsWith('-')) {
    console.error(`Missing value for ${flag}`);
    process.exit(1);
  }
  return value;
};

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === 'mcp' || Object.hasOwn(SUBCOMMANDS, arg)) {
    // Everything after the subcommand belongs to it, untouched.
    subcommand = arg;
    subcommandArgs = args.slice(i + 1);
    break;
  } else if (arg === '-h' || arg === '--help') {
    console.log(usage);
    process.exit(0);
  } else if (arg === '-v' || arg === '--version') {
    console.log(pkg.version);
    process.exit(0);
  } else if (arg === '--where') {
    showWhere = true;
  } else if (arg === '-p' || arg === '--port') {
    port = takeValue(arg, i);
    i += 1;
  } else if (arg === '--host') {
    process.env.HOST = takeValue(arg, i);
    i += 1;
  } else if (arg === '--data-dir') {
    process.env.THREADSHELF_DATA_DIR = takeValue(arg, i);
    i += 1;
  } else if (/^\d+$/.test(arg)) {
    port = arg;
  } else {
    console.error(`Unknown argument: ${arg}\n\n${usage}`);
    process.exit(1);
  }
}

if (port) process.env.PORT = port;

if (showWhere) {
  const { dataDir, packageRoot } = await import('../dist/src/paths.js');
  console.log('package :', packageRoot());
  console.log('data    :', dataDir());
  process.exit(0);
}

if (subcommand === 'mcp') {
  await startMcpServer();
} else if (subcommand) {
  // The compiled CLIs read process.argv.slice(2) at module load, so present
  // them the argv they would have seen if they had been invoked directly.
  const entry = fileURLToPath(new URL(SUBCOMMANDS[subcommand], import.meta.url));
  process.argv = [process.argv[0], entry, ...subcommandArgs];
  await import(SUBCOMMANDS[subcommand]);
} else {
  // server.ts reads process.argv[2] as a port; it is already normalised into
  // process.env.PORT above, so hide the raw argv from it.
  process.argv = [process.argv[0], process.argv[1]];
  await import('../dist/src/server.js');
}
