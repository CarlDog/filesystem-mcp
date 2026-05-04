import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  FilesystemClient,
  type FilesystemConfig,
} from "../src/clients/filesystem.js";

/**
 * Recursive fixture spec. String values become files, nested objects
 * become directories, the `__symlink` magic key creates a symlink to
 * the given target (relative to the parent dir, or absolute).
 *
 * Note: symlink creation requires elevated permissions on Windows.
 * Tests using `__symlink` should gate with `process.platform !== 'win32'`.
 */
export type FixtureSpec = {
  [name: string]: string | FixtureSpec | { __symlink: string };
};

/**
 * Create a fresh sandbox directory under `os.tmpdir()`.
 * Returns the realpath-resolved canonical path so assertions match
 * what `FilesystemClient.assertWithinRoots` produces (macOS aliases
 * `/tmp` → `/private/tmp`; Windows can do similar via 8.3 names).
 */
export async function mkSandbox(): Promise<string> {
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), "fs-mcp-"));
  return fs.realpath(raw);
}

export async function rmSandbox(root: string): Promise<void> {
  await fs.rm(root, { recursive: true, force: true });
}

/** Recursively materialize a fixture spec inside `dir`. */
export async function buildFixture(
  dir: string,
  spec: FixtureSpec,
): Promise<void> {
  for (const [name, value] of Object.entries(spec)) {
    const full = path.join(dir, name);
    if (typeof value === "string") {
      await fs.writeFile(full, value);
    } else if ("__symlink" in value) {
      await fs.symlink(value.__symlink, full);
    } else {
      await fs.mkdir(full);
      await buildFixture(full, value);
    }
  }
}

/** Convenience client factory with safe defaults; override per-test. */
export function makeClient(
  roots: string[],
  overrides: Partial<FilesystemConfig> = {},
): FilesystemClient {
  return new FilesystemClient({
    roots,
    denyPatterns: ["*.env", "*.key", "id_rsa*"],
    allowWrite: false,
    maxReadBytes: 1024 * 1024,
    maxListEntries: 1000,
    maxCopyEntries: 10_000,
    maxCopyBytes: 500 * 1024 * 1024 * 1024,
    ...overrides,
  });
}
