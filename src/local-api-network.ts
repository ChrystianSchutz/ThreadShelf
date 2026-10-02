import express from 'express';
import { createServer, type Server } from 'http';
import { networkInterfaces } from 'os';
import { getGenerationConfig } from './generation/config.js';
import { createLocalApiRouter } from './routes/local-api.js';

/**
 * Optional second listener that serves the local model API to other devices,
 * like LM Studio's "Serve on local network". It is a separate port bound to
 * all interfaces that serves `/v1` and nothing else, so turning it on never
 * exposes the archive or the settings API, which stay on the loopback port.
 */
export interface LocalApiNetworkStatus {
  readonly state: 'off' | 'listening' | 'error';
  readonly port?: number;
  /** `/v1` base URLs other devices can use, one per LAN IPv4 address. */
  readonly urls: readonly string[];
  readonly error?: string;
}

const app = express();
app.disable('x-powered-by');
app.use('/v1', createLocalApiRouter('network'));
app.use((_req, res) => {
  res.status(404).json({
    error: {
      message: 'Only the local model API (/v1) is served on this port.',
      type: 'invalid_request_error',
      param: null,
      code: 'unknown_endpoint',
    },
  });
});

let server: Server | null = null;
let listeningPort: number | null = null;
let lastError: { readonly port: number; readonly message: string } | undefined;
let mainPort: number | undefined;
let queue: Promise<void> = Promise.resolve();

const lanAddresses = (): string[] =>
  Object.values(networkInterfaces())
    .flat()
    .filter((address) => address && address.family === 'IPv4' && !address.internal)
    .map((address) => address!.address);

const close = (): Promise<void> => {
  const current = server;
  server = null;
  listeningPort = null;
  if (!current) return Promise.resolve();
  return new Promise((resolveClose) => {
    current.close(() => resolveClose());
    // Turning network access off also ends requests already in flight.
    current.closeAllConnections();
  });
};

const listen = (port: number): Promise<void> =>
  new Promise((resolveListen, reject) => {
    const next = createServer(app);
    next.once('error', reject);
    next.listen(port, '0.0.0.0', () => {
      next.off('error', reject);
      server = next;
      listeningPort = port;
      resolveListen();
    });
  });

const describeListenError = (port: number, error: unknown): string => {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'EADDRINUSE') return `Port ${port} is already in use. Choose another port.`;
  if (code === 'EACCES') return `Not allowed to listen on port ${port}. Choose a port above 1024.`;
  return error instanceof Error ? error.message : String(error);
};

/**
 * Starts, moves or stops the network listener to match the saved settings.
 * Calls are serialized, so rapid setting changes cannot race each other.
 */
export const syncLocalApiNetworkListener = (): Promise<void> => {
  queue = queue.then(async () => {
    const config = await getGenerationConfig().catch(() => null);
    const wanted =
      config?.localApi.enabled && config.localApi.networkAccess
        ? config.localApi.networkPort
        : null;
    if (wanted !== null && wanted === listeningPort) return;
    await close();
    lastError = undefined;
    if (wanted === null) return;
    if (wanted === mainPort) {
      lastError = {
        port: wanted,
        message: `Port ${wanted} is ThreadShelf's own port. Choose a different network port.`,
      };
      return;
    }
    try {
      await listen(wanted);
      console.log(`Local model API on the network: port ${wanted} (/v1 only)`);
    } catch (error) {
      lastError = { port: wanted, message: describeListenError(wanted, error) };
      console.warn(`[local API] ${lastError.message}`);
    }
  });
  return queue;
};

/** Called once the app's own port is known; starts the listener if enabled. */
export const startLocalApiNetworkListener = (appPort: number): Promise<void> => {
  mainPort = appPort;
  return syncLocalApiNetworkListener();
};

export const stopLocalApiNetworkListener = (): Promise<void> => {
  queue = queue.then(close);
  return queue;
};

export const getLocalApiNetworkStatus = (): LocalApiNetworkStatus => {
  if (listeningPort !== null) {
    return {
      state: 'listening',
      port: listeningPort,
      urls: lanAddresses().map((address) => `http://${address}:${listeningPort}/v1`),
    };
  }
  if (lastError) {
    return { state: 'error', port: lastError.port, urls: [], error: lastError.message };
  }
  return { state: 'off', urls: [] };
};
