import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/model-recommendation.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled.outputText).toString('base64')}`;
const { recommendCodexConfiguration } = await import(moduleUrl);

function model(name, efforts, { isDefault = false, defaultEffort = efforts[0] } = {}) {
  return {
    id: name,
    model: name,
    displayName: name.replaceAll('-', ' '),
    isDefault,
    defaultReasoningEffort: defaultEffort,
    supportedReasoningEfforts: efforts,
  };
}

const sol = model('gpt-5.6-sol', ['low', 'medium', 'high', 'xhigh'], {
  isDefault: true,
  defaultEffort: 'medium',
});
const terra = model('gpt-5.6-terra', ['low', 'medium', 'high'], { defaultEffort: 'medium' });
const luna = model('gpt-5.6-luna', ['low', 'medium'], { defaultEffort: 'low' });

test('uses the declared default model with high reasoning for proof-critical work', () => {
  const recommendation = recommendCodexConfiguration({
    models: [terra, sol, luna],
    researchMode: 'recommended',
    taskKind: 'proof',
    safeMinutes: 30,
    quotaRemainingPercent: 55,
  });

  assert.equal(recommendation.model.model, 'gpt-5.6-sol');
  assert.equal(recommendation.effort, 'high');
});

test('keeps high reasoning for a viable proof slice even when remaining quota is low', () => {
  const recommendation = recommendCodexConfiguration({
    models: [terra, sol, luna],
    researchMode: 'recommended',
    taskKind: 'proof',
    safeMinutes: 15,
    quotaRemainingPercent: 12,
  });

  assert.equal(recommendation.model.model, 'gpt-5.6-sol');
  assert.equal(recommendation.effort, 'high');
});

test('uses extra-high reasoning only for verification with ample headroom', () => {
  const recommendation = recommendCodexConfiguration({
    models: [sol, terra, luna],
    researchMode: 'verify',
    taskKind: 'review',
    safeMinutes: 60,
    quotaRemainingPercent: 50,
  });

  assert.equal(recommendation.model.model, 'gpt-5.6-sol');
  assert.equal(recommendation.effort, 'xhigh');
});

test('keeps Sol with high reasoning even before a mathematical exploration is runnable', () => {
  const recommendation = recommendCodexConfiguration({
    models: [sol, terra, luna],
    researchMode: 'explore',
    taskKind: 'exploration',
    safeMinutes: 10,
    quotaRemainingPercent: 12,
  });

  assert.equal(recommendation.model.model, 'gpt-5.6-sol');
  assert.equal(recommendation.effort, 'high');
});

test('clamps requested reasoning to the nearest effort supported by the chosen model', () => {
  const mediumOnlyTerra = model('gpt-5.6-terra', ['medium'], { defaultEffort: 'medium' });
  const recommendation = recommendCodexConfiguration({
    models: [mediumOnlyTerra],
    researchMode: 'frontier',
    taskKind: 'computation',
    safeMinutes: 30,
    quotaRemainingPercent: 70,
  });

  assert.equal(recommendation.model.model, 'gpt-5.6-terra');
  assert.equal(recommendation.effort, 'medium');
});

test('prefers the classified mathematics flagship over an unknown account default', () => {
  const future = model('gpt-6-research', ['medium', 'high'], {
    isDefault: true,
    defaultEffort: 'high',
  });
  const legacySol = { ...sol, isDefault: false };
  const recommendation = recommendCodexConfiguration({
    models: [legacySol, future],
    researchMode: 'recommended',
    taskKind: 'counterexample-search',
    safeMinutes: 30,
    quotaRemainingPercent: 60,
  });

  assert.equal(recommendation.model.model, 'gpt-5.6-sol');
  assert.equal(recommendation.effort, 'high');
});

test('does not invent an automatic selection when no account models were discovered', () => {
  assert.equal(recommendCodexConfiguration({
    models: [],
    researchMode: 'recommended',
    taskKind: null,
    safeMinutes: 30,
    quotaRemainingPercent: null,
  }), null);
});

test('enables extra-high verification only at the ample-time boundary', () => {
  const beforeBoundary = recommendCodexConfiguration({
    models: [sol],
    researchMode: 'verify',
    taskKind: 'review',
    safeMinutes: 44,
    quotaRemainingPercent: 50,
  });
  const atBoundary = recommendCodexConfiguration({
    models: [sol],
    researchMode: 'verify',
    taskKind: 'review',
    safeMinutes: 45,
    quotaRemainingPercent: 50,
  });

  assert.equal(beforeBoundary.effort, 'high');
  assert.equal(atBoundary.effort, 'xhigh');
});

test('keeps high reasoning for an eligible exploration when the model supports it', () => {
  const gapped = model('gpt-5.6-terra', ['low', 'high'], { defaultEffort: 'low' });
  const recommendation = recommendCodexConfiguration({
    models: [gapped],
    researchMode: 'explore',
    taskKind: 'exploration',
    safeMinutes: 17,
    quotaRemainingPercent: 50,
  });

  assert.equal(recommendation.effort, 'high');
});

test('falls back to an unknown declared default for exploration without inventing a family', () => {
  const future = model('gpt-6-research', ['medium', 'high'], {
    isDefault: true,
    defaultEffort: 'high',
  });
  const recommendation = recommendCodexConfiguration({
    models: [future],
    researchMode: 'explore',
    taskKind: 'exploration',
    safeMinutes: 30,
    quotaRemainingPercent: 50,
  });

  assert.equal(recommendation.model.model, 'gpt-6-research');
  assert.equal(recommendation.effort, 'high');
});

test('does not let a connector-default Terra displace Sol for proof work', () => {
  const unflaggedTerra = { ...terra, isDefault: false };
  const unflaggedSol = { ...sol, isDefault: false };
  const recommendation = recommendCodexConfiguration({
    models: [unflaggedTerra, unflaggedSol],
    defaultModel: 'gpt-5.6-terra',
    researchMode: 'recommended',
    taskKind: 'proof',
    safeMinutes: 30,
    quotaRemainingPercent: 50,
  });

  assert.equal(recommendation.model.model, 'gpt-5.6-sol');
  assert.equal(recommendation.effort, 'high');
});

test('uses Sol for formalization even when Terra is the connector default', () => {
  const recommendation = recommendCodexConfiguration({
    models: [{ ...terra, isDefault: true }, { ...sol, isDefault: false }],
    defaultModel: 'gpt-5.6-terra',
    researchMode: 'frontier',
    taskKind: 'formalization',
    safeMinutes: 30,
    quotaRemainingPercent: 50,
  });

  assert.equal(recommendation.model.model, 'gpt-5.6-sol');
  assert.equal(recommendation.effort, 'high');
});

test('uses extra-high Sol for an ample verification despite a Terra account default', () => {
  const recommendation = recommendCodexConfiguration({
    models: [{ ...terra, isDefault: true }, { ...sol, isDefault: false }],
    defaultModel: 'gpt-5.6-terra',
    researchMode: 'verify',
    taskKind: 'review',
    safeMinutes: 60,
    quotaRemainingPercent: 50,
  });

  assert.equal(recommendation.model.model, 'gpt-5.6-sol');
  assert.equal(recommendation.effort, 'xhigh');
});

test('uses Sol for mathematical computation and its certificate interpretation', () => {
  const recommendation = recommendCodexConfiguration({
    models: [terra, sol, luna],
    researchMode: 'frontier',
    taskKind: 'computation',
    safeMinutes: 30,
    quotaRemainingPercent: 70,
  });

  assert.equal(recommendation.model.model, 'gpt-5.6-sol');
  assert.equal(recommendation.effort, 'high');
});

test('uses Sol at high effort for an eligible short synthesis slice', () => {
  const recommendation = recommendCodexConfiguration({
    models: [terra, sol, luna],
    researchMode: 'frontier',
    taskKind: 'synthesis',
    safeMinutes: 17,
    quotaRemainingPercent: 50,
  });

  assert.equal(recommendation.model.model, 'gpt-5.6-sol');
  assert.equal(recommendation.effort, 'high');
});

test('always returns a catalog model with an effort that model supports', () => {
  const modes = ['recommended', 'frontier', 'explore', 'verify'];
  const kinds = [
    null,
    'proof',
    'counterexample-search',
    'computation',
    'formalization',
    'review',
    'synthesis',
    'exploration',
  ];
  const models = [sol, terra, luna];

  for (const researchMode of modes) {
    for (const taskKind of kinds) {
      const recommendation = recommendCodexConfiguration({
        models,
        defaultModel: 'gpt-5.6-sol',
        researchMode,
        taskKind,
        safeMinutes: 17,
        quotaRemainingPercent: 24,
      });
      assert.ok(models.includes(recommendation.model));
      assert.ok(recommendation.model.supportedReasoningEfforts.includes(recommendation.effort));
    }
  }
});
