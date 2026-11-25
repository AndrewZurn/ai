import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc2-profile-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  const configDir = path.join(home, ".config/opencode");
  for (const dir of ["scripts", "home/.local/bin", "config/opencode/profiles",
    "home/.config/opencode/plugins/swarm/lib"]) {
    fs.mkdirSync(path.join(repo, dir), { recursive: true });
  }
  for (const file of [
    "scripts/opencode-profile.mjs",
    "home/.local/bin/oc2",
    "config/opencode/common.json",
    "config/opencode/profiles/personal.json",
    "config/opencode/profiles/work.json",
    "home/.config/opencode/plugins/swarm/lib/workflow.js",
    "home/.config/opencode/plugins/swarm/workflow.json",
  ]) fs.copyFileSync(path.join(repoRoot, file), path.join(repo, file));
  fs.mkdirSync(configDir, { recursive: true });
  const bin = path.join(home, ".local/bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.symlinkSync(path.join(repo, "home/.local/bin/oc2"), path.join(bin, "oc2"));
  fs.writeFileSync(path.join(bin, "opencode2"), [
    "#!/usr/bin/env node",
    "console.log(JSON.stringify({args: process.argv.slice(2), ca: process.env.NODE_EXTRA_CA_CERTS ?? null}));",
    "process.exit(17);",
  ].join("\n"), { mode: 0o755 });
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` };
  for (const key of ["XDG_CONFIG_HOME", "OPENCODE_PROFILE", "NODE_EXTRA_CA_CERTS"]) delete env[key];
  const run = (args, overrides = {}) => spawnSync("bash", [path.join(bin, "oc2"), ...args], {
    env: { ...env, ...overrides }, encoding: "utf8",
  });
  const config = () => JSON.parse(fs.readFileSync(path.join(configDir, "opencode.jsonc"), "utf8"));
  const profileFile = name => path.join(repo, "config/opencode/profiles", `${name}.json`);
  const edit = (file, update) => {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    update(value);
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  };
  return { root, repo, home, configDir, run, config, profileFile, edit };
}

function success(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function crossDeviceRenames(f, failInstall = false) {
  const preload = path.join(f.root, "cross-device.mjs");
  fs.writeFileSync(preload, `
    import fs from "node:fs";
    const rename = fs.renameSync;
    fs.renameSync = (source, destination) => {
      if (${failInstall} && source.endsWith(".tmp") && destination.endsWith("oc2-profile.json")) {
        throw Object.assign(new Error("simulated install failure"), { code: "EACCES" });
      }
      if (source.includes(".link-backups") || destination.includes(".link-backups")) {
        throw Object.assign(new Error("simulated cross-device rename"), { code: "EXDEV" });
      }
      return rename(source, destination);
    };
  `);
  return { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` };
}

test("discovers added profiles without changes to scripts", t => {
  const f = fixture(t);
  fs.copyFileSync(f.profileFile("personal"), f.profileFile("travel"));
  const result = f.run(["--list-profiles"]);
  success(result);
  assert.match(result.stdout, /personal\t/);
  assert.match(result.stdout, /work\t/);
  assert.match(result.stdout, /travel\t/);
  success(f.run(["--setup", "travel"]));
  assert.match(f.run(["--profile-status"]).stdout, /Profile: travel/);
});

