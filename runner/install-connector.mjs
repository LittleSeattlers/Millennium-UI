import { spawnSync } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const PROTOCOL_SCRIPT = path.join(HERE, 'protocol.mjs');
const REGISTRY_ROOT = 'HKCU\\Software\\Classes\\littleseattlers-millennium-ui';
const STARTUP_REGISTRY_ROOT = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const STARTUP_VALUE = 'MillenniumUIConnector';

export function connectorProtocolCommand(nodePath = process.execPath, scriptPath = PROTOCOL_SCRIPT) {
  if ([nodePath, scriptPath].some((value) => String(value).includes('"'))) {
    throw new Error('Connector paths may not contain quotation marks.');
  }
  return `"${nodePath}" "${scriptPath}" "%1"`;
}

export function connectorStartupCommand(nodePath = process.execPath, scriptPath = PROTOCOL_SCRIPT) {
  if ([nodePath, scriptPath].some((value) => /["']/.test(String(value)))) {
    throw new Error('Connector startup paths may not contain quotation marks.');
  }
  return `powershell.exe -NoLogo -NoProfile -WindowStyle Hidden -Command "& '${nodePath}' '${scriptPath}' --start"`;
}
export async function installConnector() {
  if (process.platform !== 'win32') throw new Error('The automatic connector installer currently supports Windows only.');
  await access(path.join(REPO_ROOT, 'node_modules', '@openai', 'codex', 'package.json')).catch(() => {
    throw new Error('Run `pnpm install` in the public Millennium-UI repository before installing the connector.');
  });

  requireCommand('git.exe', ['--version'], 'Install Git for Windows before installing the Millennium Connector.');
  requireCommand('gh.exe', ['auth', 'status', '--hostname', 'github.com'], 'Sign in once with `gh auth login` before installing the Millennium Connector.');
  requireCommand('gh.exe', ['auth', 'setup-git', '--hostname', 'github.com'], 'GitHub CLI could not configure Git authentication.');

  const command = connectorProtocolCommand();
  const startupCommand = connectorStartupCommand();
  reg(['ADD', REGISTRY_ROOT, '/ve', '/t', 'REG_SZ', '/d', 'URL:Millennium Connector', '/f']);
  reg(['ADD', REGISTRY_ROOT, '/v', 'URL Protocol', '/t', 'REG_SZ', '/d', '', '/f']);
  reg(['ADD', `${REGISTRY_ROOT}\\DefaultIcon`, '/ve', '/t', 'REG_SZ', '/d', `${process.execPath},0`, '/f']);
  reg(['ADD', `${REGISTRY_ROOT}\\shell\\open\\command`, '/ve', '/t', 'REG_SZ', '/d', command, '/f']);
  reg(['ADD', STARTUP_REGISTRY_ROOT, '/v', STARTUP_VALUE, '/t', 'REG_SZ', '/d', startupCommand, '/f']);
  startConnector();
  return command;
}

export function uninstallConnector() {
  if (process.platform !== 'win32') throw new Error('The automatic connector installer currently supports Windows only.');
  reg(['DELETE', REGISTRY_ROOT, '/f']);
  reg(['DELETE', STARTUP_REGISTRY_ROOT, '/v', STARTUP_VALUE, '/f'], { ignoreMissing: true });
}

function reg(args, { ignoreMissing = false } = {}) {
  const result = spawnSync('reg.exe', args, { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0 && !ignoreMissing) {
    throw new Error((result.stderr || result.stdout || 'Windows registry update failed.').trim());
  }
}

function startConnector() {
  const result = spawnSync(process.execPath, [PROTOCOL_SCRIPT, '--start'], {
    encoding: 'utf8',
    timeout: 270_000,
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'The Millennium Connector could not start.').trim());
  }
}

function requireCommand(command, args, failureMessage) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(failureMessage);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.includes('--uninstall')) {
      uninstallConnector();
      console.log('Millennium Connector was removed from this Windows account.');
    } else {
      await installConnector();
      console.log('Millennium Connector is installed for this Windows account.');
      console.log('It is running now and will start automatically when you sign in to Windows.');
      console.log('The public page can now connect through its local approval window.');
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
