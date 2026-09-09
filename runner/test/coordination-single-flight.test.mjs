import assert from 'node:assert/strict';
import test from 'node:test';
import { CoordinationSingleFlight } from '../attempts.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('coordination sync shares concurrent work and serializes a forced refresh', async () => {
  const gate = new CoordinationSingleFlight();
  const firstRelease = deferred();
  const calls = [];
  let active = 0;
  let maxActive = 0;

  const operation = async (force) => {
    calls.push(force);
    active += 1;
    maxActive = Math.max(maxActive, active);
    if (calls.length === 1) await firstRelease.promise;
    active -= 1;
    return calls.length;
  };

  const first = gate.run(false, operation);
  const shared = gate.run(false, operation);
  const forced = gate.run(true, operation);
  await Promise.resolve();
  assert.deepEqual(calls, [false]);

  firstRelease.resolve();
  assert.equal(await first, 1);
  assert.equal(await shared, 1);
  assert.equal(await forced, 2);
  assert.deepEqual(calls, [false, true]);
  assert.equal(maxActive, 1);
});

test('a forced coordination refresh retries after shared background work fails', async () => {
  const gate = new CoordinationSingleFlight();
  const firstRelease = deferred();
  const calls = [];

  const operation = async (force) => {
    calls.push(force);
    if (!force) {
      await firstRelease.promise;
      throw new Error('background sync failed');
    }
    return 'recovered';
  };

  const background = gate.run(false, operation);
  const shared = gate.run(false, operation);
  const forced = gate.run(true, operation);
  await Promise.resolve();
  firstRelease.resolve();

  await assert.rejects(background, /background sync failed/);
  await assert.rejects(shared, /background sync failed/);
  assert.equal(await forced, 'recovered');
  assert.deepEqual(calls, [false, true]);
});
