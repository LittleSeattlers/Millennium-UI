import crypto from 'node:crypto';
import { normalizePairingCode } from './connector.mjs';
import {
  PUBLIC_UI_ORIGIN,
  PUBLIC_UI_URL,
  RUNNER_HOST,
  RUNNER_PORT,
  RUNNER_VERSION,
} from './constants.mjs';
import { startRunner } from './server.mjs';

const connectorMode = process.env.MILLENNIUM_CONNECTOR_MODE === '1';
const configuredPairingCode = normalizePairingCode(process.env.MILLENNIUM_PAIRING_CODE ?? '');
const rawPairingCode = configuredPairingCode || (connectorMode ? null : crypto.randomBytes(10).toString('hex').toUpperCase());
const displayPairingCode = rawPairingCode?.match(/.{1,4}/g).join('-') ?? null;

process.env.MILLENNIUM_ALLOWED_ORIGINS = [
  PUBLIC_UI_ORIGIN,
  'http://localhost:3001',
  'http://127.0.0.1:3001',
].join(',');

let runner;
try {
  runner = await startRunner({ pairingCode: rawPairingCode });
} catch (error) {
  if (error?.code === 'EADDRINUSE') {
    console.error(`Port ${RUNNER_PORT} is already in use. Stop the older Millennium runner, then run this command again.`);
    process.exit(1);
  }
  throw error;
}

if (!connectorMode) {
  console.log(`Millennium companion ${RUNNER_VERSION} listening on http://${RUNNER_HOST}:${RUNNER_PORT}`);
  console.log('');
  console.log('Keep this terminal open, then:');
  console.log(`1. Open ${PUBLIC_UI_URL}`);
  console.log('2. Choose a problem and research direction.');
  console.log('3. Enter this temporary pairing code:');
  console.log('');
  console.log(`   ${displayPairingCode}`);
  console.log('');
  console.log('The code and every browser session expire when this companion stops.');
  console.log('The pairing code works once. Restart the companion to pair another tab.');
  console.log('Clicking Start authorizes one bounded run and its automatic data-only contribution PR.');
  console.log('Hosted starts keep research network access off. No terminal confirmation is required.');
}

let closing = false;
const shutdown = () => {
  if (closing) return;
  closing = true;
  void runner.close().finally(() => process.exit(0));
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
