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
  assert.match(frontier.tasks[0].valueContract.publicationRule, /bounded claim with evidence, a falsifier/i);
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
      researchValue: { status: 'accepted', outcome: 'frontier-refinement' },
      researchTask: { taskId: value.task.id, branchId: value.task.branchId },
      proposedTasks: [{
        id: 'community.0123456789abcdef',
        title: 'Certify the diagnostic with intervals',
        objective: 'Replace every floating-point operation in the bounded diagnostic with outward-rounded interval arithmetic and record a reproducible certificate.',
        rationale: 'The prior contribution identified numerical error control as the smallest reusable missing dependency.',
        success_criteria: 'A verifier reproduces every interval enclosure from preserved deterministic inputs.',
        useful_failure_criteria: 'Identify the first interval blow-up or conditioning barrier that prevents a useful enclosure.',
        verification_method: 'Run an independent interval implementation and compare all certified endpoints.',
        suggested_minutes: 5,
        relationship: 'child',
        sourceAttemptIds: ['navier-stokes-test-attempt-0001'],
      }],
    }],
  });
  const community = frontier.tasks.find((task) => task.id === 'community.0123456789abcdef');
  assert.equal(community?.status, 'available');
  assert.equal(community?.suggestedMinutes, 15);
  assert.equal(community?.branchId, value.task.branchId);
});

test('quarantined merged records cannot close tasks, satisfy dependencies, or expose proposals', async (t) => {
  const value = await fixture();
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const frontier = await listResearchFrontier({
    problemId: 'ns',
    direction: 'blowup',
    safeMinutes: 30,
    catalogFile: value.catalogFile,
    leasesFile: value.leasesFile,
    attempts: [{
      id: 'navier-stokes-quarantined-attempt-0001',
      problemId: 'ns',
      direction: 'blowup',
      status: 'completed',
      reviewStatus: 'unreviewed',
      recordSource: 'shared-contribution-quarantined',
      researchTask: { taskId: value.task.id, branchId: value.task.branchId },
      proposedTasks: [{
        id: 'community.quarantined0001',
        title: 'This untrusted proposal must not become executable',
        objective: 'This deliberately quarantined objective must not be passed into a local Codex research task.',
        rationale: 'Schema validity alone does not make public contribution prose safe prompt context.',
        success_criteria: 'The proposal stays absent until its source contribution is explicitly trusted.',
        useful_failure_criteria: 'The proposal appearing in the frontier would violate the content trust boundary.',
        verification_method: 'Inspect the returned task identifiers and confirm that this proposal is absent.',
        suggested_minutes: 15,
        relationship: 'alternative',
      }],
    }],
  });

  assert.equal(frontier.tasks.find((task) => task.id === value.task.id)?.status, 'available');
  assert.equal(frontier.tasks.some((task) => task.id === 'community.quarantined0001'), false);
  assert.equal(frontier.tasks.some((task) => task.kind === 'review'), false);
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

test('a completed run withheld by the value gate does not consume its task', async (t) => {
  const value = await fixture();
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const frontier = await listResearchFrontier({
    problemId: 'ns',
    direction: 'blowup',
    safeMinutes: 15,
    catalogFile: value.catalogFile,
    leasesFile: value.leasesFile,
    attempts: [{
      id: 'navier-stokes-withheld-attempt-0001',
      problemId: 'ns',
      direction: 'blowup',
      status: 'completed',
      researchValue: { status: 'insufficient' },
      publication: { status: 'withheld', usedStructuredProposal: false },
      researchTask: { taskId: value.task.id, branchId: value.task.branchId },
    }],
  });
  assert.equal(frontier.tasks.find((task) => task.id === value.task.id)?.status, 'available');
  assert.equal(frontier.recommendedTaskId, value.task.id);
});

test('verification results do not create an endless chain of review tasks', async (t) => {
  const value = await fixture();
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const frontier = await listResearchFrontier({
    problemId: 'ns',
    direction: 'blowup',
    safeMinutes: 30,
    catalogFile: value.catalogFile,
    leasesFile: value.leasesFile,
    attempts: [{
      id: 'navier-stokes-review-attempt-0001',
      problemId: 'ns',
      direction: 'blowup',
      status: 'completed',
      reviewStatus: 'unreviewed',
      researchValue: { status: 'accepted', outcome: 'reproducibility-result' },
      researchTask: {
        taskId: 'ns.blowup.verify.prior',
        branchId: 'independent-verification',
        kind: 'review',
      },
    }],
  });

  assert.equal(frontier.tasks.some((task) => task.kind === 'review'), false);
});

test('a fitting task is recommended ahead of a higher-priority oversized task', async (t) => {
  const value = await fixture();
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const fittingTask = {
    ...value.task,
    id: 'ns.blowup.fifteen-minute-task',
    title: 'Check one fifteen-minute diagnostic certificate',
    suggestedMinutes: 15,
    priority: 10,
  };
  await fs.writeFile(value.catalogFile, JSON.stringify({
    schemaVersion: 1,
    tasks: [{ ...value.task, id: 'ns.blowup.thirty-minute-task', suggestedMinutes: 30, priority: 100 }, fittingTask],
  }));

  const frontier = await listResearchFrontier({
    problemId: 'ns',
    direction: 'blowup',
    safeMinutes: 15,
    catalogFile: value.catalogFile,
    leasesFile: value.leasesFile,
  });

  assert.equal(frontier.recommendedTaskId, fittingTask.id);
  assert.equal(frontier.counts.available, 1);
});

test('no task is recommended when every available task exceeds the safe allowance', async (t) => {
  const value = await fixture();
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));

  const frontier = await listResearchFrontier({
    problemId: 'ns',
    direction: 'blowup',
    safeMinutes: 5,
    catalogFile: value.catalogFile,
    leasesFile: value.leasesFile,
  });

  assert.equal(frontier.recommendedTaskId, null);
  assert.equal(frontier.counts.available, 0);
  assert.equal(frontier.tasks[0].status, 'available');
});

