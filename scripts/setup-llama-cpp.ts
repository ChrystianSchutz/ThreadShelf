#!/usr/bin/env node
import { createInterface } from 'readline/promises';
import { stdin, stdout } from 'process';
import { pathToFileURL } from 'url';
import {
  customInstallSource,
  defaultLlamaInstallRoot,
  findLlamaExecutables,
  installLlamaCpp,
  managedLlamaBuild,
  resolveLlamaRelease,
  selectReleaseAsset,
  sourceFromRelease,
  type LlamaVariant,
} from '../src/generation/llama-install.js';

interface Arguments {
  readonly install: boolean;
  readonly yes: boolean;
  readonly check: boolean;
  readonly url?: string;
  readonly sha256?: string;
  readonly tag?: string;
  readonly destination?: string;
  readonly release?: string;
  readonly variant: LlamaVariant;
}

const valueAfter = (args: readonly string[], flag: string): string | undefined => {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
  return value;
};

export const parseArguments = (args: readonly string[]): Arguments => {
  const variant = (valueAfter(args, '--variant') || 'cpu') as LlamaVariant;
  if (!['cpu', 'vulkan', 'cuda', 'rocm', 'sycl'].includes(variant)) {
    throw new Error(`Unknown --variant: ${variant}`);
  }
  return {
    install: args.includes('--install'),
    yes: args.includes('--yes'),
    check: args.includes('--check'),
    url: valueAfter(args, '--url'),
    sha256: valueAfter(args, '--sha256'),
    tag: valueAfter(args, '--tag'),
    destination: valueAfter(args, '--destination'),
    release: valueAfter(args, '--release'),
    variant,
  };
};

const usage = (): void => {
  console.log(`ThreadShelf llama.cpp setup — EXPERIMENTAL BETA

With no arguments this command only searches for an existing llama-server.
It never downloads or installs unless you explicitly pass --install or --url.

  npm run setup:llama                         local discovery only
  npm run setup:llama -- -- --check              show the latest compatible release
  npm run setup:llama -- -- --install            confirm, then install official latest
  npm run setup:llama -- -- --install --yes      non-interactive explicit consent
  npm run setup:llama -- -- --url URL [--sha256 HEX] [--tag NAME]

Options:
  --variant cpu|vulkan|cuda|rocm|sycl          default: cpu (Metal is automatic on macOS)
  --release bNNNNN                            pin an exact upstream build
  --destination PATH                          default: ${defaultLlamaInstallRoot()}
  --yes                                       skip the confirmation prompt

Official artifacts come from ggml-org/llama.cpp GitHub Releases and their
published SHA-256 digest is verified. Custom URLs should include --sha256.`);
};

const confirmInstall = async (summary: string): Promise<boolean> => {
  if (!stdin.isTTY || !stdout.isTTY) return false;
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await prompt.question(`${summary}\nType "install" to continue: `);
    return answer.trim().toLowerCase() === 'install';
  } finally {
    prompt.close();
  }
};

export const main = async (argv: readonly string[] = process.argv.slice(2)): Promise<void> => {
  if (argv.includes('--help') || argv.includes('-h')) {
    usage();
    return;
  }
  const args = parseArguments(argv);
  const existing = await findLlamaExecutables({ installRoot: args.destination });
  console.log(
    existing.length
      ? `Found llama-server:\n${existing.map((path) => `  ${path}`).join('\n')}`
      : 'No existing llama-server found in PATH or ThreadShelf tool directories.',
  );

  if (!args.install && !args.url && !args.check) {
    console.log('\nDiscovery finished. No files were downloaded or installed.');
    usage();
    return;
  }

  const release = args.url ? null : await resolveLlamaRelease({ tag: args.release });
  if (args.check && !args.install && !args.url) {
    const asset = selectReleaseAsset(release!, { variant: args.variant });
    console.log(`Latest compatible official release: ${release!.tag_name}`);
    console.log(`Asset: ${asset.name}`);
    console.log(`Release: ${release!.html_url}`);
    const installed = existing
      .map(managedLlamaBuild)
      .filter((build): build is NonNullable<typeof build> => build !== null)
      .sort((left, right) => right.build - left.build)[0];
    const latestBuild = Number(release!.tag_name.replace(/^b/i, ''));
    if (installed && Number.isFinite(latestBuild)) {
      console.log(
        installed.build >= latestBuild
          ? `Installed managed build ${installed.tag}-${installed.flavor} is up to date.`
          : `Update available: ${installed.tag}-${installed.flavor} → ${release!.tag_name}. ` +
              `Install it with: npm run setup:llama -- -- --install --variant ${installed.flavor}`,
      );
    }
    console.log('No files were downloaded or installed.');
    return;
  }

  const source = args.url
    ? customInstallSource(args.url, { sha256: args.sha256, tag: args.tag })
    : sourceFromRelease(release!, { variant: args.variant });
  if (!source.sha256) {
    console.warn('WARNING: this custom archive has no SHA-256 digest and cannot be authenticated.');
  }
  const summary = [
    'Explicit download/install approval required.',
    `Source: ${source.url}`,
    `SHA-256: ${source.sha256 || 'NOT PROVIDED'}`,
    ...(source.companions ?? []).flatMap((companion) => [
      `Required companion: ${companion.url}`,
      `Companion SHA-256: ${companion.sha256}`,
    ]),
    `Destination root: ${args.destination || defaultLlamaInstallRoot()}`,
  ].join('\n');
  // Supplying a custom URL is itself explicit consent, per the CLI contract.
  // Official auto-selected downloads still require --yes or the typed prompt.
  if (!args.url && !args.yes && !(await confirmInstall(summary))) {
    throw new Error(
      'Installation cancelled; no archive was downloaded. Pass --yes for explicit non-interactive consent.',
    );
  }

  let lastProgress = '';
  const result = await installLlamaCpp(source, {
    installRoot: args.destination,
    onProgress: (progress) => {
      const percent =
        progress.phase === 'downloading' && progress.totalBytes
          ? Math.floor((100 * (progress.downloadedBytes || 0)) / progress.totalBytes / 10) * 10
          : undefined;
      const message =
        percent === undefined ? progress.phase : `${progress.phase} ${Math.min(percent, 100)}%`;
      if (message !== lastProgress) {
        console.log(message);
        lastProgress = message;
      }
    },
  });
  console.log(`Installed llama.cpp ${source.tag} at ${result.installDirectory}`);
  console.log(`llama-server: ${result.executablePath}`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
