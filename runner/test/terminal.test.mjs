import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyTerminalDisposition,
  publicContributionSource,
  publicTerminalDisposition,
} from '../terminal.mjs';

test('classifies the supported terminal causes without exposing raw reasons', () => {
  assert.equal(classifyTerminalDisposition({ status: 'completed' }), 'completed');
  assert.equal(classifyTerminalDisposition({ status: 'interrupted', stopReason: 'safe time budget exhausted' }), 'time-limit');
  assert.equal(classifyTerminalDisposition({ status: 'interrupted', stopReason: 'user' }), 'user-stopped');
  assert.equal(classifyTerminalDisposition({ status: 'failed', stopReason: 'provider error included private detail' }), 'provider-failed');
  assert.equal(classifyTerminalDisposition({ status: 'interrupted', stopReason: 'local runner shutting down' }), 'runner-stopped');
  assert.equal(classifyTerminalDisposition({ status: 'interrupted' }), 'provider-interrupted');
});

test('public disposition rejects arbitrary persisted prose', () => {
  assert.equal(publicTerminalDisposition('interrupted', 'time-limit'), 'time-limit');
  assert.equal(publicTerminalDisposition('interrupted', 'runner-interrupted'), 'runner-stopped');
  assert.equal(publicTerminalDisposition('interrupted', 'private quota text'), 'provider-interrupted');
  assert.equal(publicTerminalDisposition('failed', 'secret provider failure details'), 'provider-failed');
  assert.equal(publicTerminalDisposition('interrupted', 'interrupted', {
    elapsedSeconds: 299,
    allowedMinutes: 5,
  }), 'time-limit');
});

test('reports structured versus fallback contribution without exposing content', () => {
  assert.equal(publicContributionSource({ status: 'submitted', usedStructuredProposal: true }), 'structured-proposal');
  assert.equal(publicContributionSource({ status: 'submitted', usedStructuredProposal: false }), 'privacy-safe-fallback');
  assert.equal(publicContributionSource({ status: 'submitted', warning: 'legacy fallback warning' }), 'privacy-safe-fallback');
  assert.equal(publicContributionSource({ status: 'submitted', warning: null }), 'structured-proposal');
  assert.equal(publicContributionSource({ status: 'failed', usedStructuredProposal: true }), null);
});
