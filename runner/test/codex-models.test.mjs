import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveCodexModel } from '../attempts.mjs';
import { listCodexModels, normalizeCodexModel, readCodexRateLimits } from '../providers/codex.mjs';

function model(overrides = {}) {
  return {
    id: 'gpt-5.6-sol',
    model: 'gpt-5.6-sol',
    displayName: 'GPT-5.6-Sol',
    description: 'Latest frontier agentic coding model.',
    hidden: false,
    isDefault: true,
    defaultReasoningEffort: 'low',
    supportedReasoningEfforts: [
      { reasoningEffort: 'low', description: 'Fast' },
      { reasoningEffort: 'high', description: 'Deep' },
      { reasoningEffort: 'max', description: 'Unsupported by this UI' },
    ],
    ...overrides,
  };
}

test('normalizes only safe visible models and supported UI efforts', () => {
  assert.deepEqual(normalizeCodexModel(model()), {
    id: 'gpt-5.6-sol',
    model: 'gpt-5.6-sol',
    displayName: 'GPT-5.6-Sol',
    description: 'Latest frontier agentic coding model.',
    isDefault: true,
    defaultReasoningEffort: 'low',
    supportedReasoningEfforts: ['low', 'high'],
  });
  assert.equal(normalizeCodexModel(model({ hidden: true })), null);
  assert.equal(normalizeCodexModel(model({ model: '../unsafe' })), null);
});

test('reads the complete account-aware Codex model catalog', async () => {
  const requests = [];
  const rpc = {
    async request(method, params) {
      requests.push({ method, params });
      if (params.cursor === null) {
        return { data: [model()], nextCursor: 'page-2' };
      }
      return {
        data: [model({
          id: 'gpt-5.6-terra',
          model: 'gpt-5.6-terra',
          displayName: 'GPT-5.6-Terra',
          isDefault: false,
          defaultReasoningEffort: 'medium',
          supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Balanced' }],
        })],
        nextCursor: null,
      };
    },
  };

  const models = await listCodexModels(rpc);
  assert.deepEqual(models.map((entry) => entry.model), ['gpt-5.6-sol', 'gpt-5.6-terra']);
  assert.deepEqual(requests, [
    { method: 'model/list', params: { cursor: null, limit: 100, includeHidden: false } },
    { method: 'model/list', params: { cursor: 'page-2', limit: 100, includeHidden: false } },
  ]);
});

test('retries a transient Codex quota-read timeout', async () => {
  const requests = [];
  const waits = [];
  const expected = { rateLimitsByLimitId: { codex: {} } };
  const rpc = {
    async request(method, params, timeoutMs) {
      requests.push({ method, params, timeoutMs });
      if (requests.length === 1) throw new Error('account/rateLimits/read timed out.');
      return expected;
    },
  };

  const result = await readCodexRateLimits(rpc, {
    timeoutMs: 1234,
    retryDelayMs: 25,
    wait: async (milliseconds) => { waits.push(milliseconds); },
  });

  assert.equal(result, expected);
  assert.deepEqual(requests, [
    { method: 'account/rateLimits/read', params: {}, timeoutMs: 1234 },
    { method: 'account/rateLimits/read', params: {}, timeoutMs: 1234 },
  ]);
  assert.deepEqual(waits, [25]);
});

test('does not retry non-timeout Codex quota errors', async () => {
  let requestCount = 0;
  const rpc = {
    async request() {
      requestCount += 1;
      throw new Error('subscription authentication failed');
    },
  };

  await assert.rejects(() => readCodexRateLimits(rpc, {
    wait: async () => assert.fail('non-timeout errors must not be delayed or retried'),
  }), /authentication failed/);
  assert.equal(requestCount, 1);
});

test('resolves only available model and effort combinations', () => {
  const provider = {
    defaultModel: 'gpt-5.6-sol',
    models: [
      normalizeCodexModel(model()),
      normalizeCodexModel(model({
        id: 'gpt-5.6-terra',
        model: 'gpt-5.6-terra',
        displayName: 'GPT-5.6-Terra',
        isDefault: false,
        supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Balanced' }],
        defaultReasoningEffort: 'medium',
      })),
    ],
  };

  assert.equal(resolveCodexModel(provider, 'default', 'high'), 'gpt-5.6-sol');
  assert.equal(resolveCodexModel(provider, 'gpt-5.6-terra', 'medium'), 'gpt-5.6-terra');
  assert.throws(() => resolveCodexModel(provider, 'gpt-missing', 'high'), /no longer available/i);
  assert.throws(() => resolveCodexModel(provider, 'gpt-5.6-terra', 'high'), /not supported/i);
});
