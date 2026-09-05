import assert from 'node:assert/strict';
import test from 'node:test';
import { selectClaimWinner } from '../github.mjs';

test('a newly created claim is never interpreted as losing from an empty snapshot', () => {
  const own = { taskId: 'ns.regular.apriori-closure', number: 12 };
  assert.equal(selectClaimWinner(own.taskId, own, [])?.number, 12);
});

test('the lowest PR number wins a converging task-claim race', () => {
  const taskId = 'ns.regular.apriori-closure';
  const own = { taskId, number: 14 };
  const discovered = [
    { taskId: 'ns.blowup.ansatz-closure', number: 8 },
    { taskId, number: 13 },
    { taskId, number: 14 },
  ];
  assert.equal(selectClaimWinner(taskId, own, discovered)?.number, 13);
});
