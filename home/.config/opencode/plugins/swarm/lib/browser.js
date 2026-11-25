import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const exec = promisify(execFile);

export function browserCommand(file, platform = process.platform) {
  const url = pathToFileURL(file).href;
  if (platform === "darwin") {
    // Target a web browser, not an editor registered for .html documents.
    return ["/usr/bin/open", ["-b", "com.apple.Safari", url]];
  } else if (platform === "linux") {
    return ["xdg-open", [url]];
  } else if (platform === "win32") {
    return ["rundll32", ["url.dll,FileProtocolHandler", url]];
  } else {
    throw new Error(`Automatic browser opening is unsupported on ${platform}.`);
  }
}

export async function openReport(file, signal) {
  const [command, args] = browserCommand(file);
  await exec(command, args, { timeout: 15_000, signal });
}
