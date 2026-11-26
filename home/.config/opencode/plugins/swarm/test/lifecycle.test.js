import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SwarmController } from "../lib/controller.js";
import { setup } from "../lib/plugin.js";

async function fixture(t) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "swarm-lifecycle-")));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd: directory });
  const storage = new Map();
  const recovered = Promise.withResolvers();
  let ready = false;
  let admissions = 0;
  const ctx = {
    location: { directory }, options: {},
    storage: {
      get: async key => structuredClone(storage.get(key)),
      set: async (key, value) => { storage.set(key, structuredClone(value)); },
    },
    tool: { hook: async () => {}, transform: async () => {} },
    agent: { transform: async () => {} },
    command: { transform: async () => {} },
    permission: { hook: async () => {} },
    session: {
      hook: async () => {},
      get: async () => ({ agent: "orchestrator", location: { directory }, time: {} }),
      prompt: async () => {
        assert(ready, "prompt admission must not run before plugin setup returns");
        admissions++;
      },
    },
    event: { subscribe: ({ signal }) => (async function* () {
      if (!signal.aborted) await new Promise(resolve =>
        signal.addEventListener("abort", resolve, { once: true }));
    })() },
  };
  const key = new SwarmController(ctx, directory).key;
  storage.set(key, {
    id: "run_saved", root: "ses_root", location: directory, phase: "BLOCKED",
    sessions: {}, history: [], candidate: null, jobs: [{
      id: "msg_saved", sessionID: "ses_root", role: "orchestrator",
      kind: "notification", text: "Saved status", sent: false, done: false,
    }],
  });
  return {
    ctx, storage, key, recovered,
    get admissions() { return admissions; },
    start: async dependencies => {
      const cleanup = await setup(ctx, { onRecovery: recovered.resolve, ...dependencies });
      ready = true;
      t.after(cleanup);
      return cleanup;
    },
  };
}

test("startup can replay an outbox only after plugin activation has returned", async t => {
  const f = await fixture(t);
  f.ctx.event.subscribe = ({ signal }) => (async function* () {
    yield { location: f.ctx.location, type: "filesystem.changed" };
    if (!signal.aborted) await new Promise(resolve =>
      signal.addEventListener("abort", resolve, { once: true }));
  })();
  await f.start();
  assert.equal(f.admissions, 0);
  await f.recovered.promise;
  assert.equal(f.admissions, 1);
  assert.equal(f.storage.get(f.key).jobs[0].sent, true);
});

test("hung storage reads do not delay agent, tool or command registration", async t => {
  const f = await fixture(t);
  const registered = new Set();
  for (const domain of ["agent", "tool", "command"]) {
    f.ctx[domain].transform = async () => { registered.add(domain); };
  }
  const entered = Promise.withResolvers();
  f.ctx.storage.get = () => { entered.resolve(); return new Promise(() => {}); };
  const cleanup = await f.start();
  assert.deepEqual([...registered].sort(), ["agent", "command", "tool"]);
  await entered.promise;
  await cleanup();
  await f.recovered.promise;
  assert.equal(f.admissions, 0);
});

test("event storms coalesce into one running recovery and at most one follow-up", async t => {
  const f = await fixture(t);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const burst = Promise.withResolvers();
  const consumed = Promise.withResolvers();
  const get = f.ctx.session.get;
  let reads = 0;
  f.ctx.session.get = async input => {
    if (++reads === 1) {
      entered.resolve();
      await release.promise;
    }
    return get(input);
  };
  f.ctx.event.subscribe = ({ signal }) => (async function* () {
    await burst.promise;
    for (let i = 0; i < 500; i++) yield { location: f.ctx.location, type: "filesystem.changed" };
    consumed.resolve();
    if (!signal.aborted) await new Promise(resolve =>
      signal.addEventListener("abort", resolve, { once: true }));
  })();
  await f.start();
  await entered.promise;
  burst.resolve();
  await consumed.promise;
  release.resolve();
  await f.recovered.promise;
  assert.equal(reads, 3, "initial reconcile + notification check + one follow-up reconcile");
  assert.equal(f.admissions, 1, "the durable prompt is admitted once");
});

test("unload does not wait for an uncooperative event source or SDK request", async t => {
  const f = await fixture(t);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const get = f.ctx.session.get;
  f.ctx.session.get = async input => {
    entered.resolve();
    await release.promise;
    return get(input);
  };
  f.ctx.event.subscribe = () => (async function* () { await new Promise(() => {}); })();
  const cleanup = await f.start();
  await entered.promise;
  await cleanup();
  await f.recovered.promise;
  release.resolve();
  await release.promise;
  assert.equal(f.admissions, 0);
  assert.equal(f.storage.get(f.key).jobs[0].sent, false);
});

test("a failed event subscription reconnects on the next periodic recovery", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const errors = t.mock.method(console, "error", () => {});
  const f = await fixture(t);
  let subscriptions = 0;
  f.ctx.event.subscribe = ({ signal }) => (async function* () {
    if (++subscriptions === 1) throw new Error("event transport lost");
    if (!signal.aborted) await new Promise(resolve =>
      signal.addEventListener("abort", resolve, { once: true }));
  })();
  let completed = f.recovered;
  await f.start({ onRecovery: () => completed.resolve() });
  await completed.promise;
  assert.equal(errors.mock.calls.filter(call =>
    call.arguments[0].startsWith("swarm event stream failed")).length, 1);
  assert.equal(subscriptions, 1);
  completed = Promise.withResolvers();
  t.mock.timers.tick(30_000);
  await completed.promise;
  assert.equal(subscriptions, 2);
  assert.equal(f.admissions, 1);
});
