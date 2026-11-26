import assert from "node:assert/strict";
import test from "node:test";
import { argumentsFor, run } from "./opencode-swarms.mjs";

function fixture() {
  const calls = [];
  const lines = [];
  const sessions = new Map([
    ["ses_root", { id: "ses_root", agent: "orchestrator", location: { directory: "/repo" }, time: { busy: 2 } }],
    ["ses_child", { id: "ses_child", parentID: "ses_root", agent: "builder",
      location: { directory: "/repo" }, time: { busy: 2 }, metadata: { reviewGate: "run_test" } }],
    ["ses_nested", { id: "ses_nested", parentID: "ses_child", agent: "general",
      location: { directory: "/repo" }, time: {} }],
  ]);
  const inboxes = new Map([["ses_root", [{ id: "msg_root" }]], ["ses_child", [{ id: "msg_child" }]]]);
  const saved = {
    runID: "run_test", root: "ses_root", directory: "/repo", phase: "BUILDING",
    stopFailures: [], sessions: [{ sessionID: "ses_root" }, { sessionID: "ses_child" }],
  };
  const failures = new Set();
  const api = async (method, endpoint, options = {}) => {
    calls.push({ method, endpoint, ...options });
    if (failures.has(endpoint)) throw new Error("simulated API failure");
    if (endpoint === "/api/debug/location") return [{ directory: "/repo" }, { directory: "/empty" }];
    if (endpoint === "/api/session/active") return { data: Object.fromEntries([...sessions]
      .filter(([, s]) => s.time.busy > (s.time.idle ?? 0)).map(([id]) => [id, { type: "running" }])) };
    if (endpoint.startsWith("/api/rpc/")) {
      if (options.directory === "/empty") return { output: null };
      if (endpoint.endsWith("/control")) {
        assert.equal(options.data.input.runID, saved.runID);
        const action = options.data.input.action;
        if (action === "resume" && saved.operatorStop) throw new Error("Operator stop awaits confirmation.");
        if (action === "resume" && saved.phase !== "BLOCKED") throw new Error("Only a blocked run can resume.");
        saved.phase = { interrupt: "BLOCKED", resume: "BUILDING", cancel: "CANCELLED" }[action];
        if (action !== "resume") saved.operatorStop = { id: "operator_test", action };
      }
      if (endpoint.endsWith("/confirm")) {
        assert.equal(options.data.input.operationID, saved.operatorStop.id);
        assert.equal(options.data.input.rootInboxEmpty, true);
        delete saved.operatorStop;
      }
      return { output: structuredClone(saved) };
    }
    const url = new URL(endpoint, "http://local");
    if (url.pathname === "/api/session") return {
      data: [...sessions.values()].filter(s => s.parentID === url.searchParams.get("parentID")),
      cursor: {},
    };
    const [, , , id, resource, item] = url.pathname.split("/");
    const session = sessions.get(id);
    if (!session) throw Object.assign(new Error("SessionNotFoundError"), { status: 404 });
    if (resource === "inbox") {
      if (method === "delete") {
        inboxes.set(id, (inboxes.get(id) ?? []).filter(m => m.id !== item));
        return;
      }
      return { data: structuredClone(inboxes.get(id) ?? []) };
    }
    if (resource === "interrupt") { session.time.idle = 3; return { interrupted: true }; }
    assert.equal(method, "get", "session deletion and prompt submission are forbidden");
    return { data: structuredClone(session) };
  };
  return {
    api, calls, lines, saved, failures, sessions, inboxes,
    invoke: args => run(args, { api, output: line => lines.push(line), isRepository: async () => true }),
  };
}

test("no arguments lists loaded swarms without sending a model turn or mutation", async () => {
  const f = fixture();
  assert.equal(await f.invoke(["--json"]), 0);
  const rows = JSON.parse(f.lines[0]);
  assert.equal(rows[0].runID, "run_test");
  assert.equal(rows[0].active, 2);
  assert(f.calls.every(c => c.method === "get" || c.endpoint.endsWith("/inspect")));
});

test("completed runs require --all and inspect exposes their saved operator snapshot", async () => {
  const f = fixture();
  f.saved.phase = "CANCELLED";
  await f.invoke(["list", "--json"]);
  assert.deepEqual(JSON.parse(f.lines.pop()), []);
  await f.invoke(["list", "--all", "--json"]);
  assert.equal(JSON.parse(f.lines.pop())[0].phase, "CANCELLED");
  await f.invoke(["inspect", "run_test", "--json"]);
  assert.equal(JSON.parse(f.lines.pop()).runID, "run_test");
});

