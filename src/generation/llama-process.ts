import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createServer } from 'net';
import { basename, resolve } from 'path';
import { access } from 'fs/promises';
import { effectiveModelDirectories, getGenerationConfig } from './config.js';
import type { LlamaCppConfig } from './config.js';
import type {
  GenerationRuntimeStatus,
  LlamaDeviceInfo,
  LlamaOffloadInfo,
  LlamaRuntimeDiagnostics,
} from './types.js';
import { findLlamaExecutables } from './llama-install.js';
import { discoverGgufModels, localGgufModelName } from './model-discovery.js';

interface ManagedServer {
  readonly child: ChildProcessWithoutNullStreams;
  readonly model: string;
  readonly baseUrl: string;
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly startedAt: string;
  readonly contextSize: number;
  readonly devices: readonly LlamaDeviceInfo[];
  readonly deviceDetectionSupported: boolean;
  state: 'starting' | 'ready';
  logs: string;
  logsTruncated: boolean;
  startupError?: Error;
}

let managed: ManagedServer | null = null;
let lastManaged: ManagedServer | null = null;
let transition: Promise<string> | null = null;
let hooksRegistered = false;
let runtimeRevision = 0;
let activeChatModel: string | null = null;
let activeChatCount = 0;
let runtimeControlActive = false;
const capabilityCache = new Map<string, Promise<LlamaRuntimeCapabilities>>();
const deviceCache = new Map<string, Promise<LlamaDeviceInspection>>();
const MAX_RUNTIME_LOG_BYTES = 4 * 1024 * 1024;
const MAX_CHAT_ERROR_LOG_CHARS = 12_000;

export interface LlamaDeviceInspection {
  readonly supported: boolean;
  readonly devices: readonly LlamaDeviceInfo[];
  readonly raw: string;
}

export interface LlamaRuntimeCapabilities {
  readonly autoFit: boolean;
  readonly flashAttentionFlag: boolean;
  readonly flashAttentionValues: boolean;
  readonly flashAttentionAuto: boolean;
}

const MODERN_CAPABILITIES: LlamaRuntimeCapabilities = {
  autoFit: true,
  flashAttentionFlag: true,
  flashAttentionValues: true,
  flashAttentionAuto: true,
};

export class LlamaModelBusyError extends Error {
  constructor(readonly activeModel: string) {
    super(`Another GGUF model is currently generating: ${basename(activeModel)}`);
    this.name = 'LlamaModelBusyError';
  }
}

export const parseLlamaRuntimeCapabilities = (help: string): LlamaRuntimeCapabilities => {
  const flashLine = help.match(/^.*--flash-attn.*$/im)?.[0] ?? '';
  return {
    autoFit: help.includes('--fit'),
    flashAttentionFlag: Boolean(flashLine),
    flashAttentionValues: /on\s*[|,/]\s*off/i.test(flashLine),
    flashAttentionAuto: /\bauto\b/i.test(flashLine),
  };
};

