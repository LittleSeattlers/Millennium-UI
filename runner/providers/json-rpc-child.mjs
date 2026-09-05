import readline from 'node:readline';
import { MAX_PROVIDER_LINE_BYTES } from '../constants.mjs';
import { spawnNative, stopProcessTree } from './process.mjs';

export class JsonRpcChild {
  constructor({ executable, args, cwd, env, onNotification, onServerRequest, onRaw, onStderr, onExit }) {
    this.executable = executable;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.onNotification = onNotification;
    this.onServerRequest = onServerRequest;
    this.onRaw = onRaw;
    this.onStderr = onStderr;
    this.onExit = onExit;
    this.pending = new Map();
    this.nextId = 100;
    this.child = null;
    this.closed = false;
  }

  async start() {
    if (this.child) return;
    this.child = spawnNative(this.executable, this.args, {
      cwd: this.cwd,
      env: this.env,
    });
    this.child.once('error', (error) => {
      this.#failAll(error);
      this.onExit?.({ error, code: null, signal: null });
    });
    this.child.once('close', (code, signal) => {
      this.closed = true;
      this.#failAll(new Error(`Provider process exited (${code ?? signal ?? 'unknown'}).`));
      this.onExit?.({ error: null, code, signal });
    });
    this.child.stderr.on('data', (chunk) => this.onStderr?.(chunk.toString('utf8')));

    const lines = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => void this.#handleLine(line));

    await this.request('initialize', {
      clientInfo: { name: 'millennium', title: 'Millennium', version: '0.2.0' },
    }, 12_000);
    this.notify('initialized', {});
  }

  request(method, params = {}, timeoutMs = 10_000) {
    if (!this.child || this.closed) return Promise.reject(new Error('Provider process is not running.'));
    const id = this.nextId;
    this.nextId += 1;
    this.#send({ method, id, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out.`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  notify(method, params = {}) {
    this.#send({ method, params });
  }

  respond(id, result) {
    this.#send({ id, result });
  }

  respondError(id, code, message) {
    this.#send({ id, error: { code, message } });
  }

  async close(graceMs = 1_000) {
    if (!this.child || this.closed) return;
    try { this.child.stdin.end(); } catch { /* process already closing */ }
    await stopProcessTree(this.child, graceMs);
  }

  #send(message) {
    if (!this.child || this.closed || !this.child.stdin.writable) throw new Error('Provider stdin is closed.');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async #handleLine(line) {
    if (Buffer.byteLength(line, 'utf8') > MAX_PROVIDER_LINE_BYTES) {
      this.onNotification?.({ method: 'protocol/error', params: { message: 'Provider emitted an oversized JSONL record.' } });
      await this.close(250);
      return;
    }
    try {
      await this.onRaw?.(line);
    } catch (error) {
      this.onNotification?.({ method: 'protocol/error', params: { message: `Raw event persistence failed: ${error instanceof Error ? error.message : 'unknown error'}` } });
      await this.close(250);
      return;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.onNotification?.({ method: 'protocol/error', params: { message: 'Provider emitted malformed JSONL.' } });
      return;
    }

    if (Object.hasOwn(message, 'id') && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message ?? 'Provider request failed.'));
      else pending.resolve(message.result);
      return;
    }

    if (Object.hasOwn(message, 'id') && message.method) {
      try {
        const result = await this.onServerRequest?.(message);
        this.respond(message.id, result ?? {});
      } catch (error) {
        this.respondError(message.id, -32000, error instanceof Error ? error.message : 'Request declined.');
      }
      return;
    }

    this.onNotification?.(message);
  }

  #failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
