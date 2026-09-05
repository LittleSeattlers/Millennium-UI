import crypto from 'node:crypto';
import { mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const CONNECTOR_PROTOCOL = 'littleseattlers-millennium-ui:';
export const CONNECTOR_HOST = 'connect';
export const CONNECTOR_STATE_VERSION = 2;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function normalizePairingCode(value) {
  return String(value ?? '').replace(/[\s-]/g, '').toUpperCase();
}
export function requirePairingCode(value) {
  const code = normalizePairingCode(value);
  if (!/^[A-Z0-9]{32,64}$/.test(code)) {
    throw new Error('The connector pairing code must contain 32-64 letters or digits.');
  }
  return code;
}

export function parseConnectorUrl(value) {
  const source = String(value ?? '');
  if (source.length > 512 || /[\u0000-\u001f\u007f]/.test(source)) {
    throw new Error('The Millennium connector request is malformed.');
  }
  const url = new URL(source);
  if (url.protocol !== CONNECTOR_PROTOCOL || url.hostname !== CONNECTOR_HOST) {
    throw new Error('This is not a Millennium connector request.');
  }
  if (url.username || url.password || url.port || url.pathname !== '/v1' || url.hash) {
    throw new Error('The Millennium connector request is malformed.');
  }
  const keys = [...url.searchParams.keys()].sort();
  if (keys.length !== 2 || keys[0] !== 'challenge' || keys[1] !== 'request_id') {
    throw new Error('The Millennium connector request contains unsupported fields.');
  }
  const requestId = url.searchParams.get('request_id') ?? '';
  const challenge = url.searchParams.get('challenge') ?? '';
  if (!REQUEST_ID_PATTERN.test(requestId) || !CHALLENGE_PATTERN.test(challenge)) {
    throw new Error('The Millennium connector request contains an invalid launch ticket.');
  }
  return { requestId, challenge };
}

export function createControlToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export function connectorStatePath(environment = process.env) {
  const base = environment.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'Millennium-UI', 'connector.json');
}

export function connectorLockPath(environment = process.env) {
  return path.join(path.dirname(connectorStatePath(environment)), 'connector-launch.lock');
}

export async function acquireConnectorLaunchLock({
  lockFile = connectorLockPath(),
  timeoutMs = 15_000,
} = {}) {
  await mkdir(path.dirname(lockFile), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const handle = await open(lockFile, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`, 'utf8');
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await handle.close().catch(() => undefined);
        await rm(lockFile, { force: true });
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (await launchLockIsStale(lockFile)) {
        await rm(lockFile, { force: true });
        continue;
      }
      await delay(100);
    }
  }
  throw new Error('Another Millennium Connector launch is still in progress. Wait a moment and click Connect again.');
}

export async function readConnectorState(stateFile = connectorStatePath()) {
  try {
    const value = JSON.parse(await readFile(stateFile, 'utf8'));
    if (
      value?.version !== CONNECTOR_STATE_VERSION
      || !Number.isSafeInteger(value.pid)
      || value.pid < 1
      || !/^[A-Za-z0-9_-]{32,}$/.test(value.controlToken ?? '')
    ) return null;
    return {
      version: CONNECTOR_STATE_VERSION,
      pid: value.pid,
      controlToken: value.controlToken,
      startedAt: typeof value.startedAt === 'string' ? value.startedAt : null,
    };
  } catch {
    return null;
  }
}

export async function writeConnectorState(state, stateFile = connectorStatePath()) {
  const value = {
    version: CONNECTOR_STATE_VERSION,
    pid: state.pid,
    controlToken: state.controlToken,
    startedAt: state.startedAt ?? new Date().toISOString(),
  };
  if (!Number.isSafeInteger(value.pid) || value.pid < 1 || !/^[A-Za-z0-9_-]{32,}$/.test(value.controlToken)) {
    throw new Error('Refusing to write invalid connector state.');
  }
  await mkdir(path.dirname(stateFile), { recursive: true });
  await writeFile(stateFile, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

export async function clearConnectorState(expectedToken = null, stateFile = connectorStatePath()) {
  if (expectedToken) {
    const current = await readConnectorState(stateFile);
    if (!current || !tokensEqual(current.controlToken, expectedToken)) return false;
  }
  await rm(stateFile, { force: true });
  return true;
}

export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function launchLockIsStale(lockFile) {
  try {
    const [raw, metadata] = await Promise.all([readFile(lockFile, 'utf8'), stat(lockFile)]);
    const value = JSON.parse(raw);
    if (Number.isSafeInteger(value?.pid) && value.pid > 0) return !isProcessAlive(value.pid);
    return Date.now() - metadata.mtimeMs > 5_000;
  } catch {
    return false;
  }
}

function tokensEqual(left, right) {
  const actual = Buffer.from(String(left ?? ''), 'utf8');
  const expected = Buffer.from(String(right ?? ''), 'utf8');
  return actual.length > 0 && actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
