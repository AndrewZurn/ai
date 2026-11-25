import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { isReportArtifact } from "./artifact-paths.js";

const exec = promisify(execFile);

async function git(directory, args) {
  return (await exec("git", args, {
    cwd: directory, encoding: "buffer", maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  })).stdout;
}

export async function repository(directory) {
  return (await git(directory, ["rev-parse", "--show-toplevel"])).toString().trim();
}

export async function trackedFiles(directory) {
  return new Set((await git(directory, ["ls-files", "--cached", "-z"]))
    .toString().split("\0").filter(Boolean));
}

// Hash contents, not only the diff: staged, unstaged, and non-ignored
// untracked files all matter. Never follow a symlink outside the checkout.
export async function snapshot(directory, artifacts = []) {
  const hash = createHash("sha256");
  const add = value => {
    const bytes = Buffer.from(value);
    hash.update(`${bytes.length}:`);
    hash.update(bytes);
  };
  const index = await git(directory, ["ls-files", "--stage", "-z"]);
  add(index);
  const tracked = new Set(index.toString().split("\0").filter(Boolean)
    .map(entry => entry.slice(entry.indexOf("\t") + 1)));
  const provenance = new Map(artifacts.filter(entry => isReportArtifact(entry.file))
    .map(entry => [entry.file, entry]));
  const files = [...new Set((await git(directory,
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]))
    .toString().split("\0").filter(Boolean))].sort();
  const reviewed = [];
  // HEAD is optional for a repository with no commits.
  add(await git(directory, ["rev-parse", "--verify", "--quiet", "HEAD"])
    .catch(error => {
      if (error.code === 1) return Buffer.from("unborn");
      throw error;
    }));
  for (const file of files) {
    if (path.isAbsolute(file) || file.split("/").includes("..")) {
      throw new Error(`Unsafe repository path: ${file}`);
    }
    // lstat on the final component alone would follow replaced parent links.
    let parent = directory;
    for (const component of file.split("/").slice(0, -1)) {
      parent = path.join(parent, component);
      const stat = await fs.lstat(parent).catch(error => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (stat?.isSymbolicLink() || (stat && !stat.isDirectory())) {
        throw new Error(`Unsafe parent directory: ${file}`);
      }
    }
    const full = path.join(directory, file);
    const stat = await fs.lstat(full).catch(error => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    const owned = !tracked.has(file) && provenance.get(file);
    let content;
    if (owned && stat?.isFile() && (stat.mode & 0o777) === 0o600) {
      const identityMatches = owned.identity && owned.identity.dev === stat.dev &&
        owned.identity.ino === stat.ino && owned.identity.birthtime === stat.birthtimeMs;
      if (["temporary", "report"].includes(owned.kind) && identityMatches) {
        content = await fs.readFile(full);
        if (createHash("sha256").update(content).digest("hex") === owned.sha256) continue;
      }
    }
    reviewed.push(file);
    add(file);
    if (!stat) {
      add("deleted");
    } else if (stat.isSymbolicLink()) {
      add("symlink");
      add(await fs.readlink(full));
    } else if (stat.isFile()) {
      add(`file:${stat.mode & 0o777}`);
      add(content ?? await fs.readFile(full));
    } else {
      throw new Error(`Cannot fingerprint directory/submodule or special file: ${file}`);
    }
  }
  return { digest: hash.digest("hex"), files: reviewed };
}