test('an explicitly selected task cannot start below its suggested duration', async (t) => {
  const value = await fixture();
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));

  await assert.rejects(() => prepareResearchTask({
    mode: 'frontier',
    taskId: value.task.id,
    problemId: 'ns',
    direction: 'blowup',
    safeMinutes: 5,
    catalogFile: value.catalogFile,
    leasesFile: value.leasesFile,
  }), /needs 15 safe minutes, but only 5/i);
});

test('a new exploration requires the useful-run floor and adopts a sufficient safe duration', async (t) => {
  const value = await fixture();
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));

  await assert.rejects(() => prepareResearchTask({
    mode: 'explore',
    newDirection: 'Test a distinct self-similar scaling obstruction with exact interval bounds.',
    problemId: 'ns',
    direction: 'blowup',
    safeMinutes: 14,
    catalogFile: value.catalogFile,
    leasesFile: value.leasesFile,
  }), (error) => error?.code === 'insufficient_safe_time'
    && /Only 14 safe minutes.*requires at least 15/i.test(error.message));

  const task = await prepareResearchTask({
    mode: 'explore',
    newDirection: 'Test a distinct self-similar scaling obstruction with exact interval bounds.',
    problemId: 'ns',
    direction: 'blowup',
    safeMinutes: 17,
    catalogFile: value.catalogFile,
    leasesFile: value.leasesFile,
  });

  assert.equal(task.suggestedMinutes, 17);
});

