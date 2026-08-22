import { createHash } from 'crypto';
import { existsSync } from 'fs';
import {
  access,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'fs/promises';
import { homedir, tmpdir } from 'os';
import { basename, dirname, extname, join, resolve } from 'path';
import { spawn } from 'child_process';
import { downloadToFile, sha256File, type DownloadProgress } from './downloader.js';

export { sha256File };

export const LLAMA_CPP_REPOSITORY = 'ggml-org/llama.cpp';
export const LLAMA_CPP_RELEASE_API =
  'https://api.github.com/repos/ggml-org/llama.cpp/releases/latest';
export const LLAMA_CPP_RELEASES_API = 'https://api.github.com/repos/ggml-org/llama.cpp/releases';

/**
 * Upstream publishes stable semver releases (`v0.2.0`) that carry no binaries and
 * mark the nightly build in a `nightly-tag.txt` asset, while the actual archives
 * live in `bNNNNN` releases flagged as pre-releases. GitHub's `/releases/latest`
 * therefore points at a release with nothing to install.
 */
export const NIGHTLY_TAG_ASSET = 'nightly-tag.txt';
const NIGHTLY_TAG_PATTERN = /^b\d+$/;
const RELEASE_SCAN_PAGE_SIZE = 30;

export type LlamaPlatform = 'win32' | 'darwin' | 'linux';
export type LlamaArch = 'x64' | 'arm64';
export type LlamaVariant = 'cpu' | 'vulkan' | 'cuda' | 'rocm' | 'sycl';

export interface ReleaseAsset {
  readonly name: string;
  readonly browser_download_url: string;
  readonly digest?: string | null;
  readonly size?: number;
}

export interface LlamaRelease {
  readonly tag_name: string;
  readonly html_url: string;
  readonly published_at?: string;
  readonly assets: readonly ReleaseAsset[];
}

export interface InstallSource {
  readonly url: string;
  readonly filename: string;
  readonly sha256?: string;
  readonly sizeBytes?: number;
  readonly tag: string;
  readonly releaseUrl?: string;
  readonly flavor?: LlamaVariant;
  readonly companions?: readonly {
    readonly url: string;
    readonly filename: string;
    readonly sha256: string;
    readonly sizeBytes?: number;
  }[];
}

export interface InstallResult {
  readonly installDirectory: string;
  readonly executablePath: string;
  readonly source: InstallSource;
}

export interface InstallProgress {
  readonly phase: 'downloading' | 'verifying' | 'inspecting' | 'extracting' | 'licensing';
  readonly downloadedBytes?: number;
  readonly totalBytes?: number;
}

const executableNames = (platform: NodeJS.Platform = process.platform): readonly string[] =>
  platform === 'win32' ? ['llama-server.exe'] : ['llama-server'];

const canExecute = async (path: string): Promise<boolean> => {
  try {
    await access(path, process.platform === 'win32' ? undefined : 1);
    return true;
  } catch {
    return false;
  }
};

const unique = (values: readonly string[]): string[] => [
  ...new Set(values.map((value) => resolve(value))),
];

export const defaultLlamaInstallRoot = (): string =>
  resolve(process.env.THREADSHELF_TOOLS_PATH || join(process.cwd(), '.threadshelf', 'tools'));

export const llamaExecutableCandidates = ({
  platform = process.platform,
  installRoot = defaultLlamaInstallRoot(),
  env = process.env,
}: {
  platform?: NodeJS.Platform;
  installRoot?: string;
  env?: NodeJS.ProcessEnv;
} = {}): string[] => {
  const names = executableNames(platform);
  const configured = [env.LLAMA_CPP_SERVER, env.LLAMA_SERVER_PATH].filter(
    (value): value is string => Boolean(value?.trim()),
  );
  const pathDelimiter = platform === 'win32' ? ';' : ':';
  const pathEntries = (env.PATH || '')
    .split(pathDelimiter)
    .filter(Boolean)
    .flatMap((entry) => names.map((name) => join(entry, name)));
  const roots = [
    installRoot,
    join(homedir(), '.local', 'bin'),
    ...(platform === 'win32'
      ? [join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'llama.cpp')]
      : ['/usr/local/bin', '/opt/homebrew/bin']),
  ];
  const rooted = roots.flatMap((root) => names.map((name) => join(root, name)));
  return unique([...configured, ...pathEntries, ...rooted]);
};

