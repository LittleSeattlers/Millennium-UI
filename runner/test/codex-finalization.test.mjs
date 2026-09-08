import assert from 'node:assert/strict';
import test from 'node:test';
import { startCodexRun } from '../providers/codex.mjs';

class FakeRpc {
  constructor(options) {
    this.options = options;
    this.requests = [];
  }

  async start() {}

  async close() {}

  async request(method, params) {
    this.requests.push({ method, params });
    if (method === 'account/read') return { account: { type: 'chatgpt', planType: 'plus' } };
    if (method === 'account/rateLimits/read') return { rateLimitsByLimitId: {} };
    if (method === 'thread/start') return { thread: { id: 'thread-1' } };
    if (method === 'turn/start') return { turn: { id: 'turn-1' } };
    if (method === 'turn/steer') return {};
    if (method === 'turn/interrupt') {
      this.options.onNotification({
        method: 'turn/completed',
        params: { turn: { id: 'turn-1', status: 'interrupted' } },
      });
      return {};
    }
    throw new Error(`Unexpected RPC method: ${method}`);
  }
}

test('Codex finalization steer is same-turn, exact, and idempotent', async () => {
  let rpc;
  const handle = await startCodexRun({
    attempt: { codePath: 'C:\\attempt' },
    prompt: 'Research this bounded objective.',
    effort: 'high',
    model: 'gpt-5.6-sol',
    networkAccess: false,
    onEvent: async () => {},
    onRaw: async () => {},
    onSnapshot: async () => {},
    resolveExecutable: async () => ({ path: 'codex-test' }),
    createRpc: (options) => {
      rpc = new FakeRpc(options);
      return rpc;
    },
  });

  const first = handle.requestFinalization('Finalize durable files now.');
  const second = handle.requestFinalization('This duplicate must not be sent.');
  assert.strictEqual(second, first);
  await Promise.all([first, second]);

  const steers = rpc.requests.filter(({ method }) => method === 'turn/steer');
  assert.deepEqual(steers, [{
    method: 'turn/steer',
    params: {
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'Finalize durable files now.' }],
      expectedTurnId: 'turn-1',
    },
  }]);

  assert.equal(
    rpc.requests.find(({ method }) => method === 'thread/start')?.params.model,
    'gpt-5.6-sol',
  );
  assert.equal(
    rpc.requests.find(({ method }) => method === 'turn/start')?.params.model,
    'gpt-5.6-sol',
  );

  await handle.stop();
  assert.equal((await handle.completion).status, 'interrupted');
});
