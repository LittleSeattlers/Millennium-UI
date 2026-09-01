import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFinalizationPrompt, buildResearchPrompt } from '../prompt.mjs';

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
});

test('finalization prompt stops exploration and requires truthful durable files', () => {
  const prompt = buildFinalizationPrompt({ reason: 'Budget nearly exhausted.', secondsRemaining: 75 });
  assert.match(prompt, /Budget nearly exhausted\./);
  assert.match(prompt, /at most 75 seconds/);
  assert.match(prompt, /Stop all new research/);
  assert.match(prompt, /Update RESULT\.md/);
  assert.match(prompt, /Replace CONTRIBUTION\.proposed\.json/);
  assert.match(prompt, /Do not invent claims, evidence, verification, citations, or completion/);
});