test('an oversized task receives a distinct stable 15-minute preparatory slice', async (t) => {
  const value = await fixture();
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const parent = { ...value.task, suggestedMinutes: 30 };
  await fs.writeFile(value.catalogFile, JSON.stringify({ schemaVersion: 1, tasks: [parent] }));

  const atSeventeen = await listResearchFrontier({
    problemId: 'ns',
    direction: 'blowup',
    safeMinutes: 17,
    catalogFile: value.catalogFile,
    leasesFile: value.leasesFile,
  });
  const atTwentyNine = await listResearchFrontier({
    problemId: 'ns',
    direction: 'blowup',
    safeMinutes: 29,
    catalogFile: value.catalogFile,
    leasesFile: value.leasesFile,
  });
  const firstSlice = atSeventeen.tasks.find((task) => task.id.startsWith('auto.slice.v1.'));
  const secondSlice = atTwentyNine.tasks.find((task) => task.id.startsWith('auto.slice.v1.'));

  assert.equal(atSeventeen.tasks.length, 2);
  assert.equal(firstSlice?.suggestedMinutes, 15);
  assert.equal(firstSlice?.budgetBasis, 'adaptive-slice');
  assert.equal(firstSlice?.parentTaskId, parent.id);
  assert.equal(firstSlice?.parentContract?.objective, parent.objective);
  assert.equal(firstSlice?.parentContract?.successCriteria, parent.successCriteria);
  assert.deepEqual(firstSlice?.parentContract?.dependencies, parent.dependencies);
  assert.equal(firstSlice?.branchId, parent.branchId);
  assert.equal(firstSlice?.kind, 'formalization');
  assert.match(firstSlice?.objective ?? '', /do not attempt or claim that this run completes or weakens the parent/i);
  assert.equal(atSeventeen.recommendedTaskId, firstSlice?.id);
  assert.equal(atSeventeen.counts.available, 1);
  assert.equal(secondSlice?.id, firstSlice?.id);
  assert.equal(secondSlice?.objective, firstSlice?.objective);
});

test('a changed parent contract creates a new preparatory-slice identity', async (t) => {
  const value = await fixture();
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const parent = { ...value.task, suggestedMinutes: 30 };
  await fs.writeFile(value.catalogFile, JSON.stringify({ schemaVersion: 1, tasks: [parent] }));
  const first = await listResearchFrontier({
    problemId: 'ns',
    direction: 'blowup',
    safeMinutes: 17,
    catalogFile: value.catalogFile,
    leasesFile: value.leasesFile,
  });
  await fs.writeFile(value.catalogFile, JSON.stringify({
    schemaVersion: 1,
    tasks: [{ ...parent, objective: `${parent.objective} Preserve one additional boundary case.` }],
  }));
  const changed = await listResearchFrontier({
    problemId: 'ns',
    direction: 'blowup',
    safeMinutes: 17,
    catalogFile: value.catalogFile,
    leasesFile: value.leasesFile,
  });

  assert.notEqual(
    first.tasks.find((task) => task.id.startsWith('auto.slice.v1.'))?.id,
    changed.tasks.find((task) => task.id.startsWith('auto.slice.v1.'))?.id,
  );
});

test('preparatory slices have a 15-minute value floor and are unnecessary when a real task fits', async (t) => {
  const value = await fixture();
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const parent = { ...value.task, suggestedMinutes: 30 };
  await fs.writeFile(value.catalogFile, JSON.stringify({ schemaVersion: 1, tasks: [parent] }));
  const belowFloor = await listResearchFrontier({
    problemId: 'ns',
    direction: 'blowup',
    safeMinutes: 14,
    catalogFile: value.catalogFile,
    leasesFile: value.leasesFile,
  });
  assert.equal(belowFloor.tasks.some((task) => task.id.startsWith('auto.slice.v1.')), false);

  await fs.writeFile(value.catalogFile, JSON.stringify({
    schemaVersion: 1,
    tasks: [value.task, { ...parent, id: 'ns.blowup.oversized-task' }],
  }));
  const fitting = await listResearchFrontier({
    problemId: 'ns',
    direction: 'blowup',
    safeMinutes: 17,
    catalogFile: value.catalogFile,
    leasesFile: value.leasesFile,
  });
  assert.equal(fitting.tasks.some((task) => task.id.startsWith('auto.slice.v1.')), false);
});

