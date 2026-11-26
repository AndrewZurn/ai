import { AsyncLocalStorage } from "node:async_hooks";

// Keep the queue and unresolved admissions across plugin module reloads in this
// server process. Independent servers still need separate checkouts.
const state = globalThis[Symbol.for("opencode.swarm.runtime")] ??= {
  queues: new Map(), admissions: new Set(), scope: new AsyncLocalStorage(),
};

export class ControllerRuntime {
  constructor(key, timeout = 60_000) {
    if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("Invalid operation timeout.");
    this.key = key;
    this.timeout = timeout;
    this.lifetime = new AbortController();
  }

  signal() {
    const scope = state.scope.getStore();
    return scope?.key === this.key
      ? AbortSignal.any([this.lifetime.signal, scope.signal]) : this.lifetime.signal;
  }

  guard() {
    this.signal().throwIfAborted();
  }

  close() {
    this.lifetime.abort(new Error("Swarm plugin unloaded; retry after reload."));
  }

  bind(runID) {
    const scope = state.scope.getStore();
    if (scope?.key === this.key) scope.active.runID = runID;
  }

  interrupt(runID) {
    const active = state.queues.get(this.key)?.active;
    if (!runID || active?.runID !== runID) return false;
    active.controller.abort(new Error("Swarm operation cancelled by the user."));
    return true;
  }

  async locked(action, signal) {
    const queue = state.queues.get(this.key) ?? { tail: Promise.resolve() };
    const next = queue.tail.catch(() => {}).then(async () => {
      const active = new AbortController();
      const combined = AbortSignal.any([
        this.lifetime.signal, active.signal, ...(signal ? [signal] : []),
      ]);
      combined.throwIfAborted();
      const owner = { controller: active, runID: null };
      queue.active = owner;
      try {
        return await state.scope.run({ key: this.key, signal: combined, active: owner }, action);
      } finally {
        if (queue.active === owner) queue.active = null;
      }
    });
    queue.tail = next;
    state.queues.set(this.key, queue);
    try {
      return await next;
    } finally {
      if (queue.tail === next) state.queues.delete(this.key);
    }
  }

  async wait(label, action, admission, callerSignal) {
    this.guard();
    const deadline = new AbortController();
    const signal = AbortSignal.any([
      this.signal(), deadline.signal, ...(callerSignal ? [callerSignal] : []),
    ]);
    const timer = setTimeout(() => deadline.abort(
      new Error(`Swarm ${label} timed out after ${this.timeout}ms.`),
    ), this.timeout);
    let onAbort;
    try {
      const interrupted = new Promise((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
      // A timed-out SDK request may still complete if it ignores cancellation.
      // Do not reuse that participant until its admission actually settles.
      const pending = admission ? { key: this.key, sessionID: admission, label } : null;
      if (pending) state.admissions.add(pending);
      const work = Promise.resolve().then(() => {
        signal.throwIfAborted();
        return action(signal);
      }).finally(() => {
        if (pending) state.admissions.delete(pending);
      });
      return await Promise.race([work, interrupted]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }

  pending(sessionID) {
    return [...state.admissions].filter(entry =>
      entry.key === this.key && entry.sessionID === sessionID).map(entry => entry.label);
  }

  context(ctx) {
    const bounded = {
      session: new Set(["get", "context", "create", "prompt", "interrupt"]),
      agent: new Set(["get"]),
      permission: new Set(["assert"]),
      storage: new Set(["get"]),
    };
    return new Proxy(ctx, {
      get: (target, domain) => {
        if (!bounded[domain]) return target[domain];
        return new Proxy(target[domain], {
          get: (resource, method) => {
            if (domain === "storage" && method === "set") {
              return (...args) => {
                this.guard();
                // Do not abandon writes: a late commit could overwrite new state.
                return resource.set(...args);
              };
            }
            if (!bounded[domain].has(method)) return resource[method];
            return (input, options = {}) => this.wait(`${domain}.${method}`,
              signal => resource[method](input,
                domain === "storage" ? undefined : {
                  ...options, signal: options.signal
                    ? AbortSignal.any([signal, options.signal]) : signal,
                }),
              domain === "session" && ["create", "prompt"].includes(method)
                ? input.sessionID ?? input.id : undefined);
          },
        });
      },
    });
  }
}
