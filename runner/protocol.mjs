import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  acquireConnectorLaunchLock,
  clearConnectorState,
  createControlToken,
  isProcessAlive,
  parseConnectorUrl,
  readConnectorState,
  writeConnectorState,
} from './connector.mjs';
import { RUNNER_HOST, RUNNER_PORT, RUNNER_VERSION } from './constants.mjs';
import { showConnectorMessage } from './native-dialog.mjs';

const PUBLIC_SCRIPT = fileURLToPath(new URL('./public.mjs', import.meta.url));
const launchRequest = process.argv[2];
const startOnly = launchRequest === '--start';
let releaseLaunchLock = null;

try {
  await launchConnector();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (startOnly) console.error(message);
  else await showConnectorMessage(message);
  process.exitCode = 1;
} finally {
  await releaseLaunchLock?.();
}

async function launchConnector() {
  if (process.platform !== 'win32') throw new Error('The automatic Millennium Connector currently supports Windows only.');
  const ticket = startOnly ? null : parseConnectorUrl(launchRequest);
  releaseLaunchLock = await acquireConnectorLaunchLock();
  const existing = await readConnectorState();
  if (existing && isProcessAlive(existing.pid)) {
    const outcome = startOnly
      ? await readConnectorStatus(existing.controlToken, existing.pid)
      : await armConnector(existing.controlToken, ticket);
    if (outcome.kind === 'success') return;
    if (startOnly && outcome.kind === 'outdated') {
      if (outcome.runnerBusy) {
        throw new Error('The older Millennium Connector is running research. Stop that work, then reinstall the connector.');
      }
      await replaceVerifiedConnector(existing);
    } else if (startOnly && outcome.kind === 'mismatch') {
      const legacy = await readLegacyConnectorStatus(existing.controlToken);
      if (legacy.kind !== 'success') {
        throw new Error(
          `Port ${RUNNER_PORT} is occupied by a connector that could not be verified. Close it once, then reinstall the connector.`,
        );
      }
      if (legacy.runnerBusy) {
        throw new Error('The older Millennium Connector is running research. Stop that work, then reinstall the connector.');
      }
      await replaceVerifiedConnector(existing);
    } else if (outcome.kind !== 'mismatch') {
      const startedAt = Date.parse(existing.startedAt ?? '');
      const stateIsOld = !Number.isFinite(startedAt) || Date.now() - startedAt > 150_000;
      if (
        outcome.kind === 'transient'
        && stateIsOld
        && !(await portIsListening())
        && (await processRunsPublicConnector(existing.pid)) === false
      ) {
        await clearConnectorState(existing.controlToken);
      } else {
        throw new Error(outcome.kind === 'rejected'
          ? 'The local connector rejected this launch ticket. Wait a minute, then click Connect again.'
          : 'The local connector is still starting. Wait a moment, then click Connect again.');
      }
    } else {
      if (await portIsListening()) {
        throw new Error(
          `Port ${RUNNER_PORT} is occupied by a connector that could not be verified. Close it once, then click Connect again.`,
        );
      }
      await clearConnectorState(existing.controlToken);
    }
  } else if (existing) {
    await clearConnectorState(existing.controlToken);
  }

  if (await portIsListening()) {
    throw new Error(
      `Port ${RUNNER_PORT} is already occupied by an unrecognized process. Close that process once, then click Connect again.`,
    );
  }

  const controlToken = createControlToken();
  const child = await spawnConnector(controlToken);
  await writeConnectorState({ pid: child.pid, controlToken });

  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    await delay(250);
    if (!isProcessAlive(child.pid)) break;
    const outcome = startOnly
      ? await readConnectorStatus(controlToken, child.pid)
      : await armConnector(controlToken, ticket);
    if (outcome.kind === 'success') return;
    if (outcome.kind === 'rejected') {
      throw new Error('The local connector rejected this launch ticket. Wait a minute, then click Connect again.');
    }
  }
  if (!isProcessAlive(child.pid)) {
    await clearConnectorState(controlToken);
    throw new Error('The local connector did not start. Reinstall it from the public Millennium-UI repository and try again.');
  }
  // A slow local disk or security scan can delay first listen. Preserve the
  // live process and its token so the next click can reuse it safely.
  throw new Error('The local connector is still starting. Wait a moment, then click Connect again.');
}

