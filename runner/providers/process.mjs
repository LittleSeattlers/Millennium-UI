import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs/promises';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

const CODEX_PLATFORM = Object.freeze({
  'win32:x64': ['@openai/codex-win32-x64', 'x86_64-pc-windows-msvc', 'codex.exe'],
  'win32:arm64': ['@openai/codex-win32-arm64', 'aarch64-pc-windows-msvc', 'codex.exe'],
  'darwin:x64': ['@openai/codex-darwin-x64', 'x86_64-apple-darwin', 'codex'],
  'darwin:arm64': ['@openai/codex-darwin-arm64', 'aarch64-apple-darwin', 'codex'],
  'linux:x64': ['@openai/codex-linux-x64', 'x86_64-unknown-linux-musl', 'codex'],
  'linux:arm64': ['@openai/codex-linux-arm64', 'aarch64-unknown-linux-musl', 'codex'],
});

export async function resolveCodexExecutable(override) {
  if (override) return resolveExecutable('codex', override);
  const packaged = await resolvePackagedCodex();
  if (packaged) return { path: packaged, wrapper: false, reason: null, source: 'project-package' };
  return resolveExecutable('codex');
}
async function resolvePackagedCodex() {
  const platform = CODEX_PLATFORM[`${process.platform}:${process.arch}`];
  if (!platform) return null;
  const [platformPackage, targetTriple, executable] = platform;
  try {
    const codexPackageJson = require.resolve('@openai/codex/package.json');
    const codexRequire = createRequire(codexPackageJson);
    const platformPackageJson = codexRequire.resolve(`${platformPackage}/package.json`);
    const candidate = path.join(path.dirname(platformPackageJson), 'vendor', targetTriple, 'bin', executable);
    const stat = await fs.stat(candidate);
    return stat.isFile() ? candidate : null;
  } catch {
    return null;
  }
}
export async function resolveExecutable(name, override) {
  if (override) {
    if (!path.isAbsolute(override)) return { path: null, reason: 'Configured executable path must be absolute.' };
    try {
      const stat = await fs.stat(override);
      if (!stat.isFile()) return { path: null, reason: 'Configured executable is not a file.' };
      return classifyResolvedPath(override);
    } catch {
      return { path: null, reason: 'Configured executable does not exist.' };
    }
  }

  const locator = process.platform === 'win32' ? 'where.exe' : 'which';
  try {
    const { stdout } = await execFileAsync(locator, [name], {
      windowsHide: true,
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    });
    const candidates = stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    if (process.platform === 'win32') {
      const native = candidates.find((candidate) => /\.(?:exe|com)$/i.test(candidate));
      if (native) return { path: native, wrapper: false, reason: null };
      if (candidates[0]) return classifyResolvedPath(candidates[0]);
    } else if (candidates[0]) {
      return { path: candidates[0], wrapper: false, reason: null };
    }
  } catch {
    // The caller receives a stable not-installed state below.
  }
  return { path: null, wrapper: false, reason: `${name} was not found on PATH.` };
}

function classifyResolvedPath(candidate) {
  const wrapper = process.platform === 'win32' && /\.(?:cmd|bat|ps1)$/i.test(candidate);
  return {
    path: wrapper ? null : candidate,
    wrapper,
    discoveredPath: candidate,
    reason: wrapper ? 'Only a shell wrapper was found; install the native CLI executable.' : null,
  };
}

export function spawnNative(executable, args, options = {}) {
  if (!executable || (process.platform === 'win32' && !/\.(?:exe|com)$/i.test(executable))) {
    throw new Error('A native executable is required; shell wrappers are refused.');
  }
  return spawn(executable, args, {
    shell: false,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
    ...options,
  });
}

export async function runCapture(executable, args, { cwd, env, timeoutMs = 7_000, maxBytes = 128 * 1024 } = {}) {
  const child = spawnNative(executable, args, { cwd, env });
  let stdout = '';
  let stderr = '';
  let overflow = false;

  const append = (current, chunk) => {
    if (Buffer.byteLength(current) + chunk.length > maxBytes) {
      overflow = true;
      return current;
    }
    return current + chunk.toString('utf8');
  };
  child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
  child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void stopProcessTree(child, 500);
  }, timeoutMs);
  timer.unref?.();

  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(timer));

  return { ...result, stdout, stderr, overflow, timedOut };
}

export async function stopProcessTree(child, graceMs = 2_500) {
  if (!child || child.exitCode !== null || !Number.isInteger(child.pid)) return;
  const pid = child.pid;
  if (process.platform === 'win32') {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
    await new Promise((resolve) => setTimeout(resolve, graceMs));
    if (child.exitCode !== null) return;
    await new Promise((resolve) => {
      const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.once('error', resolve);
      killer.once('close', resolve);
    });
    return;
  }

  try { process.kill(-pid, 'SIGTERM'); } catch { return; }
  await new Promise((resolve) => setTimeout(resolve, graceMs));
  if (child.exitCode === null) {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}