const findRecursively = async (
  root: string,
  names: ReadonlySet<string>,
  depth = 3,
): Promise<string[]> => {
  if (depth < 0 || !existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const found: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isFile() && names.has(entry.name.toLowerCase())) found.push(path);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      found.push(...(await findRecursively(path, names, depth - 1)));
    }
  }
  return found;
};

export const findLlamaExecutables = async (
  options: Parameters<typeof llamaExecutableCandidates>[0] = {},
): Promise<string[]> => {
  const platform = options.platform ?? process.platform;
  const direct = await Promise.all(
    llamaExecutableCandidates(options).map(async (path) =>
      (await canExecute(path)) ? path : null,
    ),
  );
  const installRoot = options.installRoot ?? defaultLlamaInstallRoot();
  const nested = await findRecursively(
    installRoot,
    new Set(executableNames(platform).map((name) => name.toLowerCase())),
  );
  const releaseNumber = (path: string): number => {
    const match = path.match(/[\\/]b(\d+)(?:-[^\\/]+)?[\\/]/i);
    return match?.[1] ? Number(match[1]) : 0;
  };
  const acceleratorScore = (path: string): number =>
    /[\\/]b\d+-(cuda|vulkan|rocm|sycl)[\\/]/i.test(path) ? 1 : 0;
  nested.sort(
    (left, right) =>
      releaseNumber(right) - releaseNumber(left) ||
      acceleratorScore(right) - acceleratorScore(left) ||
      right.localeCompare(left),
  );
  return unique([...direct.filter((path): path is string => path !== null), ...nested]);
};

