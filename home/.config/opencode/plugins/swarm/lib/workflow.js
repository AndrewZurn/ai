import fs from "node:fs";

export const workflowFile = new URL("../workflow.json", import.meta.url);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);

export function validateWorkflow(value) {
  const fail = message => { throw new Error(`Invalid swarm workflow: ${message}`); };
  if (!object(value) || value.version !== 1 ||
    Object.keys(value).some(key => !["version", "reviewers"].includes(key)) ||
    !object(value.reviewers)) fail("expected version 1 and reviewers.");
  const entries = Object.entries(value.reviewers);
  if (!entries.some(([, entry]) => entry?.required === true)) fail("at least one required reviewer is needed.");
  for (const [role, entry] of entries) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(role) ||
      ["builder", "orchestrator", "build", "plan", "constructor", "prototype"].includes(role)) {
      fail(`invalid reviewer ID ${role}.`);
    }
    if (!object(entry) || typeof entry.required !== "boolean" ||
      typeof entry.description !== "string" || !entry.description.trim() ||
      Object.keys(entry).some(key => !["required", "description"].includes(key))) {
      fail(`${role} needs required (boolean) and a nonempty description.`);
    }
  }
  return structuredClone(value);
}

// Strict JSON and no executable conditions. Read on plugin load; /reload applies
// edits for new runs. Active runs keep their persisted configuration.
export function readWorkflow(file = workflowFile) {
  return validateWorkflow(JSON.parse(fs.readFileSync(file, "utf8")));
}
