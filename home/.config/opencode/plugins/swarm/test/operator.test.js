import assert from "node:assert/strict";
import test from "node:test";
import { ControllerRuntime } from "../lib/runtime.js";
import { operatorDefinition, registerOperator } from "../lib/operator.js";

function fixture() {
  const runtime = new ControllerRuntime(`operator-test-${Math.random()}`);
  const saved = {
    id: "run_test", root: "ses_root", directory: "/repo", phase: "BUILDING",
    round: 1, maxRounds: 5, requirements: "PRIVATE TASK CONTENT",
    jobs: [{ sessionID: "ses_child", role: "builder" }],
  };
  let handlers;
  const calls = [];
  const gate = {
    key: "active", runtime,
    ctx: { storage: { get: async () => structuredClone(saved) } },
    control: async (...args) => { calls.push(args); saved.phase = "CANCELLED"; },
  };
  registerOperator({ rpc: { register: (definition, methods) => {
    assert.equal(definition, operatorDefinition);
    handlers = methods;
  } } }, gate, operatorDefinition);
  const context = {
    error: (type, message) => { throw Object.assign(new Error(message), { type }); },
  };
  return { gate, saved, handlers, context, calls };
}

test("operator inspection bypasses a wedged workflow queue and does not expose prompt contents", async () => {
  const f = fixture();
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const locked = f.gate.runtime.locked(async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const snapshot = await f.handlers.inspect({}, f.context);
  assert.equal(snapshot.runID, "run_test");
  assert.deepEqual(snapshot.sessions.map(s => s.sessionID), ["ses_root", "ses_child"]);
  assert(!JSON.stringify(snapshot).includes("PRIVATE"));
  assert.equal(f.calls.length, 0);
  release.resolve();
  await locked;
});

test("operator controls reject stale IDs and forward the exact run and caller signal", async () => {
  const f = fixture();
  await assert.rejects(f.handlers.control({ runID: "stale", action: "cancel" }, f.context), /run changed/);
  await assert.rejects(f.handlers.control({ runID: "run_test", action: "delete" }, f.context), /Invalid operator/);
  assert.equal(f.calls.length, 0);
  const abort = new AbortController();
  const snapshot = await f.handlers.control({ runID: "run_test", action: "cancel" },
    { ...f.context, signal: abort.signal });
  assert.equal(snapshot.phase, "CANCELLED");
  assert.equal(f.calls[0][0], "ses_root");
  assert.equal(f.calls[0][1], "cancel");
  assert.equal(f.calls[0][2].runID, "run_test");
  assert.equal(f.calls[0][2].signal, abort.signal);
  assert.equal(typeof f.calls[0][2].operatorID, "string");
});

test("an operator inspection can be aborted while storage is unavailable", async () => {
  const f = fixture();
  f.gate.ctx.storage.get = () => new Promise(() => {});
  const abort = new AbortController();
  const inspecting = f.handlers.inspect({}, { signal: abort.signal });
  const rejected = assert.rejects(inspecting, /operator disconnected/);
  abort.abort(new Error("operator disconnected"));
  await rejected;
});