const githubHeaders = (env: NodeJS.ProcessEnv = process.env): Record<string, string> => {
  const token = (env.GITHUB_TOKEN || env.GH_TOKEN || '').trim();
  return {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'ThreadShelf-llama-installer',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
};

const githubGet = async (url: string, fetchImpl: typeof fetch): Promise<Response> => {
  const response = await fetchImpl(url, {
    headers: githubHeaders(),
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 403 || response.status === 429) {
    const remaining = response.headers.get('x-ratelimit-remaining');
    throw new Error(
      remaining === '0'
        ? 'GitHub API rate limit reached. Set GITHUB_TOKEN to raise the limit, or retry later.'
        : `GitHub release lookup was refused (${response.status})`,
    );
  }
  if (!response.ok) throw new Error(`GitHub release lookup failed (${response.status})`);
  return response;
};

const asRelease = (value: unknown): LlamaRelease => {
  const release = value as Partial<LlamaRelease>;
  if (!release?.tag_name || !release.html_url || !Array.isArray(release.assets)) {
    throw new Error('GitHub returned an invalid llama.cpp release payload');
  }
  return release as LlamaRelease;
};

export const fetchLatestLlamaRelease = async (
  fetchImpl: typeof fetch = fetch,
): Promise<LlamaRelease> => asRelease(await (await githubGet(LLAMA_CPP_RELEASE_API, fetchImpl)).json());

export const fetchLlamaReleaseByTag = async (
  tag: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LlamaRelease> => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(tag)) {
    throw new Error(`Invalid llama.cpp release tag: ${tag}`);
  }
  return asRelease(
    await (
      await githubGet(`${LLAMA_CPP_RELEASES_API}/tags/${encodeURIComponent(tag)}`, fetchImpl)
    ).json(),
  );
};

/** True when a release actually carries installable `llama-*-bin-*` archives. */
export const releaseHasLlamaBinaries = (release: LlamaRelease): boolean =>
  release.assets.some((asset) => /^llama-.*-bin-.*\.(zip|tar\.gz|tgz)$/i.test(asset.name));

/** Reads the `bNNNNN` build that a binary-less stable release points at. */
export const readNightlyTagPointer = async (
  release: LlamaRelease,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> => {
  const pointer = release.assets.find(
    (asset) => asset.name.toLowerCase() === NIGHTLY_TAG_ASSET,
  );
  if (!pointer) return null;
  const response = await fetchImpl(pointer.browser_download_url, {
    redirect: 'follow',
    headers: { 'User-Agent': 'ThreadShelf-llama-installer' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) return null;
  const tag = (await response.text()).trim().split(/\s+/)[0] ?? '';
  return NIGHTLY_TAG_PATTERN.test(tag) ? tag : null;
};

const scanRecentReleasesForBinaries = async (
  fetchImpl: typeof fetch,
): Promise<LlamaRelease | null> => {
  const payload = (await (
    await githubGet(`${LLAMA_CPP_RELEASES_API}?per_page=${RELEASE_SCAN_PAGE_SIZE}`, fetchImpl)
  ).json()) as unknown;
  if (!Array.isArray(payload)) return null;
  for (const entry of payload) {
    const release = entry as Partial<LlamaRelease>;
    if (!release?.tag_name || !Array.isArray(release.assets)) continue;
    if (!NIGHTLY_TAG_PATTERN.test(release.tag_name)) continue;
    if (releaseHasLlamaBinaries(release as LlamaRelease)) return release as LlamaRelease;
  }
  return null;
};

/**
 * Resolves the newest release that really has binaries, following the
 * `nightly-tag.txt` pointer and falling back to a scan of recent releases.
 */
export const resolveLlamaRelease = async ({
  tag,
  fetchImpl = fetch,
}: { tag?: string; fetchImpl?: typeof fetch } = {}): Promise<LlamaRelease> => {
  if (tag) {
    const pinned = await fetchLlamaReleaseByTag(tag, fetchImpl);
    if (!releaseHasLlamaBinaries(pinned)) {
      throw new Error(`Release ${pinned.tag_name} carries no llama.cpp binaries.`);
    }
    return pinned;
  }

  const latest = await fetchLatestLlamaRelease(fetchImpl);
  if (releaseHasLlamaBinaries(latest)) return latest;

  const nightlyTag = await readNightlyTagPointer(latest, fetchImpl);
  if (nightlyTag) {
    const nightly = await fetchLlamaReleaseByTag(nightlyTag, fetchImpl).catch(() => null);
    if (nightly && releaseHasLlamaBinaries(nightly)) return nightly;
  }

  const scanned = await scanRecentReleasesForBinaries(fetchImpl);
  if (scanned) return scanned;

  throw new Error(
    `No llama.cpp release with binaries was found (latest tag ${latest.tag_name} has none). Use --url for a custom build.`,
  );
};

const architectureToken = (arch: NodeJS.Architecture): LlamaArch => {
  if (arch === 'x64' || arch === 'arm64') return arch;
  throw new Error(`Unsupported architecture: ${arch}. Use --url for a compatible custom build.`);
};

const platformToken = (platform: NodeJS.Platform): LlamaPlatform => {
  if (platform === 'win32' || platform === 'darwin' || platform === 'linux') return platform;
  throw new Error(`Unsupported platform: ${platform}. Use --url for a compatible custom build.`);
};

/** Orders `-cuda-13.3-` ahead of `-cuda-12.4-`; unversioned assets rank lowest. */
export const toolkitRank = (name: string): number => {
  const match = name.toLowerCase().match(/-(?:cuda|rocm|sycl|openvino)-(\d+)(?:\.(\d+))?/);
  if (!match) return -1;
  return Number(match[1]) * 1000 + Number(match[2] ?? 0);
};

export const selectReleaseAsset = (
  release: LlamaRelease,
  {
    platform = process.platform,
    arch = process.arch,
    variant = 'cpu',
  }: { platform?: NodeJS.Platform; arch?: NodeJS.Architecture; variant?: LlamaVariant } = {},
): ReleaseAsset => {
  const os = platformToken(platform);
  const cpu = architectureToken(arch);
  const supportedVariant = os === 'darwin' ? 'cpu' : variant;
  if (os === 'darwin' && variant !== 'cpu') {
    throw new Error('macOS release builds use Metal automatically; choose the cpu variant.');
  }

  const required =
    os === 'win32'
      ? ['-bin-win-', supportedVariant === 'cpu' ? '-cpu-' : `-${supportedVariant}-`, `-${cpu}.zip`]
      : os === 'darwin'
        ? ['-bin-macos-', `-${cpu}.tar.gz`]
        : [
            '-bin-ubuntu-',
            ...(supportedVariant === 'cpu' ? [] : [`-${supportedVariant}-`]),
            `-${cpu}.tar.gz`,
          ];

  const matches = release.assets.filter((asset) => {
    const name = asset.name.toLowerCase();
    if (name.startsWith('cudart-')) return false;
    if (
      os === 'linux' &&
      supportedVariant === 'cpu' &&
      /-(vulkan|rocm|sycl|openvino|cuda)-/.test(name)
    ) {
      return false;
    }
    return required.every((token) => name.includes(token));
  });
  // Accelerator builds are published per toolkit version (cuda-12.4, cuda-13.3,
  // rocm-7.14). Plain alphabetical order would pin the oldest toolkit forever.
  const asset = matches.sort(
    (a, b) => toolkitRank(b.name) - toolkitRank(a.name) || a.name.localeCompare(b.name),
  )[0];
  if (!asset) {
    throw new Error(
      `No official ${os}/${cpu}/${supportedVariant} binary exists in release ${release.tag_name}. Use --url for a custom build.`,
    );
  }
  return asset;
};

const normalizeDigest = (digest: string | null | undefined): string | undefined => {
  if (!digest) return undefined;
  const value = digest.toLowerCase().replace(/^sha256:/, '');
  return /^[a-f0-9]{64}$/.test(value) ? value : undefined;
};

export const sourceFromRelease = (
  release: LlamaRelease,
  options: Parameters<typeof selectReleaseAsset>[1] = {},
): InstallSource => {
  const asset = selectReleaseAsset(release, options);
  const sha256 = normalizeDigest(asset.digest);
  if (!sha256) {
    throw new Error(`Release asset ${asset.name} has no usable SHA-256 digest; refusing install.`);
  }
  const platform = options.platform ?? process.platform;
  const variant = options.variant ?? 'cpu';
  let companions: InstallSource['companions'];
  if (platform === 'win32' && variant === 'cuda') {
    const expectedName = asset.name.replace(/^llama-[^-]+-bin-win-/i, 'cudart-llama-bin-win-');
    const companion = release.assets.find(
      (candidate) => candidate.name.toLowerCase() === expectedName.toLowerCase(),
    );
    const companionSha256 = normalizeDigest(companion?.digest);
    if (!companion || !companionSha256) {
      throw new Error(
        `Release ${release.tag_name} has no authenticated CUDA runtime companion ${expectedName}; refusing an incomplete Windows CUDA install.`,
      );
    }
    companions = [
      {
        url: companion.browser_download_url,
        filename: companion.name,
        sha256: companionSha256,
        sizeBytes: companion.size,
      },
    ];
  }
  return {
    url: asset.browser_download_url,
    filename: asset.name,
    sha256,
    sizeBytes: asset.size,
    tag: release.tag_name,
    releaseUrl: release.html_url,
    flavor: options.variant ?? 'cpu',
    companions,
  };
};

/**
 * Downloads and verifies in one pass. The digest is computed while the bytes are
 * written, so a several-hundred-megabyte archive is never read back off disk.
 */
const downloadAndVerify = async (
  url: string,
  destination: string,
  sha256: string | undefined,
  onProgress?: (progress: InstallProgress) => void,
  signal?: AbortSignal,
): Promise<void> => {
  if (existsSync(destination)) {
    const valid = !sha256 || (await sha256File(destination)) === sha256.toLowerCase();
    if (valid) return;
    await rm(destination, { force: true });
  }
  await downloadToFile(url, destination, {
    sha256,
    signal,
    headers: { 'User-Agent': 'ThreadShelf-llama-installer' },
    onProgress: (progress: DownloadProgress) =>
      onProgress?.({
        phase: 'downloading',
        downloadedBytes: progress.downloadedBytes,
        totalBytes: progress.totalBytes,
      }),
  });
};

const cachedArtifactPath = (
  directory: string,
  url: string,
  filename: string,
  sha256?: string,
): string => {
  const identity = createHash('sha256')
    .update(`${url}\0${sha256 ?? ''}`)
    .digest('hex')
    .slice(0, 20);
  const safeName = basename(filename).replace(/[^A-Za-z0-9._-]/g, '_') || 'artifact';
  return join(directory, `${identity}-${safeName}`);
};

const cleanupFailedArtifact = async (archive: string, error: unknown): Promise<void> => {
  if (error instanceof Error && error.name === 'AbortError') return;
  await Promise.all([
    rm(archive, { force: true }).catch(() => undefined),
    rm(`${archive}.part`, { force: true }).catch(() => undefined),
  ]);
};

const run = async (command: string, args: readonly string[]): Promise<void> =>
  new Promise((resolveRun, reject) => {
    const child = spawn(command, [...args], { stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolveRun() : reject(new Error(`${command} exited with code ${code}`)),
    );
  });

export const runCommandCapture = async (
  command: string,
  args: readonly string[],
): Promise<string> =>
  new Promise((resolveRun, reject) => {
    const child = spawn(command, [...args], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', reject);
    // `exit` can fire before stdout/stderr have emitted their final buffered
    // chunks. `close` is emitted only after the stdio streams are closed.
    child.once('close', (code) =>
      code === 0
        ? resolveRun(stdout)
        : reject(new Error(`${command} exited with code ${code}: ${stderr.trim()}`)),
    );
  });

export const assertSafeArchiveEntries = (entries: readonly string[]): void => {
  if (entries.length === 0) throw new Error('Archive is empty');
  for (const original of entries) {
    const normalized = original.trim().replace(/\\/g, '/').replace(/\/$/, '');
    if (!normalized) continue;
    const segments = normalized.split('/');
    if (
      normalized.startsWith('/') ||
      /^[a-zA-Z]:/.test(normalized) ||
      normalized.includes('\0') ||
      segments.includes('..')
    ) {
      throw new Error(`Unsafe archive entry: ${original}`);
    }
  }
};

export const inspectLlamaArchive = async (archive: string): Promise<void> => {
  const lower = archive.toLowerCase();
  if (lower.endsWith('.zip')) {
    if (process.platform === 'win32') {
      const listing = await runCommandCapture('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "& { param($archive) Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::OpenRead($archive); try { foreach($e in $z.Entries) { if ((($e.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) { throw 'Archive contains a symbolic link' }; $e.FullName } } finally { $z.Dispose() } }",
        archive,
      ]);
      assertSafeArchiveEntries(listing.split(/\r?\n/).filter(Boolean));
      return;
    }
    const listing = await runCommandCapture('unzip', ['-Z1', archive]);
    const verbose = await runCommandCapture('unzip', ['-Z', '-l', archive]);
    if (/^\s*l[rwx-]{9}\s/m.test(verbose)) {
      throw new Error('Archive contains a symbolic link');
    }
    assertSafeArchiveEntries(listing.split(/\r?\n/).filter(Boolean));
    return;
  }
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
    const listing = await runCommandCapture('tar', ['-tzf', archive]);
    const verbose = await runCommandCapture('tar', ['-tvzf', archive]);
    if (/^[lh][rwx-]{9}\s/m.test(verbose)) {
      throw new Error('Archive contains a symbolic or hard link');
    }
    assertSafeArchiveEntries(listing.split(/\r?\n/).filter(Boolean));
    return;
  }
  throw new Error(`Unsupported archive type: ${basename(archive)}`);
};

const extractArchive = async (archive: string, destination: string): Promise<void> => {
  const lower = archive.toLowerCase();
  if (lower.endsWith('.zip')) {
    if (process.platform === 'win32') {
      await run('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '& { param($archive, $destination) Expand-Archive -LiteralPath $archive -DestinationPath $destination }',
        archive,
        destination,
      ]);
      return;
    }
    await run('unzip', ['-q', archive, '-d', destination]);
    return;
  }
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
    await run('tar', ['-xzf', archive, '-C', destination]);
    return;
  }
  throw new Error(`Unsupported archive type: ${basename(archive)}`);
};

const installCompanionArchives = async (
  companions: NonNullable<InstallSource['companions']>,
  targetDirectory: string,
  staging: string,
  downloadDirectory: string,
  onProgress?: (progress: InstallProgress) => void,
  signal?: AbortSignal,
): Promise<void> => {
  for (const [index, companion] of companions.entries()) {
    const archive = cachedArtifactPath(
      downloadDirectory,
      companion.url,
      companion.filename,
      companion.sha256,
    );
    const extracted = join(staging, `companion-${index}-extracted`);
    await mkdir(extracted);
    try {
      onProgress?.({ phase: 'downloading', downloadedBytes: 0 });
      await downloadAndVerify(companion.url, archive, companion.sha256, onProgress, signal);
      signal?.throwIfAborted();
      onProgress?.({ phase: 'inspecting' });
      await inspectLlamaArchive(archive);
      signal?.throwIfAborted();
      onProgress?.({ phase: 'extracting' });
      await extractArchive(archive, extracted);
      signal?.throwIfAborted();
      // Runtime archives contain DLLs shared by the executable. Never replace an
      // existing file during repair; matching files are left untouched.
      for (const entry of await readdir(extracted)) {
        await cp(join(extracted, entry), join(targetDirectory, entry), {
          recursive: true,
          force: false,
          errorOnExist: false,
        });
      }
      await rm(archive, { force: true });
    } catch (error) {
      await cleanupFailedArtifact(archive, error);
      throw error;
    }
  }
};

const copyLicense = async (tag: string, destination: string): Promise<void> => {
  const url = `https://raw.githubusercontent.com/${LLAMA_CPP_REPOSITORY}/${encodeURIComponent(tag)}/LICENSE`;
  const response = await fetch(url, {
    headers: { 'User-Agent': 'ThreadShelf-llama-installer' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Could not retrieve llama.cpp license (${response.status})`);
  await writeFile(join(destination, 'LICENSE.llama.cpp'), await response.text(), {
    encoding: 'utf8',
    mode: 0o600,
  });
};

export const installLlamaCpp = async (
  source: InstallSource,
  {
    installRoot = defaultLlamaInstallRoot(),
    onProgress,
    signal,
  }: {
    installRoot?: string;
    onProgress?: (progress: InstallProgress) => void;
    signal?: AbortSignal;
  } = {},
): Promise<InstallResult> => {
  const safeTag = source.tag.replace(/[^a-zA-Z0-9._-]/g, '_');
  const safeFlavor = source.flavor?.replace(/[^a-zA-Z0-9._-]/g, '_');
  const destination = resolve(
    installRoot,
    'llama.cpp',
    safeFlavor ? `${safeTag}-${safeFlavor}` : safeTag,
  );
  await mkdir(dirname(destination), { recursive: true });
  const downloadDirectory = join(dirname(destination), '.downloads');
  await mkdir(downloadDirectory, { recursive: true });
  const staging = await mkdtemp(join(tmpdir(), 'threadshelf-llama-'));
  let primaryArchive: string | undefined;
  try {
    if (existsSync(destination)) {
      const metadata = await readFile(join(destination, 'THREADSHELF_INSTALL.json'), 'utf8')
        .then(
          (value) =>
            JSON.parse(value) as {
              source?: { tag?: string; flavor?: LlamaVariant };
            },
        )
        .catch(() => null);
      if (
        metadata?.source?.tag !== source.tag ||
        (metadata.source.flavor ?? 'cpu') !== (source.flavor ?? 'cpu')
      ) {
        throw new Error(
          `Existing install metadata does not match ${source.tag}/${source.flavor ?? 'cpu'}; refusing repair.`,
        );
      }
      const existing = await findRecursively(
        destination,
        new Set(executableNames().map((name) => name.toLowerCase())),
        5,
      );
      const executablePath = existing[0];
      if (!executablePath) {
        throw new Error(`Existing install has no llama-server: ${destination}`);
      }
      // Re-running an install of the same build is a no-op rather than an error,
      // so the one-click setup screen stays safe to press twice.
      if (!source.companions?.length) {
        return { installDirectory: destination, executablePath, source };
      }
      await installCompanionArchives(
        source.companions,
        dirname(executablePath),
        staging,
        downloadDirectory,
        onProgress,
        signal,
      );
      await writeFile(
        join(destination, 'THREADSHELF_INSTALL.json'),
        `${JSON.stringify({ source, installedAt: new Date().toISOString() }, null, 2)}\n`,
        { encoding: 'utf8', mode: 0o600 },
      );
      return { installDirectory: destination, executablePath, source };
    }
    const archiveFilename = source.filename || `llama${extname(new URL(source.url).pathname)}`;
    const archive = cachedArtifactPath(
      downloadDirectory,
      source.url,
      archiveFilename,
      source.sha256,
    );
    primaryArchive = archive;
    const extracted = join(staging, 'extracted');
    await mkdir(extracted);
    onProgress?.({ phase: 'downloading', downloadedBytes: 0 });
    await downloadAndVerify(source.url, archive, source.sha256, onProgress, signal);
    signal?.throwIfAborted();
    onProgress?.({ phase: 'inspecting' });
    await inspectLlamaArchive(archive);
    onProgress?.({ phase: 'extracting' });
    signal?.throwIfAborted();
    await extractArchive(archive, extracted);
    const found = await findRecursively(
      extracted,
      new Set(executableNames().map((name) => name.toLowerCase())),
      5,
    );
    const executable = found[0];
    if (!executable) throw new Error('Archive does not contain llama-server');
    if (process.platform !== 'win32') await chmod(executable, 0o755);
    if (source.companions?.length) {
      await installCompanionArchives(
        source.companions,
        dirname(executable),
        staging,
        downloadDirectory,
        onProgress,
        signal,
      );
    }
    if (source.releaseUrl?.includes('github.com/ggml-org/llama.cpp/')) {
      onProgress?.({ phase: 'licensing' });
      await copyLicense(source.tag, extracted);
    }
    await writeFile(
      join(extracted, 'THREADSHELF_INSTALL.json'),
      `${JSON.stringify({ source, installedAt: new Date().toISOString() }, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    await rename(extracted, destination).catch(async (error: unknown) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EXDEV') throw error;
      await cp(extracted, destination, { recursive: true, errorOnExist: true });
    });
    const relativeExecutable = executable.slice(extracted.length + 1);
    await rm(archive, { force: true });
    primaryArchive = undefined;
    return {
      installDirectory: destination,
      executablePath: join(destination, relativeExecutable),
      source,
    };
  } catch (error) {
    if (primaryArchive) await cleanupFailedArtifact(primaryArchive, error);
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
};

export const customInstallSource = (
  url: string,
  { sha256, tag = 'custom' }: { sha256?: string; tag?: string } = {},
): InstallSource => {
  const parsed = new URL(url);
  if (!['https:', 'http:'].includes(parsed.protocol)) {
    throw new Error('Custom URL must use HTTPS or HTTP');
  }
  const filename = basename(parsed.pathname);
  if (!filename || (!filename.endsWith('.zip') && !filename.match(/\.(tar\.gz|tgz)$/))) {
    throw new Error('Custom URL must point to a .zip, .tar.gz, or .tgz archive');
  }
  const normalizedSha = normalizeDigest(sha256);
  if (sha256 && !normalizedSha) throw new Error('Invalid SHA-256 digest');
  return { url: parsed.toString(), filename, sha256: normalizedSha, tag };
};

export const readInstalledSource = async (
  installDirectory: string,
): Promise<InstallSource | null> => {
  try {
    const raw = await readFile(join(installDirectory, 'THREADSHELF_INSTALL.json'), 'utf8');
    return (JSON.parse(raw) as { source?: InstallSource }).source ?? null;
  } catch {
    return null;
  }
};