const inspectLlamaRuntimeCapabilities = (executable: string): Promise<LlamaRuntimeCapabilities> => {
  const cached = capabilityCache.get(executable);
  if (cached) return cached;
  const inspection = new Promise<LlamaRuntimeCapabilities>((resolveInspection) => {
    const child = spawn(executable, ['--help'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    const append = (chunk: Buffer): void => {
      output = `${output}${chunk.toString('utf8')}`.slice(-1_048_576);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5_000);
    timeout.unref();
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveInspection(parseLlamaRuntimeCapabilities(output));
    };
    child.once('error', finish);
    child.once('close', finish);
  });
  capabilityCache.set(executable, inspection);
  return inspection;
};

export const parseLlamaDeviceOutput = (output: string, exitCode = 0): LlamaDeviceInspection => {
  const devices: LlamaDeviceInfo[] = [];
  const pattern = /^\s*([A-Za-z][\w.-]*\d+):\s*(.*?)\s+\((\d+)\s+MiB,\s*(\d+)\s+MiB free\)\s*$/gim;
  for (const match of output.matchAll(pattern)) {
    const [, id, name, totalMiB, freeMiB] = match;
    if (!id || !name || !totalMiB || !freeMiB) continue;
    devices.push({
      id,
      name: name.trim(),
      totalBytes: Number(totalMiB) * 1024 ** 2,
      freeBytes: Number(freeMiB) * 1024 ** 2,
    });
  }
  return {
    supported: exitCode === 0 && /Available devices:/i.test(output),
    devices,
    raw: output.trim(),
  };
};

export const inspectLlamaDevices = (executable: string): Promise<LlamaDeviceInspection> => {
  const cached = deviceCache.get(executable);
  if (cached) return cached;
  const inspection = new Promise<LlamaDeviceInspection>((resolveInspection) => {
    const child = spawn(executable, ['--list-devices'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    const append = (chunk: Buffer): void => {
      output = `${output}${chunk.toString('utf8')}`.slice(-65_536);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5_000);
    timeout.unref();
    let settled = false;
    const finish = (exitCode = -1): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveInspection(parseLlamaDeviceOutput(output, exitCode));
    };
    child.once('error', () => finish());
    child.once('close', (code) => finish(code ?? -1));
  });
  deviceCache.set(executable, inspection);
  return inspection;
};

export const buildLlamaRuntimeArgs = (
  config: LlamaCppConfig,
  capabilities: LlamaRuntimeCapabilities = MODERN_CAPABILITIES,
): string[] => {
  const args = ['--ctx-size', String(config.contextSize)];
  if (
    capabilities.flashAttentionValues &&
    (config.flashAttention !== 'auto' || capabilities.flashAttentionAuto)
  ) {
    args.push('--flash-attn', config.flashAttention);
  } else if (capabilities.flashAttentionFlag && config.flashAttention === 'on') {
    args.push('--flash-attn');
  }
  if (config.threads > 0) args.push('--threads', String(config.threads));

  // Modern llama.cpp can select the maximum safe offload itself. `auto` avoids
  // turning a model larger than VRAM into an immediate OOM while still using as
  // much accelerator memory as the runtime can fit.
  const maximumSafeLayers = capabilities.autoFit ? 'auto' : '999';
  const addFit = (): void => {
    if (capabilities.autoFit) args.push('--fit', 'on');
  };

  switch (config.acceleration) {
    case 'cpu':
      args.push('--n-gpu-layers', '0');
      break;
    case 'gpu':
      args.push(
        '--n-gpu-layers',
        maximumSafeLayers,
        '--split-mode',
        'none',
        '--main-gpu',
        String(config.mainGpu),
      );
      addFit();
      break;
    case 'hybrid':
      args.push('--n-gpu-layers', String(config.gpuLayers));
      addFit();
      break;
    case 'multi-gpu':
      args.push('--n-gpu-layers', maximumSafeLayers, '--split-mode', config.splitMode);
      addFit();
      if (config.tensorSplit) args.push('--tensor-split', config.tensorSplit);
      if (config.splitMode === 'row') args.push('--main-gpu', String(config.mainGpu));
      break;
    case 'auto':
      args.push('--n-gpu-layers', capabilities.autoFit ? 'auto' : '999');
      addFit();
      break;
  }
  return args;
};

const reservePort = async (): Promise<number> =>
  new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolvePort(port)));
    });
  });

const appendLogText = (server: ManagedServer, text: string): void => {
  const combined = `${server.logs}${text}`;
  if (Buffer.byteLength(combined, 'utf8') <= MAX_RUNTIME_LOG_BYTES) {
    server.logs = combined;
    return;
  }
  server.logsTruncated = true;
  const tail = Buffer.from(combined, 'utf8').subarray(-MAX_RUNTIME_LOG_BYTES).toString('utf8');
  server.logs = tail.startsWith('\uFFFD') ? tail.slice(1) : tail;
};

const appendLogs = (server: ManagedServer, chunk: Buffer): void => {
  appendLogText(server, chunk.toString('utf8'));
};