test("work setup merges config and appends a closed provider allowlist", t => {
  const f = fixture(t);
  f.edit(path.join(f.repo, "config/opencode/common.json"), common => {
    common.agents = { build: { steps: 20 } };
    common.watcher = { ignore: ["common"] };
  });
  f.edit(f.profileFile("work"), profile => {
    profile.config.watcher = { ignore: ["work"] };
    profile.config.policies.push({ action: "provider.use", resource: "*", effect: "allow" });
  });
  success(f.run(["--setup", "work"]));
  const config = f.config();
  assert.equal(config.default_agent, "plan");
  assert.equal(config.update, "notify");
  assert.equal(config.agents.build.steps, 20);
  assert.match(config.agents.build.model, /^openai\//);
  const source = JSON.parse(fs.readFileSync(f.profileFile("work"), "utf8")).config;
  for (const agent of ["build", "plan", "orchestrator", "builder",
    "adversarial-reviewer", "test-engineer", "specification-reviewer", "ui-design-reviewer"]) {
    assert.equal(config.agents[agent].model, source.agents[agent].model);
  }
  assert.deepEqual(config.watcher.ignore, ["work"]);
  assert.deepEqual(config.policies.slice(-3), [
    { action: "provider.use", resource: "*", effect: "deny" },
    { action: "provider.use", resource: "openai", effect: "allow" },
    { action: "provider.use", resource: "github-copilot", effect: "allow" },
  ]);
  assert(config.policies.some(rule => rule.action === "plugin.use" && rule.effect === "deny" &&
    rule.resource === "*go-usage*"));
  assert.equal(config.providers, undefined);
  assert.deepEqual(Object.keys(config.mcp.servers).sort(), ["datadog", "lucid", "playwright", "synk", "ui-browser"]);
  for (const name of ["synk", "lucid", "datadog"]) {
    assert.equal(config.mcp.servers[name].disabled, true);
  }
  assert.equal(fs.statSync(path.join(f.configDir, "opencode.jsonc")).mode & 0o777, 0o600);
});

test("personal defaults use Go with local providers, without work settings", t => {
  const f = fixture(t);
  success(f.run(["--setup", "personal"]));
  const config = f.config();
  assert.equal(config.model, "opencode-go/glm-5.3");
  assert.equal(config.agents.build.model, "opencode-go/glm-5.3-flash");
  assert.match(config.agents["adversarial-reviewer"].model, /^opencode-go\//);
  assert.equal(config.agents.builder.model, config.agents.build.model);
  for (const agent of ["orchestrator", "test-engineer", "specification-reviewer", "ui-design-reviewer"]) {
    assert.match(config.agents[agent].model, /^opencode-go\//);
  }
  assert(config.providers.mlx);
  assert.deepEqual(Object.keys(config.mcp.servers), ["playwright", "ui-browser"]);
  const result = f.run(["path with spaces", "--flag", "*.ts"], { OPENCODE_PROFILE: "work" });
  assert.equal(result.status, 17);
  assert.deepEqual(JSON.parse(result.stdout), {
    args: ["path with spaces", "--flag", "*.ts"], ca: null,
  });
});

for (const profile of ["personal", "work"]) {
  test(`${profile} enables independent browser servers for parallel reviewers`, t => {
    const f = fixture(t);
    success(f.run(["--setup", profile]));
    assert.deepEqual(f.config().mcp.servers.playwright, {
      type: "local",
      command: ["npx", "-y", "@playwright/mcp@latest"],
      disabled: false,
    });
    assert.deepEqual(f.config().mcp.servers["ui-browser"], {
      type: "local", command: ["npx", "-y", "@playwright/mcp@latest", "--isolated"], disabled: false,
    });
  });
}

test("environment selects setup only; conflicting inputs fail", t => {
  const f = fixture(t);
  success(f.run(["--setup"], { OPENCODE_PROFILE: "work" }));
  assert.match(f.run(["--profile-status"]).stdout, /Profile: work/);
  const result = f.run(["--setup", "personal"], { OPENCODE_PROFILE: "work" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /disagree/);
  assert.match(f.run(["--profile-status"]).stdout, /Profile: work/);
});

test("setup backs up the existing link, legacy JSON, and keeps shared source intact", t => {
  const f = fixture(t);
  const shared = path.join(f.repo, "shared.jsonc");
  fs.writeFileSync(shared, '{"original": true}\n');
  fs.symlinkSync(shared, path.join(f.configDir, "opencode.jsonc"));
  fs.writeFileSync(path.join(f.configDir, "opencode.json"), '{"legacy": true}\n');
  fs.writeFileSync(path.join(f.configDir, "service.json"), '{"untouched": true}\n');
  success(f.run(["--setup", "work"]));
  assert.equal(fs.lstatSync(path.join(f.configDir, "opencode.jsonc")).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(shared, "utf8"), '{"original": true}\n');
  assert.equal(fs.readFileSync(path.join(f.configDir, "service.json"), "utf8"), '{"untouched": true}\n');
  assert.equal(fs.existsSync(path.join(f.configDir, "opencode.json")), false);
  const backups = fs.readdirSync(path.join(f.repo, ".link-backups"));
  assert.equal(backups.length, 1);
  const backup = path.join(f.repo, ".link-backups", backups[0]);
  assert.equal(fs.readlinkSync(path.join(backup, "opencode.jsonc")), shared);
  assert.equal(fs.readFileSync(path.join(backup, "opencode.json"), "utf8"), '{"legacy": true}\n');
  const before = fs.statSync(path.join(f.configDir, "opencode.jsonc")).mtimeMs;
  success(f.run(["--setup", "work"]));
  assert.equal(fs.statSync(path.join(f.configDir, "opencode.jsonc")).mtimeMs, before);
  assert.equal(fs.readdirSync(path.join(f.repo, ".link-backups")).length, 1);
});

test("invalid setup inputs do not change an existing configuration", t => {
  const f = fixture(t);
  success(f.run(["--setup", "work"]));
  const before = fs.readFileSync(path.join(f.configDir, "opencode.jsonc"), "utf8");
  for (const args of [["--setup"], ["--setup", "../work"], ["--setup", "missing"],
    ["--setup", "work", "extra"], ["--list-profiles", "extra"]]) {
    assert.equal(f.run(args).status, 1);
    assert.equal(fs.readFileSync(path.join(f.configDir, "opencode.jsonc"), "utf8"), before);
  }
  f.edit(f.profileFile("work"), profile => { profile.config.agents.build.model = "opencode-go/glm-5.3"; });
  assert.equal(f.run(["--setup", "work"]).status, 1);
  assert.equal(fs.readFileSync(path.join(f.configDir, "opencode.jsonc"), "utf8"), before);
});

test("rejects wildcard allowlists, malformed rules, and prototype keys", t => {
  for (const change of [
    p => { p.allowed_providers = ["*"]; },
    p => { p.config.policies = [{ action: "provider.use", resource: "*", effect: "ask" }]; },
    p => { p.config.agents.plan.model = "{env:MODEL}"; },
    p => { p.launcher = { ca_file: "relative.pem" }; },
  ]) {
    const f = fixture(t);
    f.edit(f.profileFile("work"), change);
    assert.equal(f.run(["--setup", "work"]).status, 1);
    assert.equal(fs.existsSync(path.join(f.configDir, "opencode.jsonc")), false);
  }
  const f = fixture(t);
  fs.writeFileSync(f.profileFile("work"), '{"__proto__": {}, "config": {}}');
  assert.match(f.run(["--setup", "work"]).stderr, /Unsupported key/);
  fs.copyFileSync(path.join(repoRoot, "config/opencode/profiles/work.json"), f.profileFile("work"));
  f.edit(f.profileFile("work"), p => { p.config.nested = [{ constructor: "unsafe" }]; });
  assert.match(f.run(["--setup", "work"]).stderr, /Unsupported key constructor/);
});

test("rejects launch before setup, stale sources, and edited generated config", t => {
  const f = fixture(t);
  assert.match(f.run([]).stderr, /No saved profile/);
  success(f.run(["--setup", "work"]));
  fs.appendFileSync(path.join(f.configDir, "opencode.jsonc"), " ");
  assert.match(f.run([]).stderr, /settings changed/);
  success(f.run(["--setup", "work"]));
  f.edit(f.profileFile("work"), p => { p.config.update = "disable"; });
  assert.match(f.run(["--profile-status"]).stderr, /settings changed/);
  success(f.run(["--setup", "work"]));
});

test("restores the original config if replacing another output fails", t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.configDir, "opencode.jsonc"), '{"original": true}\n');
  fs.mkdirSync(path.join(f.configDir, "oc2-profile.json"));
  assert.equal(f.run(["--setup", "work"]).status, 1);
  assert.equal(fs.readFileSync(path.join(f.configDir, "opencode.jsonc"), "utf8"), '{"original": true}\n');
  assert.equal(fs.existsSync(path.join(f.configDir, ".oc2-setup.lock")), false);
  assert.equal(fs.readdirSync(f.configDir).some(file => file.endsWith(".tmp")), false);
});

test("backs up regular files and symlinks across filesystems without following links", t => {
  const f = fixture(t);
  const shared = path.join(f.repo, "shared.jsonc");
  fs.writeFileSync(shared, '{"original": true}\n');
  fs.symlinkSync(shared, path.join(f.configDir, "opencode.jsonc"));
  fs.writeFileSync(path.join(f.configDir, "opencode.json"), '{"legacy": true}\n', { mode: 0o600 });
  success(f.run(["--setup", "work"], crossDeviceRenames(f)));
  const backupRoot = path.join(f.repo, ".link-backups");
  const backup = path.join(backupRoot, fs.readdirSync(backupRoot)[0]);
  assert.equal(fs.readlinkSync(path.join(backup, "opencode.jsonc")), shared);
  assert.equal(fs.readFileSync(shared, "utf8"), '{"original": true}\n');
  assert.equal(fs.readFileSync(path.join(backup, "opencode.json"), "utf8"), '{"legacy": true}\n');
  assert.equal(fs.statSync(path.join(backup, "opencode.json")).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(path.join(f.configDir, "opencode.json")), false);
});

test("restores cross-filesystem backups when a later replacement fails", t => {
  const f = fixture(t);
  const original = path.join(f.configDir, "opencode.jsonc");
  fs.writeFileSync(original, '{"original": true}\n', { mode: 0o600 });
  fs.mkdirSync(path.join(f.configDir, "oc2-profile.json"));
  assert.equal(f.run(["--setup", "work"], crossDeviceRenames(f)).status, 1);
  assert.equal(fs.readFileSync(original, "utf8"), '{"original": true}\n');
  assert.equal(fs.statSync(original).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(path.join(f.configDir, ".oc2-setup.lock")), false);
});

test("restores both saved outputs when installation fails after replacing the config", t => {
  const f = fixture(t);
  success(f.run(["--setup", "personal"]));
  const files = ["opencode.jsonc", "oc2-profile.json"];
  const before = files.map(file => fs.readFileSync(path.join(f.configDir, file), "utf8"));
  const result = f.run(["--setup", "work"], crossDeviceRenames(f, true));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /simulated install failure/);
  assert.deepEqual(files.map(file => fs.readFileSync(path.join(f.configDir, file), "utf8")), before);
  assert.equal(fs.existsSync(path.join(f.configDir, ".oc2-setup.lock")), false);
  assert.equal(fs.readdirSync(f.configDir).some(file => file.endsWith(".tmp")), false);
  assert.match(f.run(["--profile-status"]).stdout, /Profile: personal/);
});

