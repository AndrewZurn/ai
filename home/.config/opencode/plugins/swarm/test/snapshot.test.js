import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { repository, snapshot } from "../lib/snapshot.js";

export async function gitFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-snapshot-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q");
  await fs.writeFile(path.join(root, ".gitignore"), "ignored\n");
  await fs.writeFile(path.join(root, "code.js"), "original\n");
  git("add", ".");
  return { root, git, write: (file, text) => fs.writeFile(path.join(root, file), text) };
}

test("fingerprints staged, unstaged, untracked, deleted, and executable files", async t => {
  const f = await gitFixture(t);
  assert.equal(await repository(f.root), await fs.realpath(f.root));
  const first = await snapshot(f.root);
  await f.write("code.js", "unstaged\n");
  const unstaged = await snapshot(f.root);
  assert.notEqual(first.digest, unstaged.digest);
  f.git("add", "code.js");
  assert.notEqual(unstaged.digest, (await snapshot(f.root)).digest);
  await f.write("new.test.js", "untracked\n");
  const untracked = await snapshot(f.root);
  assert(untracked.files.includes("new.test.js"));
  await f.write("ignored", "generated output\n");
  assert.equal(untracked.digest, (await snapshot(f.root)).digest);
  await fs.chmod(path.join(f.root, "new.test.js"), 0o755);
  assert.notEqual(untracked.digest, (await snapshot(f.root)).digest);
  await fs.unlink(path.join(f.root, "code.js"));
  assert.notEqual(first.digest, (await snapshot(f.root)).digest);
});

test("symlinks are hashed as links and replaced parent links fail closed", async t => {
  const f = await gitFixture(t);
  await fs.symlink("/does/not/exist", path.join(f.root, "link"));
  assert((await snapshot(f.root)).files.includes("link"));
  await fs.mkdir(path.join(f.root, "nested"));
  await f.write("nested/file", "tracked");
  f.git("add", "nested/file");
  await fs.unlink(path.join(f.root, "nested/file"));
  await fs.rmdir(path.join(f.root, "nested"));
  await fs.symlink(os.tmpdir(), path.join(f.root, "nested"));
  await assert.rejects(snapshot(f.root), /Unsafe parent/);
});
