import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { requireThat } from "./protocol.js";

export function planCommand(text) {
  const match = text.trim().match(/^--plan(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s"']+))(?:\s+([\s\S]*))?$/);
  requireThat(match, 'Usage: /swarm --plan <path> [task and acceptance criteria]. Quote paths with spaces.');
  return { plan: match[1] ?? match[2] ?? match[3], task: match[4]?.trim() || "Implement the referenced plan." };
}

export async function readPlan(directory, reference, authorize) {
  const source = path.resolve(directory, reference);
  const file = await fs.realpath(source);
  await authorize(file);
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    requireThat(stat.isFile() && stat.size <= 1024 * 1024, "Plan must be a text file no larger than 1 MiB.");
    const bytes = await handle.readFile();
    requireThat(bytes.length <= 1024 * 1024, "Plan must be no larger than 1 MiB.");
    let content;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("Plan must contain valid UTF-8 text.");
    }
    requireThat(content.trim() && !content.includes("\0"),
      "Plan must contain nonempty text no larger than 1 MiB.");
    return { reference: source, path: file, content, sha256: createHash("sha256").update(bytes).digest("hex") };
  } finally {
    await handle.close();
  }
}
