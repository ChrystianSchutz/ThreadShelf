#!/usr/bin/env node
/**
 * `threadshelf-mcp` stdio entrypoint for MCP clients (Claude Desktop, etc.).
 * Kept separate from the compiled module so the server's own "am I the
 * entrypoint?" check is not needed here - we start it explicitly.
 */
import { runServer } from '../dist/mcp/server.js';
import { startIndexRecovery } from '../dist/src/store.js';

const stopRecovery = startIndexRecovery();
process.stdin.once('end', stopRecovery);
runServer();