test('dependency-blocked tasks cannot be selected or subdivided', async (t) => {
  const value = await fixture();
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const prerequisite = { ...value.task, id: 'ns.blowup.prerequisite', suggestedMinutes: 30 };
  const dependent = {
    ...value.task,
    id: 'ns.blowup.dependent-task',
    title: 'Use the prerequisite in a dependent calculation',
    suggestedMinutes: 30,
    dependencies: [prerequisite.id],
  };
  await fs.writeFile(value.catalogFile, JSON.stringify({
    schemaVersion: 1,
    tasks: [prerequisite, dependent],
  }));

  const frontier = await listResearchFrontier({
    problemId: 'ns',
    direction: 'blowup',
    safeMinutes: 17,
    catalogFile: value.catalogFile,
    leasesFile: value.leasesFile,
  });
  const blocked = frontier.tasks.find((task) => task.id === dependent.id);
  assert.equal(blocked?.status, 'blocked');
  assert.deepEqual(blocked?.blockedDependencies, [prerequisite.id]);
  assert.equal(frontier.tasks.filter((task) => task.id.startsWith('auto.slice.v1.')).length, 1);

  await assert.rejects(() => prepareResearchTask({
    mode: 'frontier',
    taskId: dependent.id,
    problemId: 'ns',
    direction: 'blowup',
    safeMinutes: 30,
    catalogFile: value.catalogFile,
    leasesFile: value.leasesFile,
  }), /waiting on 1 unfinished prerequisite/i);
});

test('a completed preparatory slice does not consume its oversized parent', async (t) => {
  const value = await fixture();
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const parent = { ...value.task, suggestedMinutes: 30 };
  await fs.writeFile(value.catalogFile, JSON.stringify({ schemaVersion: 1, tasks: [parent] }));
  const initial = await listResearchFrontier({
    problemId: 'ns',
    direction: 'blowup',
    safeMinutes: 17,
    catalogFile: value.catalogFile,
    leasesFile: value.leasesFile,
  });
  const slice = initial.tasks.find((task) => task.id.startsWith('auto.slice.v1.'));
  const completed = await listResearchFrontier({
    problemId: 'ns',
    direction: 'blowup',
    safeMinutes: 17,
    catalogFile: value.catalogFile,
    leasesFile: value.leasesFile,
    attempts: [{
      id: 'navier-stokes-slice-attempt-0001',
      problemId: 'ns',
      direction: 'blowup',
      status: 'completed',
      researchValue: { status: 'accepted', outcome: 'frontier-refinement' },
      researchTask: { taskId: slice.id, branchId: slice.branchId },
    }],
  });

  assert.equal(completed.tasks.find((task) => task.id === slice.id)?.status, 'attempted');
  assert.equal(completed.tasks.find((task) => task.id === parent.id)?.status, 'available');
  assert.equal(completed.recommendedTaskId, null);
});

test('the exact listed preparatory slice is resolved again at start', async (t) => {
  const value = await fixture();
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const parent = { ...value.task, suggestedMinutes: 30 };
  await fs.writeFile(value.catalogFile, JSON.stringify({ schemaVersion: 1, tasks: [parent] }));
  const frontier = await listResearchFrontier({
    problemId: 'ns',
    direction: 'blowup',
    safeMinutes: 17,
    catalogFile: value.catalogFile,
    leasesFile: value.leasesFile,
  });
  const listed = frontier.tasks.find((task) => task.id.startsWith('auto.slice.v1.'));
  const prepared = await prepareResearchTask({
    mode: 'frontier',
    taskId: listed.id,
    problemId: 'ns',
    direction: 'blowup',
    safeMinutes: 17,
    catalogFile: value.catalogFile,
    leasesFile: value.leasesFile,
  });

  assert.equal(prepared.id, listed.id);
  assert.equal(prepared.objective, listed.objective);
  assert.equal(prepared.parentTaskId, parent.id);
});

test('catalog tasks cannot use the reserved preparatory-slice prefix', async (t) => {
  const value = await fixture();
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  await fs.writeFile(value.catalogFile, JSON.stringify({
    schemaVersion: 1,
    tasks: [{ ...value.task, id: 'auto.slice.v1.reserved' }],
  }));

  await assert.rejects(() => listResearchFrontier({
    problemId: 'ns',
    direction: 'blowup',
    safeMinutes: 15,
    catalogFile: value.catalogFile,
    leasesFile: value.leasesFile,
  }), /reserved adaptive-slice prefix/i);
});