for (const action of ["interrupt", "cancel"]) {
  test(`${action} stops the selected root and descendants and cancels queued input`, async () => {
    const f = fixture();
    assert.equal(await f.invoke([action, "run_test", "--json"]), 0);
    const result = JSON.parse(f.lines[0]);
    assert.equal(result.phase, action === "cancel" ? "CANCELLED" : "BLOCKED");
    assert.equal(result.ledgerConfirmed, true);
    assert.equal(result.stopped.length, 3);
    assert(result.stopped.every(s => s.stopped));
    assert([...f.inboxes.values()].every(items => items.length === 0));
    assert(f.calls.filter(c => c.method === "delete").every(c => c.endpoint.includes("/inbox/")));
    assert(!f.calls.some(c => /\/(prompt|command|synthetic)$/.test(c.endpoint)));
  });
}

test("start resumes only an existing blocked swarm and never invokes native stop", async () => {
  const f = fixture();
  f.saved.phase = "BLOCKED";
  assert.equal(await f.invoke(["start", "ses_root", "--json"]), 0);
  assert.equal(JSON.parse(f.lines[0]).phase, "BUILDING");
  assert(!f.calls.some(c => c.endpoint.includes("interrupt?") || c.method === "delete"));
  await assert.rejects(f.invoke(["resume", "ses_root"]), /Only a blocked/);
});

test("resume dispatch failures returning BLOCKED cannot report confirmation or exit zero", async () => {
  const f = fixture();
  f.saved.phase = "BLOCKED";
  const api = async (...args) => {
    const result = await f.api(...args);
    if (args[1].endsWith("/control")) {
      f.saved.phase = "BLOCKED";
      result.output.phase = "BLOCKED";
      result.output.reason = "Dispatch failed";
    }
    return result;
  };
  const lines = [];
  assert.equal(await run(["resume", "ses_root", "--json"], {
    api, output: line => lines.push(line),
  }), 2);
  assert.equal(JSON.parse(lines[0]).ledgerConfirmed, false);
  assert(!f.calls.some(c => c.endpoint.includes("interrupt?")));
});

test("an inbox-endpoint 404 is incomplete recovery, not proof that an existing session is absent", async () => {
  const f = fixture();
  f.sessions.get("ses_root").time = {};
  const api = async (...args) => {
    if (args[1] === "/api/session/ses_root/inbox")
      throw Object.assign(new Error("404 inbox endpoint unavailable"), { status: 404 });
    return f.api(...args);
  };
  const lines = [];
  assert.equal(await run(["interrupt", "ses_root", "--json"], {
    api, output: line => lines.push(line),
  }), 2);
  const result = JSON.parse(lines[0]);
  assert.equal(result.ledgerConfirmed, false);
  assert.equal(result.stopped.find(s => s.sessionID === "ses_root").stopped, false);
  assert(f.calls.some(c => c.endpoint === "/api/session/ses_root/interrupt?resume=false"),
    "still interrupt execution even if queued input cannot be checked");
  assert(!f.calls.some(c => c.endpoint.endsWith("/confirm")));
  assert(f.saved.operatorStop);
});

test("descendant pagination preserves the parent filter and rejects unrelated returned sessions", async () => {
  const f = fixture();
  const pages = [];
  const api = async (...args) => {
    const url = new URL(args[1], "http://local");
    if (url.pathname === "/api/session") {
      pages.push(url);
      if (url.searchParams.has("cursor")) return {
        data: [{ id: "ses_unrelated", parentID: "ses_elsewhere" }], cursor: {},
      };
      return { data: [structuredClone(f.sessions.get("ses_child"))], cursor: { next: "page2" } };
    }
    return f.api(...args);
  };
  await assert.rejects(run(["interrupt", "ses_root"], { api, output: () => {} }), /unrelated parent/);
  assert(pages.every(page => page.searchParams.get("parentID") === "ses_root"));
  assert(!f.calls.some(c => c.endpoint.includes("interrupt?") || c.method === "delete"));
});

