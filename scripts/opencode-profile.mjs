import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const profileRoot = path.join(repoRoot, "config/opencode");
const configDir = path.join(os.homedir(), ".config/opencode");
const configFile = path.join(configDir, "opencode.jsonc");
const stateFile = path.join(configDir, "oc2-profile.json");
const namePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readJson(file) {
  const value = JSON.parse(fs.readFileSync(file, "utf8"), (key, value) => {
    assert(!["__proto__", "constructor", "prototype"].includes(key),
      `Unsupported key ${key}: ${file}`);
    return value;
  });
  assert(object(value), `Expected a JSON object: ${file}`);
  return value;
}

function merge(base, overlay) {
  const result = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    result[key] = object(value) && object(result[key]) ? merge(result[key], value) : value;
  }
  return result;
}

function profiles() {
  return fs.readdirSync(path.join(profileRoot, "profiles"))
    .filter(file => file.endsWith(".json") && namePattern.test(file.slice(0, -5)))
    .map(file => file.slice(0, -5)).sort();
}

function render(name) {
  assert(namePattern.test(name) && profiles().includes(name),
    `Unknown profile: ${name}. Use oc2 --list-profiles.`);
  const profile = readJson(path.join(profileRoot, "profiles", `${name}.json`));
  for (const key of Object.keys(profile)) {
    assert(["description", "allowed_providers", "launcher", "config"].includes(key),
      `Unknown profile field: ${key}`);
  }
  const allowed = profile.allowed_providers;
  assert(Array.isArray(allowed) && allowed.length > 0 &&
    allowed.every(id => typeof id === "string" && /^[a-z0-9][a-z0-9-]*$/.test(id)) &&
    new Set(allowed).size === allowed.length && object(profile.config),
    "Profiles need a non-empty, unique allowed_providers list and a config object.");
  const launcher = profile.launcher ?? {};
  assert(object(launcher) && Object.keys(launcher).every(key => key === "ca_file") &&
    (launcher.ca_file === undefined || (typeof launcher.ca_file === "string" &&
      path.isAbsolute(launcher.ca_file) && !/[\r\n]/.test(launcher.ca_file))),
    "launcher only accepts an absolute ca_file path.");
  const config = merge(readJson(path.join(profileRoot, "common.json")), profile.config);
  const validateModel = (model, label) => {
    assert(typeof model === "string" && /^[^/#\s]+\/[^#\s]+(?:#[^#\s]+)?$/.test(model) &&
      allowed.includes(model.split("/")[0]), `${label} must select a model from allowed_providers.`);
  };
  validateModel(config.model, "model");
  for (const name of ["build", "plan", "orchestrator", "builder",
    "adversarial-reviewer", "test-engineer", "specification-reviewer", "ui-design-reviewer"]) {
    assert(object(config.agents?.[name]) && config.agents[name].model,
      `Missing model for agents.${name}`);
  }
  for (const kind of ["agents", "commands"]) {
    assert(config[kind] === undefined || object(config[kind]), `${kind} must be an object.`);
    for (const [id, entry] of Object.entries(config[kind] ?? {})) {
      assert(object(entry), `${kind}.${id} must be an object.`);
      if (entry.model !== undefined) validateModel(entry.model, `${kind}.${id}.model`);
    }
  }
  if (config.experimental?.image_generate?.model !== undefined) {
    validateModel(config.experimental.image_generate.model, "experimental.image_generate.model");
  }
  assert(config.policies === undefined || (Array.isArray(config.policies) &&
    config.policies.every(rule => object(rule) && typeof rule.action === "string" &&
      typeof rule.resource === "string" && ["allow", "deny"].includes(rule.effect))),
    "policies must be an array of action/resource/effect rules.");
  // Always append this boundary after profile rules. Profiles cannot override it.
  config.policies = [
    ...(config.policies ?? []),
    { action: "provider.use", resource: "*", effect: "deny" },
    ...allowed.map(resource => ({ action: "provider.use", resource, effect: "allow" })),
  ];
  const content = `${JSON.stringify(config, null, 2)}\n`;
  const config_sha256 = createHash("sha256").update(content).digest("hex");
  const state = { version: 1, profile: name, config_sha256, launcher };
  return [[configFile, content], [stateFile, `${JSON.stringify(state, null, 2)}\n`]];
}

const stat = file => fs.lstatSync(file, { throwIfNoEntry: false });

function matches(file, content) {
  return stat(file)?.isFile() && fs.readFileSync(file, "utf8") === content;
}

function moveFile(source, destination) {
  try {
    fs.renameSync(source, destination);
    return;
  } catch (error) {
    if (error.code !== "EXDEV") throw error;
  }
  // Preserve modes, timestamps, and raw symlink targets across volumes.
  fs.cpSync(source, destination, {
    dereference: false, verbatimSymlinks: true, preserveTimestamps: true,
    force: false, errorOnExist: true,
  });
  try {
    fs.unlinkSync(source);
  } catch (error) {
    fs.unlinkSync(destination);
    throw error;
  }
}

function checkDirectory() {
  const xdg = process.env.XDG_CONFIG_HOME;
  assert(!xdg || path.resolve(xdg) === path.dirname(configDir),
    "oc2 manages ~/.config/opencode. Unset XDG_CONFIG_HOME before setup or launch.");
  assert(!stat(configDir)?.isSymbolicLink(), "The OpenCode config directory must not be a symlink.");
}

function setup(name) {
  checkDirectory();
  const outputs = render(name); // Validate all inputs before changing files.
  const legacyFile = path.join(configDir, "opencode.json");
  const files = [...outputs, [legacyFile]].map(([file, content]) => ({ file, content }));
  fs.mkdirSync(configDir, { recursive: true });
  const lock = path.join(configDir, ".oc2-setup.lock");
  fs.mkdirSync(lock); // Fail rather than overlap two setup transactions.
  try {
    if (outputs.every(([file, content]) => matches(file, content)) && !stat(legacyFile)) {
      console.log(`Profile ${name} is already configured.`);
      return;
    }
    for (const entry of files.filter(entry => entry.content !== undefined)) {
      const temp = `${entry.file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, entry.content, { mode: 0o600, flag: "wx" });
      entry.temp = temp;
    }
    const root = path.join(repoRoot, ".link-backups");
    fs.mkdirSync(root, { recursive: true });
    const backupDir = fs.mkdtempSync(path.join(root, "opencode-profile-"));
    for (const entry of files) {
      if (!stat(entry.file)) continue;
      assert(!stat(entry.file).isDirectory(), `Refusing to replace directory: ${entry.file}`);
      const backup = path.join(backupDir, path.basename(entry.file));
      moveFile(entry.file, backup);
      entry.backup = backup;
    }
    for (const entry of files.filter(entry => entry.temp)) {
      fs.renameSync(entry.temp, entry.file);
      entry.installed = true;
    }
    console.log(`Configured profile: ${name}`);
    console.log(`Backups: ${backupDir}`);
    console.log("No sign-in, download, or service restart was performed.");
  } catch (error) {
    for (const entry of files.toReversed()) {
      if (entry.installed) fs.unlinkSync(entry.file);
      if (entry.backup) moveFile(entry.backup, entry.file);
    }
    throw error;
  } finally {
    for (const { temp } of files) if (temp && stat(temp)) fs.unlinkSync(temp);
    fs.rmdirSync(lock);
  }
}

function savedProfile() {
  checkDirectory();
  assert(stat(stateFile)?.isFile(), "No saved profile. Run oc2 --setup <profile> first.");
  const saved = readJson(stateFile);
  assert(render(saved.profile ?? "").every(([file, content]) => matches(file, content)) &&
    !stat(path.join(configDir, "opencode.json")),
    `Profile settings changed. Run oc2 --setup ${saved.profile} again.`);
  return saved;
}

try {
  const [command, name, ...extra] = process.argv.slice(2);
  assert(!extra.length && (command === "--setup" || name === undefined),
    "Usage: oc2 --setup [profile] | --list-profiles | --profile-status");
  switch (command) {
    case "--setup": {
      assert(!name || !process.env.OPENCODE_PROFILE || name === process.env.OPENCODE_PROFILE,
        "Profile argument and OPENCODE_PROFILE disagree.");
      const selected = name || process.env.OPENCODE_PROFILE;
      assert(selected, "Specify a profile or set OPENCODE_PROFILE.");
      setup(selected);
      break;
    }
    case "--list-profiles":
      for (const name of profiles()) {
        const profile = readJson(path.join(profileRoot, "profiles", `${name}.json`));
        console.log(`${name}\t${profile.description ?? ""}`);
      }
      break;
    case "--profile-status": {
      const saved = savedProfile();
      console.log(`Profile: ${saved.profile}\nConfig: ${configFile}\nStatus: current`);
      break;
    }
    case "--ca-file":
      process.stdout.write(savedProfile().launcher.ca_file ?? "");
      break;
    default:
      throw new Error("Unknown profile command.");
  }
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
}