async function armConnector(controlToken, ticket) {
  try {
    const response = await fetch(`http://${RUNNER_HOST}:${RUNNER_PORT}/api/v1/native/tickets`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${controlToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(ticket),
      signal: AbortSignal.timeout(1200),
    });
    if (response.ok) return { kind: 'success', status: response.status };
    if ([401, 403, 404].includes(response.status)) return { kind: 'mismatch', status: response.status };
    if ([400, 409].includes(response.status)) return { kind: 'rejected', status: response.status };
    return { kind: 'transient', status: response.status };
  } catch {
    return { kind: 'transient', status: null };
  }
}

async function readConnectorStatus(controlToken, expectedPid) {
  try {
    const response = await fetch(`http://${RUNNER_HOST}:${RUNNER_PORT}/api/v1/native/status`, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${controlToken}`,
      },
      signal: AbortSignal.timeout(1200),
    });
    if (response.ok) {
      const payload = await response.json().catch(() => null);
      if (
        payload?.ok !== true
        || payload.pid !== expectedPid
        || typeof payload.version !== 'string'
        || typeof payload.runnerBusy !== 'boolean'
      ) return { kind: 'mismatch', status: response.status };
      if (payload.version !== RUNNER_VERSION) {
        return { kind: 'outdated', status: response.status, runnerBusy: payload.runnerBusy };
      }
      return { kind: 'success', status: response.status };
    }
    if ([401, 403, 404].includes(response.status)) return { kind: 'mismatch', status: response.status };
    return { kind: 'transient', status: response.status };
  } catch {
    return { kind: 'transient', status: null };
  }
}

async function readLegacyConnectorStatus(controlToken) {
  const now = Date.now();
  try {
    const response = await fetch(`http://${RUNNER_HOST}:${RUNNER_PORT}/api/v1/native/tickets`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${controlToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        requestId: crypto.randomBytes(16).toString('base64url'),
        challenge: crypto.randomBytes(32).toString('base64url'),
      }),
      signal: AbortSignal.timeout(1200),
    });
    if (!response.ok) return { kind: 'mismatch', status: response.status };
    const payload = await response.json().catch(() => null);
    const expiresAtMs = Date.parse(payload?.expiresAt ?? '');
    if (
      payload?.armed !== true
      || typeof payload.runnerBusy !== 'boolean'
      || !Number.isFinite(expiresAtMs)
      || expiresAtMs < now
      || expiresAtMs > now + 120_000
    ) return { kind: 'mismatch', status: response.status };
    return { kind: 'success', status: response.status, runnerBusy: payload.runnerBusy };
  } catch {
    return { kind: 'transient', status: null };
  }
}

async function replaceVerifiedConnector(existing) {
  const current = await readConnectorState();
  const ownerPid = await connectorListeningPid();
  if (
    !current
    || current.pid !== existing.pid
    || current.controlToken !== existing.controlToken
    || ownerPid !== existing.pid
  ) {
    throw new Error('The older Millennium Connector changed while it was being upgraded. Reinstall it once more.');
  }
  process.kill(existing.pid);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!(await portIsListening())) {
      await clearConnectorState(existing.controlToken);
      return;
    }
    await delay(100);
  }
  throw new Error('The older Millennium Connector did not close cleanly. Close it once, then reinstall the connector.');
}

function connectorListeningPid() {
  return new Promise((resolve) => {
    execFile('netstat.exe', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      const localAddress = `${RUNNER_HOST}:${RUNNER_PORT}`;
      for (const line of stdout.split(/\r?\n/)) {
        const fields = line.trim().split(/\s+/);
        if (
          fields.length >= 5
          && fields[0].toUpperCase() === 'TCP'
          && fields[1] === localAddress
          && fields[2] === '0.0.0.0:0'
          && /^\d+$/.test(fields[fields.length - 1])
        ) {
          resolve(Number(fields[fields.length - 1]));
          return;
        }
      }
      resolve(null);
    });
  });
}

function processRunsPublicConnector(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return Promise.resolve(false);
  const command = `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`;
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
      { encoding: 'utf8', windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        const normalized = stdout.trim().toLowerCase();
        resolve(
          normalized.includes(process.execPath.toLowerCase())
          && normalized.includes(PUBLIC_SCRIPT.toLowerCase()),
        );
      },
    );
  });
}

function spawnConnector(controlToken) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PUBLIC_SCRIPT], {
      detached: true,
      env: {
        ...process.env,
        MILLENNIUM_CONNECTOR_MODE: '1',
        MILLENNIUM_NATIVE_CONTROL_TOKEN: controlToken,
      },
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve(child);
    });
  });
}

function portIsListening() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: RUNNER_HOST, port: RUNNER_PORT });
    const finish = (value) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}