const shellDisplay = (value: string): string =>
  /[\s"]/u.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;

export const parseLlamaOffload = (
  logs: string,
  devices: readonly LlamaDeviceInfo[] = [],
  deviceDetectionSupported = false,
): LlamaOffloadInfo => {
  const layerMatches = [...logs.matchAll(/offloaded\s+(\d+)\s*\/\s*(\d+)\s+layers to GPU/gi)];
  const layerMatch = layerMatches.at(-1);
  const gpuLayers = layerMatch ? Number(layerMatch[1]) : undefined;
  const totalLayers = layerMatch ? Number(layerMatch[2]) : undefined;
  const gpuPercent =
    gpuLayers !== undefined && totalLayers
      ? Math.round((gpuLayers / totalLayers) * 1000) / 10
      : undefined;
  const deviceBufferMiB: Record<string, number> = {};
  for (const match of logs.matchAll(
    /\b(CPU(?:_Mapped)?|CUDA\d+|Vulkan\d+|MTL\d+|SYCL\d+)\s+model buffer size\s*=\s*([\d.]+)\s*MiB/gi,
  )) {
    const device = match[1];
    const sizeMiB = match[2];
    if (device && sizeMiB) deviceBufferMiB[device] = Number(sizeMiB);
  }
  let mode: LlamaOffloadInfo['mode'] = 'unknown';
  if (gpuLayers !== undefined && totalLayers !== undefined) {
    mode = gpuLayers === 0 ? 'cpu' : gpuLayers >= totalLayers ? 'gpu' : 'hybrid';
  } else if (deviceDetectionSupported && devices.length === 0) {
    mode = 'cpu';
  }
  return {
    mode,
    gpuLayers,
    totalLayers,
    gpuPercent,
    cpuPercent: gpuPercent === undefined ? undefined : Math.round((100 - gpuPercent) * 10) / 10,
    deviceBufferMiB: Object.keys(deviceBufferMiB).length > 0 ? deviceBufferMiB : undefined,
  };
};

const waitForReady = async (server: ManagedServer): Promise<void> => {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (server.startupError) throw server.startupError;
    if (server.child.exitCode !== null) {
      throw new Error(
        `llama-server exited during startup (${server.child.exitCode})\n${server.logs}`,
      );
    }
    try {
      const response = await fetch(`${server.baseUrl}/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return;
    } catch {
      // The process is still loading the model or has not opened its port yet.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`llama-server did not become ready within 180 seconds\n${server.logs}`);
};

const stopChild = async (server: ManagedServer): Promise<void> => {
  if (server.child.exitCode !== null) return;
  await new Promise<void>((resolveStop) => {
    const timeout = setTimeout(() => {
      server.child.kill('SIGKILL');
      resolveStop();
    }, 5_000);
    timeout.unref();
    server.child.once('exit', () => {
      clearTimeout(timeout);
      resolveStop();
    });
    server.child.kill('SIGTERM');
  });
};

const stopCurrentLlamaServer = async (): Promise<void> => {
  const current = managed;
  managed = null;
  if (current) await stopChild(current);
};

export const stopManagedLlamaServer = async (): Promise<void> => {
  assertLlamaModelIdle();
  runtimeRevision += 1;
  await stopCurrentLlamaServer();
};

export const assertLlamaModelIdle = (): void => {
  if (activeChatCount > 0) {
    throw new LlamaModelBusyError(activeChatModel ?? managed?.model ?? 'the active model');
  }
};

export const withLlamaRuntimeControl = async <T>(operation: () => Promise<T>): Promise<T> => {
  assertLlamaModelIdle();
  if (runtimeControlActive) throw new LlamaModelBusyError('the llama.cpp runtime');
  runtimeControlActive = true;
  try {
    return await operation();
  } finally {
    runtimeControlActive = false;
  }
};

export const getManagedLlamaStatus = (): GenerationRuntimeStatus => {
  if (!managed || managed.child.exitCode !== null) {
    return {
      state: 'stopped',
      detail: 'No GGUF model is loaded. The selected model loads on the first request.',
    };
  }
  return {
    state: managed.state,
    model: managed.model,
    contextSize: managed.contextSize,
    detail:
      managed.deviceDetectionSupported && managed.devices.length === 0
        ? managed.state === 'ready'
          ? 'The model is ready. This llama.cpp executable reports no accelerator devices, so it is using CPU.'
          : 'Loading on CPU: this llama.cpp executable reports no accelerator devices.'
        : managed.state === 'ready'
          ? 'The local model is loaded and ready.'
          : 'llama.cpp is loading the selected model into memory.',
  };
};

export const getLlamaFailureContext = (): string | undefined => {
  const server = managed ?? lastManaged;
  if (!server) return undefined;
  const exitCode = server.child.exitCode;
  const signalCode = server.child.signalCode;
  const processState =
    exitCode !== null
      ? `exited with code ${exitCode}${signalCode ? ` (${signalCode})` : ''}`
      : signalCode
        ? `stopped by signal ${signalCode}`
        : 'process is still running';
  const logs = server.logs.trim();
  const tail =
    logs.length > MAX_CHAT_ERROR_LOG_CHARS
      ? `[earlier output omitted]\n${logs.slice(-MAX_CHAT_ERROR_LOG_CHARS)}`
      : logs;
  return [
    `llama-server ${processState}.`,
    tail ? `llama.cpp stdout/stderr tail:\n${tail}` : 'llama.cpp produced no stdout/stderr.',
  ].join('\n');
};

export const getLlamaRuntimeDiagnostics = async (): Promise<LlamaRuntimeDiagnostics> => {
  const config = await getGenerationConfig();
  if (config.llamaCpp.baseUrl) {
    return {
      runtime: {
        state: 'external',
        detail: `Connected to an existing local server at ${config.llamaCpp.baseUrl}. Its process logs are not available to ThreadShelf.`,
      },
      source: 'external',
      logs: '',
      logsTruncated: false,
      devices: [],
      deviceDetectionSupported: false,
      offload: { mode: 'unknown' },
    };
  }
  const server = managed ?? lastManaged;
  if (server) {
    return {
      runtime: getManagedLlamaStatus(),
      source: 'managed',
      executable: server.executable,
      arguments: server.arguments,
      startedAt: server.startedAt,
      logs: server.logs,
      logsTruncated: server.logsTruncated,
      devices: server.devices,
      deviceDetectionSupported: server.deviceDetectionSupported,
      offload: parseLlamaOffload(server.logs, server.devices, server.deviceDetectionSupported),
    };
  }
  try {
    const executable = await resolveExecutable();
    const inspection = await inspectLlamaDevices(executable);
    return {
      runtime: getManagedLlamaStatus(),
      source: 'none',
      executable,
      logs: inspection.raw,
      logsTruncated: false,
      devices: inspection.devices,
      deviceDetectionSupported: inspection.supported,
      offload: parseLlamaOffload('', inspection.devices, inspection.supported),
    };
  } catch (error) {
    return {
      runtime: getManagedLlamaStatus(),
      source: 'none',
      logs: error instanceof Error ? error.message : 'Could not inspect llama.cpp runtime',
      logsTruncated: false,
      devices: [],
      deviceDetectionSupported: false,
      offload: { mode: 'unknown' },
    };
  }
};

const registerShutdownHooks = (): void => {
  if (hooksRegistered) return;
  hooksRegistered = true;
  const shutdown = (): void => {
    if (managed?.child.exitCode === null) managed.child.kill('SIGTERM');
  };
  process.once('exit', shutdown);
  process.once('SIGINT', () => {
    shutdown();
    process.exit(130);
  });
  process.once('SIGTERM', () => {
    shutdown();
    process.exit(143);
  });
};

const resolveExecutable = async (): Promise<string> => {
  const config = await getGenerationConfig();
  if (config.llamaCpp.executablePath) {
    const configured = resolve(config.llamaCpp.executablePath);
    const expected = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
    if (basename(configured).toLowerCase() !== expected) {
      throw new Error(`Configured executable must be named ${expected}`);
    }
    await access(configured);
    return configured;
  }
  const found = await findLlamaExecutables();
  if (!found[0]) throw new Error('llama-server was not found; run npm run setup:llama');
  return found[0];
};

const validateModel = async (model: string): Promise<string> => {
  const config = await getGenerationConfig();
  const discovered = await discoverGgufModels(effectiveModelDirectories(config.llamaCpp));
  const selected = discovered.find((candidate) => candidate.id === resolve(model));
  if (!selected?.path)
    throw new Error('Selected GGUF model is outside configured model directories');
  return selected.path;
};

const startManagedServer = async (model: string, requestedRevision: number): Promise<string> => {
  const config = await getGenerationConfig();
  if (config.llamaCpp.baseUrl) return `${config.llamaCpp.baseUrl.replace(/\/$/, '')}/v1`;
  const modelPath = await validateModel(model);
  const executable = await resolveExecutable();
  const [capabilities, deviceInspection] = await Promise.all([
    inspectLlamaRuntimeCapabilities(executable),
    inspectLlamaDevices(executable),
  ]);
  if (requestedRevision !== runtimeRevision) {
    throw new Error('llama.cpp model load was cancelled');
  }
  if (
    managed &&
    managed.child.exitCode === null &&
    managed.model === modelPath &&
    managed.executable === executable
  ) {
    return `${managed.baseUrl}/v1`;
  }
  await stopCurrentLlamaServer();
  const port = await reservePort();
  const args = [
    '--model',
    modelPath,
    '--alias',
    localGgufModelName(modelPath),
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--jinja',
    ...buildLlamaRuntimeArgs(config.llamaCpp, capabilities),
  ];
  const child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  child.stdin.end();
  const server: ManagedServer = {
    child,
    model: modelPath,
    executable,
    arguments: args,
    startedAt: new Date().toISOString(),
    contextSize: config.llamaCpp.contextSize,
    devices: deviceInspection.devices,
    deviceDetectionSupported: deviceInspection.supported,
    state: 'starting',
    baseUrl: `http://127.0.0.1:${port}`,
    logs: '',
    logsTruncated: false,
  };
  managed = server;
  lastManaged = server;
  appendLogText(
    server,
    `[ThreadShelf] Launching: ${[executable, ...args].map(shellDisplay).join(' ')}\n`,
  );
  if (deviceInspection.supported && deviceInspection.devices.length === 0) {
    appendLogText(
      server,
      '[ThreadShelf] Device check: no accelerator devices reported; this process will use CPU.\n',
    );
  } else if (deviceInspection.devices.length > 0) {
    appendLogText(server, `[ThreadShelf] Device check:\n${deviceInspection.raw}\n`);
  } else {
    appendLogText(
      server,
      '[ThreadShelf] Device check is unavailable for this llama.cpp executable.\n',
    );
  }
  child.stdout.on('data', (chunk: Buffer) => appendLogs(server, chunk));
  child.stderr.on('data', (chunk: Buffer) => appendLogs(server, chunk));
  child.once('exit', () => {
    if (managed === server) managed = null;
  });
  child.once('error', (error) => {
    server.startupError = error;
  });
  registerShutdownHooks();
  try {
    await waitForReady(server);
    if (requestedRevision !== runtimeRevision) {
      throw new Error('llama.cpp model load was cancelled');
    }
    server.state = 'ready';
    return `${server.baseUrl}/v1`;
  } catch (error) {
    await stopChild(server);
    if (managed === server) managed = null;
    throw error;
  }
};

export const ensureLlamaServer = async (model: string): Promise<string> => {
  const normalizedModel = resolve(model);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!transition) {
      const requestedRevision = runtimeRevision;
      transition = startManagedServer(model, requestedRevision).finally(() => {
        transition = null;
      });
    }
    const baseUrl = await transition;
    if (!managed || managed.model === normalizedModel) return baseUrl;
  }
  throw new Error('llama.cpp model transition did not settle after 3 attempts');
};

export const withLlamaModelLease = async <T>(
  model: string,
  operation: () => Promise<T>,
): Promise<T> => {
  const normalizedModel = resolve(model);
  if (runtimeControlActive) throw new LlamaModelBusyError('the llama.cpp runtime');
  if (activeChatCount > 0 && activeChatModel !== normalizedModel) {
    throw new LlamaModelBusyError(activeChatModel ?? normalizedModel);
  }
  activeChatModel = normalizedModel;
  activeChatCount += 1;
  try {
    return await operation();
  } finally {
    activeChatCount -= 1;
    if (activeChatCount === 0) activeChatModel = null;
  }
};

export const withLlamaServer = async <T>(
  model: string,
  operation: (baseUrl: string) => Promise<T>,
): Promise<T> => {
  return withLlamaModelLease(model, async () => {
    const config = await getGenerationConfig();
    if (config.llamaCpp.baseUrl) {
      return operation(`${config.llamaCpp.baseUrl.replace(/\/$/, '')}/v1`);
    }
    return operation(await ensureLlamaServer(model));
  });
};