test("partial stop failures are reported while other participants are still stopped", async () => {
  const f = fixture();
  f.failures.add("/api/session/ses_child/interrupt?resume=false");
  assert.equal(await f.invoke(["cancel", "ses_root", "--json"]), 2);
  const result = JSON.parse(f.lines[0]);
  assert.equal(result.ledgerConfirmed, false);
  assert.equal(result.stopped.find(s => s.sessionID === "ses_child").stopped, false);
  assert.equal(result.stopped.find(s => s.sessionID === "ses_root").stopped, true);
  assert.equal(result.stopped.find(s => s.sessionID === "ses_nested").stopped, true);
  assert(f.saved.operatorStop, "an incomplete stop must keep the run fenced");
  assert(!f.calls.some(c => c.endpoint.endsWith("/confirm")));
});

test("a failed confirmation keeps the operator lease until an explicit retry succeeds", async () => {
  const f = fixture();
  f.failures.add("/api/rpc/swarm-operator/confirm");
  assert.equal(await f.invoke(["interrupt", "ses_root", "--json"]), 2);
  assert(f.saved.operatorStop);
  await assert.rejects(f.invoke(["resume", "ses_root"]), /awaits confirmation/);
  f.failures.delete("/api/rpc/swarm-operator/confirm");
  assert.equal(await f.invoke(["interrupt", "ses_root", "--json"]), 0);
  assert.equal(f.saved.operatorStop, undefined);
});

test("native stops never affect sessions outside the selected descendant tree", async () => {
  const f = fixture();
  f.sessions.set("ses_unrelated", {
    id: "ses_unrelated", agent: "build", location: { directory: "/other" }, time: { busy: 2 },
  });
  assert.equal(await f.invoke(["cancel", "ses_root", "--json"]), 0);
  assert.equal(f.sessions.get("ses_unrelated").time.idle, undefined);
  assert(!f.calls.some(c => c.endpoint.includes("ses_unrelated/interrupt")));
});

test("native emergency interruption works without the plugin but cannot claim ledger confirmation", async () => {
  const f = fixture();
  f.failures.add("/api/rpc/swarm-operator/inspect");
  assert.equal(await f.invoke(["interrupt", "ses_root", "--json"]), 2);
  const result = JSON.parse(f.lines[0]);
  assert.equal(result.ledgerConfirmed, false);
  assert(result.stopped.every(s => s.stopped));
  assert(!f.calls.some(c => c.endpoint.endsWith("/control")));
});

test("a stale control rejection never falls back to stopping sessions from a newer run", async () => {
  const f = fixture();
  f.failures.add("/api/rpc/swarm-operator/control");
  await assert.rejects(f.invoke(["cancel", "ses_root"]), /simulated API failure/);
  assert(!f.calls.some(c => c.endpoint.includes("interrupt?") || c.method === "delete"));
});

test("cancel requires plugin confirmation rather than silently falling back to native interruption", async () => {
  const f = fixture();
  f.failures.add("/api/rpc/swarm-operator/inspect");
  await assert.rejects(f.invoke(["kill", "ses_root"]), /Cannot inspect swarm/);
  assert(!f.calls.some(c => c.endpoint.includes("interrupt?") || c.method === "delete"));
});

test("invalid or bulk mutation arguments are rejected before contacting the service", async () => {
  const f = fixture();
  for (const args of [
    ["cancel", "run_test", "--all"], ["cancel"], ["list", "run_test"],
    ["resume", "run_test", "extra"], ["list", "--timeout-seconds", "0"], ["--unknown"],
  ]) await assert.rejects(f.invoke(args));
  assert.equal(f.calls.length, 0);
  assert.equal(argumentsFor(["kill", "run_test"]).action, "cancel");
  assert.equal(argumentsFor(["--directory", "/repo", "inspect", "run_test"]).directory, "/repo");
});

test("general and every subcommand help work without a running service or target", async () => {
  for (const args of [
    ["--help"], ["-h"], ["help"], ["help", "interrupt"], ["list", "--help"],
    ["inspect", "--help"], ["resume", "-h"], ["start", "--help"],
    ["interrupt", "--help"], ["cancel", "--help"], ["kill", "--help"],
  ]) {
    const lines = [];
    assert.equal(await run(args, {
      api: () => { assert.fail("help must not contact OpenCode"); },
      output: line => lines.push(line),
    }), 0);
    assert.match(lines[0], /Usage: oc2-swarms/);
    assert.match(lines[0], /Exit codes:/);
    if (args.length > 1 && args[0] !== "help") assert.match(lines[0], /Examples:/);
  }
  await assert.rejects(run(["help", "unknown"]), /Unknown help topic/);
});
