import assert from "node:assert/strict";
import test from "node:test";
import { ControllerRuntime } from "../lib/runtime.js";

test("bounded calls pass cancellation to the SDK and release the queue on timeout", async () => {
  const runtime = new ControllerRuntime("runtime-timeout", 10);
  let signal;
  const ctx = runtime.context({ session: {
    get: async (_, options) => {
      signal = options.signal;
      return new Promise(() => {});
    },
  } });
  await assert.rejects(runtime.locked(() => ctx.session.get({ sessionID: "ses_root" })),
    /session.get timed out/);
  assert.equal(signal.aborted, true);
  assert.equal(await runtime.locked(async () => "queue released"), "queue released");
});

test("reload shares the queue, preempts old work and prevents late controller writes", async () => {
  const old = new ControllerRuntime("runtime-reload", 1000);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let writes = 0;
  const ctx = old.context({
    session: { get: async () => { entered.resolve(); return release.promise; } },
    storage: { set: async () => { writes++; } },
  });
  const running = old.locked(async () => {
    old.bind("run_original");
    try { await ctx.session.get({ sessionID: "ses_root" }); }
    catch { await ctx.storage.set("stale", true); }
  });
  const rejected = assert.rejects(running, /cancelled by the user/);
  await entered.promise;
  const reloaded = await import(`../lib/runtime.js?reload=${Date.now()}`);
  const next = new reloaded.ControllerRuntime("runtime-reload", 1000);
  next.interrupt("run_original");
  assert.equal(await next.locked(async () => "new controller"), "new controller");
  await rejected;
  release.resolve({});
  assert.equal(writes, 0);
});

test("unresolved admissions survive reload but clear only when the SDK call settles", async () => {
  const runtime = new ControllerRuntime("runtime-admission", 10);
  const release = Promise.withResolvers();
  const ctx = runtime.context({ session: { prompt: () => release.promise } });
  await assert.rejects(runtime.locked(() => ctx.session.prompt({ sessionID: "ses_child" })),
    /session.prompt timed out/);
  const next = new ControllerRuntime("runtime-admission");
  assert.deepEqual(next.pending("ses_child"), ["session.prompt"]);
  release.resolve({});
  await release.promise;
  await Promise.resolve();
  assert.deepEqual(next.pending("ses_child"), []);
});

test("aborted queued work cannot run after the previous transaction completes", async () => {
  const runtime = new ControllerRuntime("runtime-queued");
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const first = runtime.locked(async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const abort = new AbortController();
  let ran = false;
  const second = runtime.locked(async () => { ran = true; }, abort.signal);
  const rejected = assert.rejects(second, /tool stopped/);
  abort.abort(new Error("tool stopped"));
  release.resolve();
  await first;
  await rejected;
  assert.equal(ran, false);
});
