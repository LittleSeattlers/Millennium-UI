import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  CONNECTOR_PROTOCOL,
  connectorStatePath,
  parseConnectorUrl,
} from '../connector.mjs';
import { RUNNER_PORT } from '../constants.mjs';
import {
  connectorProtocolCommand,
  connectorStartupCommand,
} from '../install-connector.mjs';

const REQUEST_ID = 'a'.repeat(22);
const CHALLENGE = 'b'.repeat(43);

test('the public connector uses its isolated protocol, state directory, and port', () => {
  assert.equal(CONNECTOR_PROTOCOL, 'littleseattlers-millennium-ui:');

  const stateFile = connectorStatePath({ LOCALAPPDATA: path.join('C:', 'LocalAppData') });
  assert.equal(path.basename(path.dirname(stateFile)), 'Millennium-UI');
  assert.equal(path.basename(stateFile), 'connector.json');

  assert.equal(RUNNER_PORT, 4318);
});

test('the public connector rejects launch URLs from the legacy private namespace', () => {
  const legacyUrl = `littleseattlers-millennium://connect/v1?request_id=${REQUEST_ID}&challenge=${CHALLENGE}`;
  assert.throws(
    () => parseConnectorUrl(legacyUrl),
    /not a Millennium connector request/,
  );
});

test('the installer registers a hidden background start command', () => {
  const nodePath = String.raw`C:\Runtime\node.exe`;
  const scriptPath = String.raw`D:\Millennium-UI\runner\protocol.mjs`;
  assert.match(connectorProtocolCommand(nodePath, scriptPath), /protocol\.mjs" "%1"$/);
  const startup = connectorStartupCommand(nodePath, scriptPath);
  assert.match(startup, /-WindowStyle Hidden/);
  assert.match(startup, /protocol\.mjs' --start"$/);
});