test("refuses legacy XDG isolation and overlapping setup", t => {
  const f = fixture(t);
  assert.match(f.run(["--setup", "work"], {
    XDG_CONFIG_HOME: path.join(f.home, ".config/opencode-v2"),
  }).stderr, /Unset XDG_CONFIG_HOME/);
  fs.mkdirSync(path.join(f.configDir, ".oc2-setup.lock"));
  assert.equal(f.run(["--setup", "work"]).status, 1);
  assert.equal(fs.existsSync(path.join(f.configDir, "opencode.jsonc")), false);
});

test("work CA is optional and explicit caller settings are preserved", t => {
  const f = fixture(t);
  const ca = path.join(f.root, "corporate.pem");
  // Empty test file is enough for the launcher's existence check.
  fs.writeFileSync(ca, "");
  f.edit(f.profileFile("work"), p => { p.launcher.ca_file = ca; });
  success(f.run(["--setup", "work"]));
  const result = f.run(["run", "test"]);
  assert.equal(result.status, 17);
  assert.equal(JSON.parse(result.stdout).ca, ca);
  const callerCa = path.join(f.root, "caller.pem");
  fs.writeFileSync(callerCa, "");
  const custom = f.run([], { NODE_EXTRA_CA_CERTS: callerCa });
  assert.equal(JSON.parse(custom.stdout).ca, callerCa);
  const empty = f.run([], { NODE_EXTRA_CA_CERTS: "" });
  assert.equal(JSON.parse(empty.stdout).ca, "");
  fs.unlinkSync(ca);
  assert.equal(JSON.parse(f.run([]).stdout).ca, null);
});

