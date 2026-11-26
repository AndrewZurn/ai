import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const terminal = new Set(["APPROVED", "CANCELLED"]);
const resumedPhases = new Set([
  "PLAN_REVIEW", "CLARIFYING", "BUILDING", "HANDOFF", "SELECTING", "REVIEWING",
  "REVIEW_HANDOFF", "TRIAGING", "REPORTING", "APPROVED",
]);
const clean = value => String(value ?? "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
const missing = error => error.status === 404 || /SessionNotFoundError|\b404\b/.test(error.message);
const commands = {
  list: {
    usage: "list [--all] [--json]",
    description: "List active and blocked swarms in this service's loaded checkouts.",
    details: "--all includes approved/cancelled runs. Unavailable checkouts produce exit code 2.\n" +
      "Unloaded history and other independently running services are not searched.",
    examples: ["oc2-swarms list", "oc2-swarms list --all --json"],
  },
  inspect: {
    usage: "inspect <run-or-session-id> [--directory <checkout>]",
    description: "Read a swarm's saved recovery state without starting an agent turn.",
    details: "Shows phase, participants, pending admissions, operator fences and stop errors.\n" +
      "Output is JSON; task prompts and source contents are not included.",
    examples: ["oc2-swarms inspect run_...", "oc2-swarms inspect ses_... --directory /path/to/repo"],
  },
  resume: {
    usage: "resume <run-or-session-id> [options]",
    description: "Resume an existing blocked swarm. Alias: start.",
    details: "Requires the plugin and a confirmed stop. It does not bypass plan review or budgets.\n" +
      "It cannot start a new task; enroll new work with /swarm --plan <path> in OpenCode.",
    examples: ["oc2-swarms resume run_...", "oc2-swarms start ses_... --json"],
  },
  interrupt: {
    usage: "interrupt <run-or-session-id> [options]",
    description: "Pause a swarm and stop its root session and descendants.",
    details: "Cancels queued input, including undelivered user input. History and code remain.\n" +
      "Retry interrupt after partial failure to confirm the stop before resume.\n" +
      "If the plugin is unavailable, an exact ses_... target permits a native-only\n" +
      "emergency stop. Exit code 2 means the workflow ledger remains unconfirmed.",
    examples: ["oc2-swarms interrupt run_...", "oc2-swarms interrupt ses_... --json"],
  },
  cancel: {
    usage: "cancel <run-or-session-id> [options]",
    description: "End a swarm and stop its root session and descendants. Alias: kill.",
    details: "Cancels queued input, including undelivered user input. History and code remain.\n" +
      "Does not delete sessions, kill the shared server, or silently use native-only fallback.\n" +
      "A cancelled swarm cannot resume; start a new /swarm --plan run explicitly.",
    examples: ["oc2-swarms cancel run_...", "oc2-swarms kill ses_... --json"],
  },
};
const aliases = { start: "resume", kill: "cancel" };
const flags = `Options:
  --json                    Machine-readable output
  --directory <checkout>    Target a known checkout without discovery (not list)
  --timeout-seconds <n>     Per-API timeout: >0 to 600 seconds (default: 15)
  --help, -h               Show help without contacting the service

Exit codes: 0 confirmed/readable, 1 failed or invalid, 2 incomplete/unavailable.`;
const usage = `Usage: oc2-swarms [command] [target] [options]

Commands:
  list                       List active/blocked runs (default); --all includes completed
  inspect <id>               Read recovery state without starting an agent
  resume <id>                 Continue a blocked run (alias: start)
  interrupt <id>              Pause, cancel queued input, and stop the selected session tree
  cancel <id>                 End a run without deleting history/code (alias: kill)
  help [command]             Show general or command-specific help

Use exact run_... or ses_... IDs from list. There are no bulk mutation commands.
Use "oc2-swarms <command> --help" for examples and safety details.

${flags}`;

export function helpFor(action) {
  const command = commands[action];
  return command ? `Usage: oc2-swarms ${command.usage}\n\n${command.description}\n\n` +
    `${command.details}\n\nExamples:\n${command.examples.map(example => `  ${example}`).join("\n")}\n\n${flags}`
    : usage;
}

export function argumentsFor(argv) {
  const options = { action: "list", timeout: 15_000, json: false, all: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") options.json = true;
    else if (arg === "--all") options.all = true;
    else if (["--help", "-h"].includes(arg)) options.help = true;
    else if (["--directory", "--timeout-seconds"].includes(arg)) {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}.`);
      if (arg === "--directory") options.directory = path.resolve(value);
      else {
        const seconds = Number(value);
        if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 600)
          throw new Error("Timeout must be greater than zero and at most 600 seconds.");
        options.timeout = seconds * 1000;
      }
    } else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else positional.push(arg);
  }
  if (positional[0] === "help") {
    options.help = true;
    options.helpAction = aliases[positional[1]] ?? positional[1];
    if (positional.length > 2 || (options.helpAction && !commands[options.helpAction]))
      throw new Error("Unknown help topic. Use oc2-swarms help.");
    return options;
  }
  options.action = aliases[positional[0]] ?? positional[0] ?? "list";
  if (options.help) {
    if (!commands[options.action]) throw new Error("Unknown help topic. Use oc2-swarms help.");
    options.helpAction = positional[0] ? options.action : undefined;
    return options;
  }
  options.target = positional[1];
  if (!["list", "inspect", "resume", "interrupt", "cancel"].includes(options.action) ||
    positional.length > 2 || (options.action === "list" ? options.target : !options.target))
    throw new Error(usage);
  if (options.all && options.action !== "list") throw new Error("--all is read-only; select one run.");
  if (options.directory && options.action === "list") throw new Error("--directory requires a target action.");
  return options;
}

export function transport(timeout) {
  const binary = process.env.OPENCODE_SWARMS_BIN || "opencode2";
  let service;
  return async (method, endpoint, { data, directory } = {}) => {
    service ??= execute(binary, ["service", "status"], { timeout, maxBuffer: 1024 * 1024 })
      .then(({ stdout }) => {
        if (!/^https?:\/\//.test(stdout.trim()))
          throw new Error("No running OpenCode service. Start OpenCode, then retry.");
      });
    await service;
    const args = ["api", method, endpoint, "--print-logs"];
    if (directory) args.push("--header", `x-opencode-directory:${directory}`);
    if (data !== undefined) args.push("--data", JSON.stringify(data));
    try {
      const { stdout } = await execute(binary, args, { timeout, maxBuffer: 8 * 1024 * 1024 });
      return stdout.trim() ? JSON.parse(stdout) : undefined;
    } catch (error) {
      let detail;
      try {
        const body = JSON.parse(error.stdout);
        detail = `${body.type ?? body._tag ?? "API error"}: ${body.message ?? "Request failed"}`;
      } catch {}
      throw new Error(clean(detail || error.stderr?.trim() || error.message).slice(0, 2000));
    }
  };
}

async function parallel(items, action) {
  const result = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      result[index] = await action(items[index]);
    }
  }));
  return result;
}

const rpc = (api, directory, method, input = {}) =>
  api("post", `/api/rpc/swarm-operator/${method}`, { directory, data: { input } })
    .then(result => result.output);

export async function discover(api, isRepository) {
  const [locations, active] = await Promise.all([
    api("get", "/api/debug/location"),
    api("get", "/api/session/active"),
  ]);
  const live = await parallel(Object.keys(active.data), async sessionID => {
    try { return (await api("get", `/api/session/${encodeURIComponent(sessionID)}`)).data; }
    catch { return null; }
  });
  const roots = new Map();
  for (let session of live.filter(session => session &&
    (session.agent === "orchestrator" || session.metadata?.reviewGate))) {
    const visited = new Set();
    while (session.parentID && !visited.has(session.id)) {
      visited.add(session.id);
      session = (await api("get", `/api/session/${encodeURIComponent(session.parentID)}`)).data;
    }
    roots.set(session.location.directory, session);
  }
  const directories = [...new Set([
    ...locations.map(location => location.directory), ...roots.keys(),
  ])];
  const rows = await parallel(directories, async directory => {
    if (!roots.has(directory) && !await isRepository(directory)) return null;
    try {
      const snapshot = await rpc(api, directory, "inspect");
      return snapshot ? { ...snapshot, active: snapshot.sessions.filter(s => active.data[s.sessionID]).length } : null;
    } catch (error) {
      return {
        runID: null, root: roots.get(directory)?.id ?? null,
        directory, phase: "UNAVAILABLE", error: error.message,
      };
    }
  });
  return rows.filter(Boolean);
}

async function targetRun(options, api, isRepository) {
  const sessionTarget = options.target.startsWith("ses_");
  let directory = options.directory;
  if (!directory && sessionTarget)
    directory = (await api("get", `/api/session/${encodeURIComponent(options.target)}`)).data.location.directory;
  if (directory) {
    let snapshot;
    try { snapshot = await rpc(api, directory, "inspect"); }
    catch (error) {
      if (sessionTarget && options.action === "interrupt")
        return { root: options.target, directory, phase: "UNAVAILABLE", error: error.message };
      throw new Error(`Cannot inspect swarm: ${error.message}. Emergency stop: oc2-swarms interrupt <root-session-id>`);
    }
    if (snapshot && (snapshot.runID === options.target ||
      snapshot.sessions.some(session => session.sessionID === options.target))) return snapshot;
    throw new Error("Target is not the current swarm in that checkout. Run oc2-swarms list --all.");
  }
  const matches = (await discover(api, isRepository)).filter(row => row.runID === options.target);
  if (matches.length !== 1) throw new Error("Run not found or ambiguous. Use list --all or --directory <checkout>.");
  return matches[0];
}

async function descendants(api, root) {
  const sessions = [root];
  const visited = new Set(sessions);
  for (let i = 0; i < sessions.length; i++) {
    let cursor;
    do {
      const query = new URLSearchParams({
        parentID: sessions[i], limit: "100", ...(cursor ? { cursor } : {}),
      });
      const page = await api("get", `/api/session?${query}`);
      for (const child of page.data) {
        if (child.parentID !== sessions[i])
          throw new Error("Session pagination returned an unrelated parent; refusing to stop any sessions.");
        if (!visited.has(child.id)) {
          visited.add(child.id);
          sessions.push(child.id);
        }
      }
      if (sessions.length > 1000) throw new Error("More than 1000 descendants; refusing an unbounded operation.");
      const next = page.cursor?.next;
      if (next && next === cursor) throw new Error("Session pagination did not advance.");
      cursor = next;
    } while (cursor);
  }
  return sessions;
}

async function stopSessions(api, root) {
  const sessions = await descendants(api, root);
  return parallel(sessions, async sessionID => {
    const base = `/api/session/${encodeURIComponent(sessionID)}`;
    try {
      await api("get", base);
    } catch (error) {
      const absent = missing(error);
      return { sessionID, stopped: absent, error: absent ? undefined : error.message };
    }
    const errors = [];
    let cancelledInputs = 0;
    try {
      const inbox = await api("get", `${base}/inbox`);
      for (const item of inbox.data) {
        await api("delete", `${base}/inbox/${encodeURIComponent(item.id)}`);
        cancelledInputs++;
      }
    } catch (error) { errors.push(`Inbox cancellation: ${error.message}`); }
    try { await api("post", `${base}/interrupt?resume=false`); }
    catch (error) { errors.push(`Interruption: ${error.message}`); }
    try {
      const [session, remaining] = await Promise.all([
        api("get", base), api("get", `${base}/inbox`),
      ]);
      if (session.data.time.busy > (session.data.time.idle ?? 0) || remaining.data.length)
        errors.push("Execution or queued input is still present; retry interrupt.");
    } catch (error) { errors.push(`Stop verification: ${error.message}`); }
    return { sessionID, stopped: errors.length === 0, cancelledInputs,
      ...(errors.length ? { error: errors.join("; ") } : {}) };
  });
}

export async function run(argv, {
  api,
  output = console.log,
  isRepository = async directory => {
    try { await fs.stat(path.join(directory, ".git")); return true; }
    catch { return false; }
  },
} = {}) {
  const options = argumentsFor(argv);
  if (options.help) { output(helpFor(options.helpAction)); return 0; }
  api ??= transport(options.timeout);
  if (options.action === "list") {
    const rows = (await discover(api, isRepository)).filter(row => options.all || !terminal.has(row.phase));
    if (options.json) output(JSON.stringify(rows, null, 2));
    else {
      output("RUN\tROOT SESSION\tSTATE\tACTIVE\tDIRECTORY");
      for (const row of rows)
        output([row.runID ?? "unavailable", row.root ?? "unknown", row.phase, row.active ?? "?", row.directory]
          .map(clean).join("\t"));
      for (const row of rows.filter(row => row.error))
        output(`Cannot inspect ${clean(row.directory)}: ${clean(row.error)}`);
      if (!rows.length) output("No active or blocked swarms in the running service's loaded checkouts.");
    }
    return rows.some(row => row.phase === "UNAVAILABLE") ? 2 : 0;
  }
  let snapshot = await targetRun(options, api, isRepository);
  if (options.action === "inspect") { output(JSON.stringify(snapshot, null, 2)); return 0; }
  const input = { runID: snapshot.runID, action: options.action };
  if (snapshot.runID) snapshot = await rpc(api, snapshot.directory, "control", input);
  const stopped = options.action === "resume" ? [] : await stopSessions(api, snapshot.root);
  // Recheck the ledger after native interruptions have settled root/child turns.
  // This is a second bounded confirmation, not a polling loop.
  let confirmationError;
  if (snapshot.runID && options.action !== "resume" && !stopped.some(session => !session.stopped)) {
    try {
      snapshot = await rpc(api, snapshot.directory, "confirm", {
        runID: snapshot.runID, operationID: snapshot.operatorStop.id, rootInboxEmpty: true,
      });
    }
    catch (error) { confirmationError = error.message; }
  }
  const failures = stopped.filter(session => !session.stopped);
  const resumed = options.action !== "resume" || resumedPhases.has(snapshot.phase);
  const confirmed = resumed && Boolean(snapshot.runID) && !snapshot.operatorStop && !confirmationError &&
    !failures.length && !(snapshot.stopFailures?.length);
  const result = {
    ...snapshot, stopped, ledgerConfirmed: confirmed,
    ...(confirmationError ? { confirmationError } : {}),
  };
  if (options.json) output(JSON.stringify(result, null, 2));
  else {
    output(`${options.action}: ${clean(snapshot.runID ?? snapshot.root)} — ${clean(snapshot.phase)}`);
    if (stopped.length) output(`Stopped ${stopped.length - failures.length}/${stopped.length} sessions; ` +
      `cancelled ${stopped.reduce((sum, session) => sum + (session.cancelledInputs ?? 0), 0)} queued inputs.`);
    if (!confirmed) output("Recovery is incomplete. Inspect --json for errors and retry when the service responds.");
  }
  return confirmed ? 0 : 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
    console.error(clean(error.message));
    process.exitCode = 1;
  });
}
