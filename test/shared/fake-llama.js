import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./fake-llama-server.mjs', import.meta.url));

const cSharpString = (value) => `@"${value.replaceAll('"', '""')}"`;

// Windows can only spawn a real PE file named llama-server.exe, so compile a
// tiny launcher with the C# compiler that ships with .NET Framework.
const windowsLauncher = () => `
using System;
using System.Diagnostics;
class Program {
  static int Main() {
    string line = Environment.CommandLine;
    int index = 0;
    if (line.StartsWith("\\"")) index = line.IndexOf('"', 1) + 1;
    else { index = line.IndexOf(' '); if (index < 0) index = line.Length; }
    string rest = line.Substring(index);
    var info = new ProcessStartInfo(${cSharpString(process.execPath)},
      "\\"" + ${cSharpString(script)} + "\\"" + rest);
    info.UseShellExecute = false;
    using (var child = Process.Start(info)) {
      child.WaitForExit();
      return child.ExitCode;
    }
  }
}
`;

const windowsCompiler = () => {
  const root = process.env.WINDIR || 'C:\\Windows';
  return [
    join(root, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    join(root, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ].find((candidate) => existsSync(candidate));
};

/** Reason the fake llama-server cannot be built on this machine, or undefined. */
export const fakeLlamaUnavailable = () =>
  process.platform === 'win32' && !windowsCompiler()
    ? 'the .NET Framework C# compiler is needed to build a fake llama-server.exe'
    : undefined;

/** Creates `<directory>/llama-server[.exe]` that runs test/shared/fake-llama-server.mjs. */
export const createFakeLlamaServer = async (directory) => {
  await mkdir(directory, { recursive: true });
  if (process.platform !== 'win32') {
    const executable = join(directory, 'llama-server');
    await writeFile(executable, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    await chmod(executable, 0o755);
    return executable;
  }
  const source = join(directory, 'launcher.cs');
  const executable = join(directory, 'llama-server.exe');
  await writeFile(source, windowsLauncher());
  const result = spawnSync(
    windowsCompiler(),
    ['/nologo', '/target:exe', `/out:${executable}`, source],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`Could not compile fake llama-server.exe:\n${result.stdout}${result.stderr}`);
  }
  return executable;
};
