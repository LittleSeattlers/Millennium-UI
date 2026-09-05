import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  connectorDecisionUrl,
  createConnectorConsent,
  readConnectorConsent,
} from '../server.mjs';
import { assertLocalConsentRequest, HttpError } from '../security.mjs';

function request({
  host = '127.0.0.1:4318',
  origin,
  remoteAddress = '127.0.0.1',
} = {}) {
  return {
    headers: { host, ...(origin ? { origin } : {}) },
    socket: { remoteAddress },
  };
}

test('the connector approval page accepts only local navigation and local form posts', () => {
  assert.doesNotThrow(() => assertLocalConsentRequest(request()));
  assert.doesNotThrow(() => assertLocalConsentRequest(request({ origin: 'null' })));
  assert.doesNotThrow(() => assertLocalConsentRequest(request({
    origin: 'http://127.0.0.1:4318',
  }), { requireOrigin: true }));

  assert.throws(
    () => assertLocalConsentRequest(request({
      origin: 'https://littleseattlers.github.io',
    }), { requireOrigin: true }),
    (error) => error instanceof HttpError && error.code === 'origin_rejected',
  );
  assert.throws(
    () => assertLocalConsentRequest(request({ remoteAddress: '192.0.2.10' })),
    (error) => error instanceof HttpError && error.code === 'loopback_rejected',
  );
});

test('connector approvals are stateless, signed, and short-lived', () => {
  const control = { consentKey: crypto.randomBytes(32) };
  const input = {
    requestId: 'a'.repeat(22),
    challenge: 'b'.repeat(43),
    returnTo: 'https://littleseattlers.github.io/Millennium-UI/',
  };
  const issuedAt = 1_800_000_000_000;
  const token = createConnectorConsent(control, input, issuedAt);

  assert.deepEqual(readConnectorConsent(control, token, issuedAt + 1), {
    ...input,
    expiresAtMs: issuedAt + 120_000,
  });
  const replacement = token.endsWith('A') ? 'B' : 'A';
  assert.throws(
    () => readConnectorConsent(control, `${token.slice(0, -1)}${replacement}`, issuedAt + 1),
    (error) => error instanceof HttpError && error.code === 'validation',
  );
  assert.throws(
    () => readConnectorConsent({ consentKey: crypto.randomBytes(32) }, token, issuedAt + 1),
    (error) => error instanceof HttpError && error.code === 'validation',
  );
  assert.throws(
    () => readConnectorConsent(control, token, issuedAt + 120_000),
    (error) => error instanceof HttpError && error.code === 'consent_expired',
  );

  for (let index = 0; index < 32; index += 1) {
    const requestId = index.toString(36).padStart(22, '0');
    const next = createConnectorConsent(control, { ...input, requestId }, issuedAt + index);
    assert.equal(readConnectorConsent(control, next, issuedAt + 100).requestId, requestId);
  }
});

test('connector decisions return only to the configured public dashboard', () => {
  assert.equal(
    connectorDecisionUrl('https://littleseattlers.github.io/Millennium-UI/?deploy=test', 'allow'),
    'https://littleseattlers.github.io/Millennium-UI/?deploy=test&connector=approved#local-codex',
  );
  assert.equal(
    connectorDecisionUrl('https://littleseattlers.github.io/Millennium-UI/', 'deny'),
    'https://littleseattlers.github.io/Millennium-UI/?connector=denied#local-codex',
  );
});
