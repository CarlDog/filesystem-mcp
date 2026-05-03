import { promises as fs } from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildFixture, makeClient, mkSandbox, rmSandbox } from "./sandbox.js";

describe("FilesystemClient.mkdir", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkSandbox();
  });

  afterEach(async () => {
    await rmSandbox(root);
  });

  it("dry-run reports paths_to_create and does not touch the filesystem", async () => {
    const client = makeClient([root], { allowWrite: true });
    const target = path.join(root, "new-dir");
    const result = await client.mkdir(target);
    expect(result.dry_run).toBe(true);
    expect(result.performed).toBe(false);
    expect(result.paths_to_create).toEqual([target]);

    // Verify nothing was actually created.
    await expect(fs.lstat(target)).rejects.toThrow();
  });

  it("creates a single directory (non-recursive) when dry_run=false", async () => {
    const client = makeClient([root], { allowWrite: true });
    const target = path.join(root, "new-dir");
    const result = await client.mkdir(target, { dryRun: false });
    expect(result.performed).toBe(true);
    expect(result.paths_to_create).toEqual([target]);

    const st = await fs.lstat(target);
    expect(st.isDirectory()).toBe(true);
  });

  it("is idempotent when target already exists as a directory", async () => {
    await buildFixture(root, { existing: {} });
    const client = makeClient([root], { allowWrite: true });
    const target = path.join(root, "existing");

    const dryResult = await client.mkdir(target);
    expect(dryResult.paths_to_create).toEqual([]);

    const realResult = await client.mkdir(target, { dryRun: false });
    expect(realResult.performed).toBe(true);
    expect(realResult.paths_to_create).toEqual([]);
  });

  it("refuses when target already exists as a regular file", async () => {
    await buildFixture(root, { "a.txt": "hello" });
    const client = makeClient([root], { allowWrite: true });
    await expect(client.mkdir(path.join(root, "a.txt"))).rejects.toThrow(
      /exists and is not a directory/,
    );
  });

  it("refuses non-recursive mkdir when parent directory is missing", async () => {
    const client = makeClient([root], { allowWrite: true });
    const target = path.join(root, "missing-parent", "leaf");
    await expect(client.mkdir(target)).rejects.toThrow(
      /parent does not exist.*recursive=true/,
    );
  });

  it("recursive=true creates intermediate parents in order", async () => {
    const client = makeClient([root], { allowWrite: true });
    const target = path.join(root, "a", "b", "c");

    // Dry run reports the chain parent→leaf.
    const dryResult = await client.mkdir(target, { recursive: true });
    expect(dryResult.paths_to_create).toEqual([
      path.join(root, "a"),
      path.join(root, "a", "b"),
      path.join(root, "a", "b", "c"),
    ]);

    // Real run creates them.
    const realResult = await client.mkdir(target, {
      recursive: true,
      dryRun: false,
    });
    expect(realResult.performed).toBe(true);
    for (const p of realResult.paths_to_create) {
      const st = await fs.lstat(p);
      expect(st.isDirectory()).toBe(true);
    }
  });

  it("recursive on an existing dir is a no-op", async () => {
    await buildFixture(root, { existing: {} });
    const client = makeClient([root], { allowWrite: true });
    const result = await client.mkdir(path.join(root, "existing"), {
      recursive: true,
      dryRun: false,
    });
    expect(result.paths_to_create).toEqual([]);
  });

  it("rejects a target outside any configured root", async () => {
    const client = makeClient([root], { allowWrite: true });
    const outside = await fs.realpath(
      await fs.mkdtemp(path.join(root, "..", "outside-")),
    );
    try {
      await expect(client.mkdir(path.join(outside, "nope"))).rejects.toThrow(
        /escapes configured FS_ROOTS/,
      );
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects a target whose basename matches deny-pattern", async () => {
    const client = makeClient([root], {
      allowWrite: true,
      denyPatterns: ["*.env", "secrets-*"],
    });
    await expect(
      client.mkdir(path.join(root, "secrets-vault")),
    ).rejects.toThrow(/matches FS_DENY_FILE_PATTERNS/);
    await expect(client.mkdir(path.join(root, "config.env"))).rejects.toThrow(
      /matches FS_DENY_FILE_PATTERNS/,
    );
  });

  it("throws when allowWrite=false (defense-in-depth, even for dry-run)", async () => {
    const client = makeClient([root], { allowWrite: false });
    await expect(client.mkdir(path.join(root, "new"))).rejects.toThrow(
      /write operations are disabled/,
    );
  });
});
