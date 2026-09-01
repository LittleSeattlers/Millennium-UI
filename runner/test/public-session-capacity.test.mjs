import assert from 'node:assert/strict';
import test from 'node:test';
import { createPublicSession } from '../server.mjs';

function publicControl() {
  return {
    sessions: new Map(),
    attemptOwners: new Map(),
    startRequests: new Map(),
  };
}

test('a new pairing evicts the oldest idle session without touching active work', () => {
  const control = publicControl();
  const sessions = Array.from({ length: 8 }, (_, index) => (
    createPublicSession(control, 'https://littleseattlers.github.io', 1_000 + index)
  ));
  const protectedSession = sessions[0];
  const pendingSession = sessions[1];
  const oldestIdleSession = sessions[2];
  control.attemptOwners.set('active-attempt', protectedSession.id);
  control.attemptOwners.set('old-terminal-attempt', oldestIdleSession.id);
  control.startRequests.set('pending-request', { sessionId: pendingSession.id, status: 'starting' });
  control.startRequests.set('old-request', { sessionId: oldestIdleSession.id, status: 'failed' });

  const replacement = createPublicSession(
    control,
    'https://littleseattlers.github.io',
    2_000,
    new Set([protectedSession.id, pendingSession.id]),
  );

  assert.equal(control.sessions.size, 8);
  assert.equal(control.sessions.has(protectedSession.id), true);
  assert.equal(control.sessions.has(pendingSession.id), true);
  assert.equal(control.sessions.has(oldestIdleSession.id), false);
  assert.equal(control.sessions.has(replacement.id), true);
  assert.equal(control.attemptOwners.get('active-attempt'), protectedSession.id);
  assert.equal(control.attemptOwners.has('old-terminal-attempt'), false);
  assert.equal(control.startRequests.has('pending-request'), true);
  assert.equal(control.startRequests.has('old-request'), false);
});
