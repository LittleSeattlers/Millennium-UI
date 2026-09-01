import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { listResearchFrontier, prepareResearchTask } from '../frontier.mjs';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'millennium-frontier-'));
  const catalogFile = path.join(root, 'frontier.json');
  const leasesFile = path.join(root, 'leases.json');
  const task = {
    id: 'ns.blowup.seed-task',
    problemId: 'ns',
    direction: 'blowup',
    branchId: 'seed-branch',
    kind: 'computation',
    title: 'Test one bounded blow-up diagnostic',
    objective: 'Specify one exact finite-dimensional diagnostic and determine what it can and cannot imply about finite-time breakdown.',
    rationale: 'A sharply bounded diagnostic can falsify an intermediate assumption without overclaiming a continuum theorem.',
    successCriteria: 'Produce an exact calculation and state the bridge that would still be required for the continuum problem.',
    usefulFailureCriteria: 'Identify a precise ambiguity, unstable step, or missing bound that prevents the diagnostic from being trusted.',
    verificationMethod: 'Recompute every finite step independently using exact arithmetic and compare the resulting certificate.',
    suggestedMinutes: 15,
    priority: 80,
    dependencies: [],
  };
  await fs.writeFile(catalogFile, JSON.stringify({ schemaVersion: 1, tasks: [task] }));
  return { root, catalogFile, leasesFile, task };
}

test('an active GitHub claim removes a task from recommendation', async (t) => {
  const value = await fixture();
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const now = Date.now();
  const frontier = await listResearchFrontier({
    problemId: 'ns',
    direction: 'blowup',
    safeMinutes: 15,
    catalogFile: value.catalogFile,
    leasesFile: value.leasesFile,
    now,
    externalClaims: [{ taskId: value.task.id, expiresAtMs: now + 60_000 }],
  });
  assert.equal(frontier.tasks[0].status, 'leased');
  assert.equal(frontier.recommendedTaskId, null);
  await assert.rejects(() => prepareResearchTask({
    mode: 'frontier',
    taskId: value.task.id,
    problemId: 'ns',
    direction: 'blowup',
    safeMinutes: 15,
    catalogFile: value.catalogFile,
    leasesFile: value.leasesFile,
    now,
    externalClaims: [{ taskId: value.task.id, expiresAtMs: now + 60_000 }],
  }), /already leased/);
});

test('merged successor proposals become shared frontier tasks', async (t) => {
  const value = await fixture();
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const frontier = await listResearchFrontier({
    problemId: 'ns',
    direction: 'blowup',
    safeMinutes: 30,
    catalogFile: value.catalogFile,
    leasesFile: value.leasesFile,
    attempts: [{
      id: 'navier-stokes-test-attempt-0001',
      problemId: 'ns',
      direction: 'blowup',
      status: 'completed',
      reviewStatus: 'unreviewed',
      researchTask: { taskId: value.task.id, branchId: value.task.branchId },
      proposedTasks: [{
        id: 'community.0123456789abcdef',
        title: 'Certify the diagnostic with intervals',
        objective: 'Replace every floating-point operation in the bounded diagnostic with outward-rounded interval arithmetic and record a reproducible certificate.',
        rationale: 'The prior contribution identified numerical error control as the smallest reusable missing dependency.',
        success_criteria: 'A verifier reproduces every interval enclosure from preserved deterministic inputs.',
        useful_failure_criteria: 'Identify the first interval blow-up or conditioning barrier that prevents a useful enclosure.',
        verification_method: 'Run an independent interval implementation and compare all certified endpoints.',
        suggested_minutes: 30,
        relationship: 'child',
        sourceAttemptIds: ['navier-stokes-test-attempt-0001'],
      }],
    }],
  });
  const community = frontier.tasks.find((task) => task.id === 'community.0123456789abcdef');
  assert.equal(community?.status, 'available');
  assert.equal(community?.branchId, value.task.branchId);
});

test('failed and interrupted runs do not permanently consume a frontier task', async (t) => {
  const value = await fixture();
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  for (const status of ['failed', 'interrupted', 'aborted']) {
    const frontier = await listResearchFrontier({
      problemId: 'ns',
      direction: 'blowup',
      safeMinutes: 15,
      catalogFile: value.catalogFile,
      leasesFile: value.leasesFile,
      attempts: [{
        id: `navier-stokes-${status}-attempt`,
        problemId: 'ns',
        direction: 'blowup',
        status,
        researchTask: { taskId: value.task.id, branchId: value.task.branchId },
      }],
    });
    assert.equal(frontier.tasks.find((task) => task.id === value.task.id)?.status, 'available');
  }
});
