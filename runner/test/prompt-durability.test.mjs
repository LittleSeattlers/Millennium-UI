import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFinalizationPrompt, buildResearchBrief, buildResearchPrompt } from '../prompt.mjs';

function promptConfig() {
  return {
    attemptId: 'navier-stokes-2026-08-31-00000000-0000-4000-8000-000000000123',
    problem: 'ns',
    route: 'blowup',
    objective: 'Test one bounded diagnostic for a precisely stated possible singularity mechanism.',
    requestedMinutes: 15,
    checkpointMinutes: 5,
    networkAccess: false,
  };
}

test('research prompt requires an immediately valid rolling result and contribution', () => {
  const prompt = buildResearchPrompt(promptConfig());
  assert.match(prompt, /first work cycle[\s\S]*RESULT\.md and CONTRIBUTION\.proposed\.json/);
  assert.match(prompt, /must always remain valid JSON/);
  assert.match(prompt, /After every material finding, failed approach, corrected assumption, or citation, refresh RESULT\.md and CONTRIBUTION\.proposed\.json/);
  assert.match(prompt, /at least every 5 minutes/);
  assert.match(prompt, /never use placeholders that assert evidence you do not have/);
  assert.match(prompt, /what is already known[\s\S]*smallest falsifiable microclaim/);
  assert.match(prompt, /value_assessment[\s\S]*novelty[\s\S]*evidence[\s\S]*falsifier/);
  assert.match(prompt, /withhold the record from the ledger, and return the task to the frontier/);
  assert.match(prompt, /final research cycle adversarially checking the strongest result/);
});

test('a preparatory slice receives the full parent contract and its claim boundary', () => {
  const config = {
    ...promptConfig(),
    researchTask: {
      id: 'auto.slice.v1.0123456789abcdef0123456789abcdef',
      branchId: 'structured-ansatz',
      mode: 'recommended',
      kind: 'formalization',
      title: 'Scope a runnable slice of a structured ansatz',
      objective: 'Map the parent dependencies, perform one check, and propose falsifiable child tasks.',
      rationale: 'The parent editorial budget does not fit this safe allowance.',
      successCriteria: 'Produce one reproducible check and explicit child tasks.',
      usefulFailureCriteria: 'Record the exact reason a sound decomposition cannot be made.',
      verificationMethod: 'Compare every child against the complete parent contract.',
      suggestedMinutes: 15,
      budgetBasis: 'adaptive-slice',
      parentTaskId: 'ns.blowup.fourier-closure',
      parentContract: {
        id: 'ns.blowup.fourier-closure',
        title: 'Test closure of a structured blow-up ansatz',
        kind: 'counterexample-search',
        objective: 'Specify a divergence-free ansatz and determine exactly whether nonlinear evolution preserves it.',
        successCriteria: 'Give an exact closure calculation with admissibility conditions.',
        usefulFailureCriteria: 'Identify the first generated mode or constraint that destroys closure.',
        verificationMethod: 'Independently reproduce symbolic convolution and divergence checks.',
        dependencies: ['ns.blowup.prerequisite'],
      },
      dependencies: ['ns.blowup.prerequisite'],
      sourceAttemptIds: [],
    },
  };

  const prompt = buildResearchPrompt(config);
  const brief = buildResearchBrief(config);
  for (const output of [prompt, brief]) {
    assert.match(output, /ns\.blowup\.fourier-closure/);
    assert.match(output, /Specify a divergence-free ansatz/);
    assert.match(output, /exact closure calculation/);
    assert.match(output, /first generated mode/);
    assert.match(output, /symbolic convolution/);
  }
  assert.match(brief, /does not complete or weaken the parent task/i);
});

test('finalization prompt stops exploration and requires truthful durable files', () => {
  const prompt = buildFinalizationPrompt({ reason: 'Budget nearly exhausted.', secondsRemaining: 75 });
  assert.match(prompt, /Budget nearly exhausted\./);
  assert.match(prompt, /at most 75 seconds/);
  assert.match(prompt, /Stop all new research/);
  assert.match(prompt, /Update RESULT\.md/);
  assert.match(prompt, /Replace CONTRIBUTION\.proposed\.json/);
  assert.match(prompt, /bounded evidence-bearing claim plus a concrete next action or successor task/);
  assert.match(prompt, /Do not invent claims, evidence, verification, citations, novelty, or completion/);
});
