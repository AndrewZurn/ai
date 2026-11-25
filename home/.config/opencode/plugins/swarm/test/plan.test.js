import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { planCommand, readPlan } from "../lib/plan.js";

test("the command requires an explicit plan and supports quoted paths and optional task details", () => {
  for (const input of ["", "Implement feature", "--plan", '--plan ""', '--plan "not closed']) {
    assert.throws(() => planCommand(input), /Usage:/);
  }
  assert.deepEqual(planCommand("--plan docs/plan.md"), {
    plan: "docs/plan.md", task: "Implement the referenced plan.",
  });
  assert.deepEqual(planCommand('--plan "docs/my plan.md" Implement the feature\nKeep compatibility.'), {
    plan: "docs/my plan.md", task: "Implement the feature\nKeep compatibility.",
  });
  assert.deepEqual(planCommand("--plan='/absolute/my plan.md' Task details"), {
    plan: "/absolute/my plan.md", task: "Task details",
  });
});

test("plan loading authorizes and pins the complete file, and rejects missing/non-text/oversized plans", async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "swarm-plan-test-")));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "my plan.md");
  const content = "# Plan\nKeep compatibility and add regression tests.\n";
  await fs.writeFile(file, content);
  const authorized = [];
  const plan = await readPlan(directory, "my plan.md", async value => { authorized.push(value); });
  assert.deepEqual(authorized, [file]);
  assert.deepEqual(plan, { reference: file, path: file, content,
    sha256: createHash("sha256").update(content).digest("hex") });
  await assert.rejects(readPlan(directory, file, async () => { throw new Error("read denied"); }), /read denied/);
  await assert.rejects(readPlan(directory, "missing.md", async () => {}), { code: "ENOENT" });
  await assert.rejects(readPlan(directory, ".", async () => {}), /text file/);
  for (const invalid of ["   ", "\0binary", "x".repeat(1024 * 1024 + 1)]) {
    await fs.writeFile(file, invalid);
    await assert.rejects(readPlan(directory, file, async () => {}), /text|1 MiB/);
  }
});

test("plan integrity hashes raw bytes and rejects lossy UTF-8 decoding", async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "swarm-plan-bytes-test-")));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "external-plan.md");
  for (const invalid of [Buffer.from([0x50, 0xff]), Buffer.from([0x50, 0xfe])]) {
    await fs.writeFile(file, invalid);
    await assert.rejects(readPlan(directory, file, async () => {}), /valid UTF-8/);
  }
  await fs.writeFile(file, "Plan");
  const plain = await readPlan(directory, file, async () => {});
  const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("Plan")]);
  await fs.writeFile(file, withBom);
  const bom = await readPlan(directory, file, async () => {});
  assert.equal(bom.content, plain.content, "decoding can normalize a valid UTF-8 byte-order mark");
  assert.notEqual(bom.sha256, plain.sha256, "byte changes must still invalidate the recorded plan");
  assert.equal(bom.sha256, createHash("sha256").update(withBom).digest("hex"));
});