test("shared reviewer definition does not fix a provider or change its permissions", () => {
  const reviewer = fs.readFileSync(path.join(repoRoot,
    "home/.config/opencode/agents/adversarial-reviewer.md"), "utf8");
  assert.doesNotMatch(reviewer.split("---")[1], /^model:/m);
  assert.match(reviewer, /action: edit\s+resource: "\*"\s+effect: deny/);
  assert.match(reviewer, /action: shell\s+resource: "\*"\s+effect: deny/);
});

test("swarm agents are model-neutral and every profile requires their models", t => {
  for (const name of ["orchestrator", "builder", "test-engineer", "specification-reviewer", "ui-design-reviewer"]) {
    const agent = fs.readFileSync(path.join(repoRoot,
      `home/.config/opencode/agents/${name}.md`), "utf8");
    assert.doesNotMatch(agent.split("---")[1], /^model:/m);
    const f = fixture(t);
    f.edit(f.profileFile("work"), profile => { delete profile.config.agents[name]; });
    assert.match(f.run(["--setup", "work"]).stderr, new RegExp(`Missing model for agents.${name}`));
  }
});

test("adding a configured specialist requires a profile model without changing the validator", t => {
  const f = fixture(t);
  const workflow = path.join(f.repo, "home/.config/opencode/plugins/swarm/workflow.json");
  f.edit(workflow, value => {
    value.reviewers["security-reviewer"] = {
      required: false,
      description: "Review authentication and authorization changes.",
    };
  });
  assert.match(f.run(["--setup", "work"]).stderr, /Missing model for agents.security-reviewer/);
  f.edit(f.profileFile("work"), profile => {
    profile.config.agents["security-reviewer"] = { model: profile.config.agents["test-engineer"].model };
  });
  success(f.run(["--setup", "work"]));
  assert(f.config().agents["security-reviewer"].model.startsWith("openai/"));
  f.edit(workflow, value => { value.reviewers["security-reviewer"].after = []; });
  assert.match(f.run(["--setup", "work"]).stderr, /Invalid swarm workflow/);
});

test("UI reviewers require independent Playwright MCP evidence without granting write or install access", () => {
  for (const name of ["test-engineer", "ui-design-reviewer"]) {
    const agent = fs.readFileSync(path.join(repoRoot,
      `home/.config/opencode/agents/${name}.md`), "utf8");
    assert.match(agent, /Playwright MCP/);
    assert.match(agent, /non-web UI/i);
    assert.match(agent, /blocked/);
    assert.match(agent, /action: edit\s+resource: "\*"\s+effect: deny/);
    assert.match(agent, /action: subagent\s+resource: "\*"\s+effect: deny/);
    assert.match(agent, name === "test-engineer"
      ? /action: "ui_browser_\*"\s+resource: "\*"\s+effect: deny/
      : /action: "playwright_\*"\s+resource: "\*"\s+effect: deny/);
    assert.match(agent, name === "test-engineer"
      ? /action: shell\s+resource: "\*"\s+effect: ask/
      : /action: shell\s+resource: "\*"\s+effect: deny/);
  }
});
