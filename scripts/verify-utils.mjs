import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

export const root = resolve(import.meta.dirname, "..");

export function source(path) {
  return readFileSync(resolve(root, path), "utf8");
}

export function requireText(path, ...needles) {
  const contents = source(path);
  for (const needle of needles) {
    if (!contents.includes(needle)) {
      throw new Error(`${path} is missing required integration text: ${needle}`);
    }
  }
}

export function run(cwd, args) {
  const result = spawnSync("npm", args, {
    cwd: resolve(root, cwd),
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    process.stderr.write((result.stdout ?? "").slice(-12_000));
    process.stderr.write((result.stderr ?? "").slice(-12_000));
    throw result.error ?? new Error(`npm ${args.join(" ")} failed with ${result.status}`);
  }
}
